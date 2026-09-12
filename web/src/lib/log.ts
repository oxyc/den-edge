// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): read whole, and written a
// row at a time with compare-and-set. The TV writes it whenever the library changes. What den-edge last said is kept
// in this browser (`localVault.ts`), so a return visit starts from it and asks only for what changed since.

import { hkdf } from './crypto';
import { libraryVault, type Vault } from './localVault';
import {
  believe,
  compareStamps,
  deriveKeys,
  mergeEpisode,
  mergeSettings,
  mergeTitle,
  newest,
  open,
  rowName,
  seal,
  ZERO_STAMP,
  type EpisodeRow,
  type LibraryKeys,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
} from './wire';
import { trackerEvent } from './trackerEvents';
import { ensureSyncPolicy } from './syncLoader';

interface Entry {
  seq: number;
  row: Row;
}

interface Page {
  generation?: string;
  entries: { k: string; seq: number; v: string }[];
  head: number;
  more: boolean;
}

interface Batch {
  applied: { k: string; seq: number }[];
  conflicts: { k: string; seq: number; v: string | null }[];
}

/** What a return visit starts from: the rows as den-edge last gave them, and where in its log that was. */
interface Snapshot {
  generation?: string;
  head: number;
  entries: [name: string, seq: number, row: Row][];
}

/** Under what `LibraryLog.keep` holds the log itself; a new format takes a new name, so an old copy is never misread. */
const SNAPSHOT = 'log.v1';

/** Conflict rounds per write: another device writing the same row every time is not a thing a person does. */
const ROUNDS = 3;

const utf8 = new TextEncoder();

export class LibraryLog {
  /** Each row as last read or written, by the name its key is the HMAC of. */
  private readonly entries = new Map<string, Entry>();
  /** Each row exactly as den-edge last gave it, without this browser's unsent edits: what the next visit starts from. */
  private readonly acknowledged = new Map<string, Entry>();
  /** `acknowledged` changed since it was last kept. */
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  private head = 0;
  private generation?: string;
  private recoveryRows?: Row[];
  /** The TV reset the library key: this log is deleted, its id retired, and this browser's key reaches nothing. */
  moved = false;
  /** Opened from this browser's copy without asking den-edge: `refresh` brings it up to date. */
  fromCache = false;

  private constructor(
    private readonly keys: LibraryKeys,
    private readonly fetchImpl: typeof fetch,
    private readonly storage?: Storage,
    private readonly local: { vault: Vault; key: CryptoKey } | null = null,
  ) {}

  /**
   * Every row in the log, or null when den-edge can't be reached. A row that doesn't open is skipped. A library
   * that moved to a new key comes back empty and `moved`. With a copy kept from an earlier visit it opens from that
   * at once, `fromCache`, and asks den-edge nothing until `refresh`.
   */
  static async open(
    libraryKey: string,
    fetchImpl: typeof fetch = fetch,
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
    vault: Vault | null = libraryVault,
  ): Promise<LibraryLog | null> {
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const log = new LibraryLog(
      await deriveKeys(raw),
      fetchImpl,
      storage,
      vault && { vault, key: await localKey(raw) },
    );
    // Loads beside the first read, and is waited for outside the per-row tampering catches: a loader failure must
    // never skip valid rows.
    const policy = ensureSyncPolicy();
    void policy.catch(() => undefined);
    const saved = await log.kept<Snapshot>(SNAPSHOT);
    if (saved) {
      await policy;
      log.generation = saved.generation;
      log.head = saved.head;
      for (const [name, seq, row] of saved.entries) {
        log.acknowledged.set(name, { seq, row });
        log.entries.set(name, { seq, row });
      }
      log.fromCache = true;
      return log.restoreJournal();
    }
    let since = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(`/lib/${log.keys.id}/changes?since=${since}&limit=1000`, {
          headers: log.headers(),
        });
      } catch {
        return null;
      }
      await policy;
      if (res.status === 404) {
        if (!(await log.stageRecovery())) return null;
        log.head = 0;
        for (const entry of log.entries.values()) entry.seq = 0;
        return log.restoreJournal();
      }
      if (res.status === 410) {
        log.moved = true;
        return log;
      }
      if (!res.ok) return null;
      const page = (await res.json()) as Page;
      if (log.generation && page.generation && log.generation !== page.generation) {
        if (!(await log.stageRecovery())) return null;
        log.generation = page.generation;
        log.head = since = 0;
        for (const entry of log.entries.values()) entry.seq = 0;
        log.acknowledged.clear();
        continue;
      }
      log.generation = page.generation;
      for (const entry of page.entries) {
        try {
          const row = believe(await open(log.keys, entry.k, entry.v));
          const previous = log.entries.get(rowName(row));
          log.entries.set(rowName(row), {
            seq: entry.seq,
            row: previous ? merge(previous.row, row) : row,
          });
          log.acknowledged.set(rowName(row), { seq: entry.seq, row });
        } catch {
          // Tampered with, or sealed under another library's key.
        }
      }
      log.head = page.entries.at(-1)?.seq ?? page.head;
      if (!page.more || page.entries.length === 0) {
        log.dirty = true;
        log.persist();
        return log.restoreJournal();
      }
      since = page.entries.at(-1)?.seq ?? page.head;
    }
  }

  rows(): Row[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  /** Incremental foreground refresh. Uses the same serialization boundary as writes. */
  async refresh(): Promise<boolean> {
    const run = this.writes.then(async () => {
      try {
        for (;;) {
          const res = await this.fetchImpl(
            `/lib/${this.keys.id}/changes?since=${this.head}&limit=1000`,
            { headers: this.headers() },
          );
          if (res.status === 410) this.moved = true;
          if (res.status === 404) {
            if (!(await this.stageRecovery())) return false;
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            this.acknowledged.clear();
            this.dirty = true;
            return true; // A first offline action must be able to create the log on reconnect.
          }
          if (!res.ok) return false;
          const page = (await res.json()) as Page;
          if (
            (this.generation && page.generation && this.generation !== page.generation) ||
            page.head < this.head
          ) {
            if (!(await this.stageRecovery())) return false;
            this.generation = page.generation;
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            this.acknowledged.clear();
            this.dirty = true;
            continue; // Reread a restored store from zero; transport sequence is not a field timestamp.
          }
          this.generation = page.generation;
          for (const entry of page.entries) {
            try {
              const row = believe(await open(this.keys, entry.k, entry.v));
              const previous = this.entries.get(rowName(row));
              if (!previous || entry.seq > previous.seq)
                this.entries.set(rowName(row), {
                  seq: entry.seq,
                  row: previous ? merge(previous.row, row) : row,
                });
              // Compared with den-edge's own copy, not `entries`: this browser's write already carries its seq there.
              if (entry.seq > (this.acknowledged.get(rowName(row))?.seq ?? 0)) {
                this.acknowledged.set(rowName(row), { seq: entry.seq, row });
                this.dirty = true;
              }
            } catch {
              /* Skip unreadable rows individually, as on initial open. */
            }
          }
          this.head = page.entries.at(-1)?.seq ?? page.head;
          if (!page.more || page.entries.length === 0) return true;
        }
      } catch {
        return false;
      }
    });
    this.writes = run.catch(() => false);
    const refreshed = await run;
    if (refreshed) {
      this.persist();
      await this.restoreJournal();
    }
    return refreshed;
  }

  /**
   * `value`, kept in this browser under `name` for the next visit. Sealed under a key the library key derives, so it
   * is no more readable here than the log is on den-edge.
   */
  async keep(name: string, value: unknown): Promise<void> {
    if (!this.local) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8.encode(name) },
      this.local.key,
      utf8.encode(JSON.stringify(value)),
    );
    const bytes = new Uint8Array(iv.length + sealed.byteLength);
    bytes.set(iv);
    bytes.set(new Uint8Array(sealed), iv.length);
    await this.local.vault.put(`${this.keys.id}:${name}`, bytes);
  }

  /** What `keep` kept under `name`; undefined when nothing was, or it doesn't open under this library's key. */
  async kept<T>(name: string): Promise<T | undefined> {
    if (!this.local) return undefined;
    try {
      const bytes = await this.local.vault.get(`${this.keys.id}:${name}`);
      if (!bytes) return undefined;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8.encode(name) },
        this.local.key,
        bytes.slice(12),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch (error) {
      console.warn(`den: the kept ${name} could not be read`, error);
      return undefined;
    }
  }

  /** Keep den-edge's rows for the next visit, in the order they changed; a failure only costs that visit a full read. */
  private persist(): void {
    if (!this.dirty || !this.local) return;
    this.dirty = false;
    const snapshot: Snapshot = {
      generation: this.generation,
      head: this.head,
      entries: [...this.acknowledged].map(([name, { seq, row }]) => [name, seq, row]),
    };
    this.saving = this.saving
      .then(() =>
        snapshot.entries.length
          ? this.keep(SNAPSHOT, snapshot)
          : this.local?.vault.remove(`${this.keys.id}:${SNAPSHOT}`),
      )
      .catch((error: unknown) => {
        this.dirty = true;
        console.warn('den: the library could not be kept for the next visit', error);
      });
  }

  title(ref: { type: string; id: number }): TitleRow | undefined {
    const row = this.entries.get(`rec:${ref.type}:${ref.id}`)?.row;
    return row?.kind === 'rec' ? row : undefined;
  }

  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined {
    const row = this.entries.get(`ep:${ref.type}:${ref.id}:${season}:${episode}`)?.row;
    return row?.kind === 'ep' ? row : undefined;
  }

  /** A group of settings: the TV's `prefs`, the user's API `keys`. */
  settings(name: string): SettingsRow | undefined {
    const row = this.entries.get(`set:${name}`)?.row;
    return row?.kind === 'set' ? row : undefined;
  }

  /** The newest stamp read, so this browser's next edit is stamped after everything it has seen. */
  newestStamp(): Stamp {
    let latest = ZERO_STAMP;
    for (const { row } of this.entries.values()) {
      const stamp = newest(row);
      if (compareStamps(stamp, latest) > 0) latest = stamp;
    }
    return latest;
  }

  /**
   * Write a row, based on the sequence last seen for it. When another device wrote it first, their row comes back:
   * ours is merged on top of it and written again. Resolves to the row as stored, or null when it couldn't be saved
   * — `moved` says when that is because the library moved to a new key.
   */
  async write(local: Row): Promise<Row | null> {
    const run = this.writes.then(() => this.writeSerial(local));
    this.writes = run.catch(() => null);
    return run;
  }

  private async writeSerial(local: Row): Promise<Row | null> {
    const seen = this.entries.get(rowName(local))?.row;
    let target = seen ? merge(seen, local) : local;
    for (let round = 0; round < ROUNDS; round++) {
      const name = rowName(target);
      const base = this.entries.get(name)?.seq ?? 0;
      const { k, v } = await seal(this.keys, target);
      let batch: Batch;
      try {
        const res = await this.fetchImpl(`/lib/${this.keys.id}/batch`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes: [{ k, base, v }] }),
        });
        if (res.status === 410) this.moved = true;
        if (!res.ok) return null;
        batch = (await res.json()) as Batch;
      } catch {
        return null;
      }
      const applied = batch.applied.find((a) => a.k === k);
      if (applied) {
        this.entries.set(name, { seq: applied.seq, row: target });
        return target;
      }
      const conflict = batch.conflicts.find((c) => c.k === k);
      if (!conflict) return null;
      if (conflict.v === null) {
        this.entries.delete(name); // what this browser remembered belongs to a log that was reset
        continue;
      }
      const theirs = believe(await open(this.keys, k, conflict.v));
      this.entries.set(name, { seq: conflict.seq, row: theirs });
      target = merge(theirs, target);
    }
    return null;
  }

  private headers(): Record<string, string> {
    return { 'x-den-library-token': this.keys.token };
  }

  /** Persist one bulk intent atomically in the browser before any request. Network chunks are resumable. */
  async writeActions(journals: SettingsRow[]): Promise<boolean> {
    if (!journals.length) return true;
    if (!this.storage || journals.some((row) => !trackerEvent(row))) return false;
    const key = this.pendingPrefix + 'bulk:' + crypto.randomUUID();
    try {
      const sealed = await Promise.all(journals.map((row) => seal(this.keys, row)));
      this.storage.setItem(key, JSON.stringify({ bulk: sealed }));
    } catch {
      return false;
    }
    for (const row of journals) this.project(trackerEvent(row)!.after);
    await this.flushRows(key, [journals, journals.map((row) => trackerEvent(row)!.after)]);
    return true; // Either on the relay or the complete intent is still durable locally.
  }

  private async stageRecovery(): Promise<boolean> {
    const rows = [...this.entries.values()]
      .filter((entry) => entry.seq > 0)
      .map((entry) => entry.row);
    if (!rows.length) return true;
    try {
      if (this.storage)
        this.storage.setItem(
          this.pendingPrefix + 'recovery:' + crypto.randomUUID(),
          JSON.stringify({
            restore: await Promise.all(rows.map((row) => seal(this.keys, row))),
          }),
        );
      const retained = new Map((this.recoveryRows ?? []).map((row) => [rowName(row), row]));
      for (const row of rows) {
        const previous = retained.get(rowName(row));
        retained.set(rowName(row), previous ? merge(previous, row) : row);
      }
      this.recoveryRows = [...retained.values()];
      return true;
    } catch {
      return false;
    } // Do not discard the old cursors until recovery work is safely retained.
  }

  private async flushRows(key: string, groups: Row[][]): Promise<boolean> {
    const run = this.writes.then(async () => {
      for (const rows of groups) {
        for (let offset = 0; offset < rows.length; offset += 32) {
          const chunk = await Promise.all(
            rows.slice(offset, offset + 32).map(async (local) => {
              const name = rowName(local),
                previous = this.entries.get(name);
              const row = previous ? merge(previous.row, local) : local;
              return { row, name, base: previous?.seq ?? 0, ...(await seal(this.keys, row)) };
            }),
          );
          const res = await this.fetchImpl(`/lib/${this.keys.id}/batch`, {
            method: 'POST',
            headers: { ...this.headers(), 'content-type': 'application/json' },
            body: JSON.stringify({ writes: chunk.map(({ k, v, base }) => ({ k, v, base })) }),
          });
          if (res.status === 410) this.moved = true;
          if (!res.ok) return false;
          const result = (await res.json()) as Batch;
          for (const entry of chunk) {
            const applied = result.applied.find(({ k }) => k === entry.k);
            if (applied) this.entries.set(entry.name, { seq: applied.seq, row: entry.row });
            else if (!(await this.writeSerial(entry.row))) return false; // CAS merge/retry without leaving the lock.
          }
        }
      }
      try {
        this.storage?.removeItem(key);
      } catch {
        /* Retain harmless replayable work. */
      }
      return true;
    });
    this.writes = run.catch(() => false);
    return run.catch(() => false);
  }

  /** The immutable journal is authoritative; its snapshot repairs an interrupted projection write. */
  async writeAction(journal: SettingsRow): Promise<Row | null> {
    const event = trackerEvent(journal);
    if (!event) return null;
    const storageKey = this.pendingPrefix + event.id;
    // Persist ciphertext before starting the network operation. Quota/privacy errors fail visibly.
    try {
      if (this.storage)
        this.storage.setItem(storageKey, JSON.stringify(await seal(this.keys, journal)));
    } catch {
      return null;
    }
    const accepted = await this.write(journal);
    if (!accepted && !this.storage) return null;
    if (accepted) {
      try {
        this.storage?.removeItem(storageKey);
      } catch {
        /* Retrying an accepted event is harmless. */
      }
    }
    if (!accepted) return this.project(event.after);
    const saved = await this.write(event.after);
    if (saved) return saved;
    return this.project(event.after);
  }

  private project(after: Row): Row {
    const name = rowName(after);
    const current = this.entries.get(name);
    const row = current ? merge(current.row, after) : after;
    this.entries.set(name, { seq: current?.seq ?? 0, row });
    return row;
  }

  private get pendingPrefix(): string {
    return `den.pendingTracker.${this.keys.id}.`;
  }

  get pendingActions(): number {
    if (!this.storage) return 0;
    let count = 0;
    for (let i = 0; i < this.storage.length; i++)
      if (this.storage.key(i)?.startsWith(this.pendingPrefix)) count++;
    return count;
  }

  private async restoreJournal(): Promise<LibraryLog> {
    // Projections are recoverable from immutable accepted events, including after server compaction.
    for (const { row } of [...this.entries.values()]) {
      const event = trackerEvent(row);
      if (event) this.project(event.after);
    }
    if (this.storage) {
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.pendingPrefix)) keys.push(key);
      }
      keys.sort(
        (a, b) =>
          Number(a.startsWith(this.pendingPrefix + 'recovery')) -
          Number(b.startsWith(this.pendingPrefix + 'recovery')),
      );
      for (const key of keys) {
        try {
          const pending = JSON.parse(this.storage.getItem(key)!) as {
            k: string;
            v: string;
            bulk?: { k: string; v: string }[];
            restore?: { k: string; v: string }[];
          };
          if (pending.restore) {
            const rows = await Promise.all(
              pending.restore.map(({ k, v }) => open(this.keys, k, v)),
            );
            for (const row of rows) this.project(row);
            if (
              await this.flushRows(key, [
                rows.filter(trackerEvent),
                rows.filter((row) => !trackerEvent(row)),
              ])
            )
              this.recoveryRows = undefined;
            continue;
          }
          if (pending.bulk) {
            const rows = await Promise.all(pending.bulk.map(({ k, v }) => open(this.keys, k, v)));
            if (
              !rows.every(
                (row): row is SettingsRow => row.kind === 'set' && trackerEvent(row) !== null,
              )
            )
              continue;
            for (const row of rows) this.project(trackerEvent(row)!.after);
            await this.flushRows(key, [rows, rows.map((row) => trackerEvent(row)!.after)]);
            continue;
          }
          const { k, v } = pending;
          const row = await open(this.keys, k, v);
          if (row.kind === 'set' && trackerEvent(row)) await this.writeAction(row);
        } catch {
          /* Keep unreadable pending data; never acknowledge or delete it. */
        }
      }
    }
    if (!this.storage && this.recoveryRows) {
      const rows = this.recoveryRows;
      if (
        await this.flushRows(this.pendingPrefix + 'recovery', [
          rows.filter(trackerEvent),
          rows.filter((row) => !trackerEvent(row)),
        ])
      )
        this.recoveryRows = undefined;
    }
    return this;
  }
}

/** The key what this browser keeps is sealed under: the library key's, and good for nothing else. */
async function localKey(libraryKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const bytes = await hkdf(libraryKey, 'den/web/local/v1', 'enc', 32);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function merge(theirs: Row, ours: Row): Row {
  if (theirs.kind === 'rec' && ours.kind === 'rec') return mergeTitle(theirs, ours);
  if (theirs.kind === 'ep' && ours.kind === 'ep') return mergeEpisode(theirs, ours);
  if (theirs.kind === 'set' && ours.kind === 'set') return mergeSettings(theirs, ours);
  return theirs;
}
