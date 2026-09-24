// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): read whole, and written a
// row at a time with compare-and-set. The TV writes it whenever the library changes. What den-edge last said is kept
// in this browser (`localVault.ts`), so a return visit starts from it and asks only for what changed since.

import { hkdf } from './crypto';
import { libraryVault, type Vault } from './localVault';
import { forgetLibraryCredential, hasLibraryCredential, useLibraryCredential } from './relayFetch';
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

/**
 * Filled in by a write: whether den-edge refused it for good (`failed`), rather than being out of reach, and whether
 * any of its rows were applied before that.
 */
interface Outcome {
  refused: boolean;
  applied?: boolean;
}

/**
 * The error codes with which den-edge refuses a write for good (library.rs `batch`, handler.rs `read_json`): sending
 * the same body again gets the same answer. A 400 or 403 with any other body did not come from den-edge's `/lib`
 * (a proxy, a relay on the way) and may pass later; a 413 is the body itself, whoever answered it.
 */
const REFUSALS: Record<number, (string | undefined)[] | 'any'> = {
  400: ['invalid_batch', 'invalid_library_id', 'bad_request'],
  403: ['forbidden'],
  413: 'any',
};

interface Batch {
  applied: { k: string; seq: number }[];
  conflicts: { k: string; seq: number; v: string | null }[];
}

/** What a return visit starts from: the rows as den-edge last gave them, and where in its log that was. */
interface Snapshot {
  generation?: string;
  head: number;
  entries: [name: string, seq: number, row: Row][];
  memberRegistered?: boolean;
}

/** One piece of work kept in this browser (`pendingPrefix`), opened: a recovery, a bulk of actions, or one action. */
interface KeptWork {
  key: string;
  rows: Row[];
  kind: 'restore' | 'bulk' | 'one';
}

/** Under what `LibraryLog.keep` holds the log itself; a new format takes a new name, so an old copy is never misread. */
const SNAPSHOT = 'log.v1';

/**
 * Under what a first read of the log keeps the pages it has read so far, so a read cut off on a slow link goes on
 * from there on the next visit instead of from the start. Never opened as the library: only `SNAPSHOT` is whole.
 */
const PARTIAL = 'log-partial.v1';

/** How long a log den-edge refused to start waits before its kept work is sent again (`refused`). */
const RECHECK_MS = 10 * 60_000;

/**
 * How long den-edge may take to start answering a request, and then between one piece of its answer and the next.
 * Refresh and writes share one queue (`writes`), so a request that never answers would otherwise hold every later
 * save and every refresh behind it until a reload. Not a limit on the whole answer: a 512 KiB page of `/changes` on
 * a slow link, still arriving, takes as long as it takes.
 */
const REQUEST_MS = 20_000;

/** Conflict rounds per write: another device writing the same row every time is not a thing a person does. */
const ROUNDS = 3;

const utf8 = new TextEncoder();

export class LibraryLog {
  /** Each row as last read or written, by the name its key is the HMAC of. */
  private readonly entries = new Map<string, Entry>();
  /**
   * Each row exactly as den-edge last gave it or applied this browser's write of it, without this browser's unsent
   * edits: what the next visit starts from.
   */
  private readonly acknowledged = new Map<string, Entry>();
  /** How many times `project` changed a row: `replay` says it changed what this browser holds by it. */
  private projected = 0;
  /** Kept work (`pendingPrefix`) being sent now, which `replay` leaves to that send. */
  private readonly flushing = new Set<string>();
  /**
   * A refresh changed what this browser holds and has not said so yet: one that read page N and failed on N+1 keeps
   * the rows of N, and the next refresh to finish reports them, where it may find nothing new of its own.
   */
  private unreported = false;
  /** `acknowledged` changed since it was last kept. */
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  private head = 0;
  private generation?: string;
  private recoveryRows?: Row[];
  private memberRegistered = false;
  private registering?: Promise<void>;
  /** The TV reset the library key: this log is deleted, its id retired, and this browser's key reaches nothing. */
  moved = false;
  /**
   * den-edge has no log for this library and will not let this browser start one (`403 new_libraries_closed`, with
   * `NEW_LIBRARIES=members`: only a device holding another library there may). Recovery is not sent again until a
   * read finds the log — the TV writing it back — or `RECHECK_MS` has passed, instead of on every refresh: one
   * browser in this state sent 101 refused batches over nearly six hours, one on each 30-second refresh while its
   * tab was visible. The occasional re-check is what notices den-edge opened to new libraries again.
   */
  refused = false;
  /** When den-edge last refused (`Date.now()`). */
  private refusedAt = 0;
  /**
   * When den-edge last refused each piece of kept work for good (`failed`), by its key: a full library, a row it will
   * not take. That piece is sent again after `RECHECK_MS`, not on every refresh, where it was refused every 30 seconds
   * for as long as the tab stayed open; the rest of the kept work is sent as before.
   */
  private readonly rejected = new Map<string, number>();
  /** Opened from this browser's copy without asking den-edge: `refresh` brings it up to date. */
  fromCache = false;

  private constructor(
    private readonly keys: LibraryKeys,
    private readonly fetchImpl: typeof fetch,
    private readonly storage?: Storage,
    private readonly local: { vault: Vault; key: CryptoKey } | null = null,
    /** A library that lives only in this browser (`openLocal`): nothing is asked of den-edge, or sent to it. */
    private readonly offline = false,
  ) {}

  /**
   * A library kept only in this browser, for someone using Den with no TV: the same rows, sealed and merged the same
   * way, kept in IndexedDB rather than on den-edge. Null where this browser keeps nothing (a private window, blocked
   * site data). Linking a TV later moves it into the TV's library (`moveTo`).
   */
  static async openLocal(
    libraryKey: string,
    vault: Vault | null = libraryVault,
    // Kept for `moveTo`, which asks den-edge once the library is being handed to a TV's.
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ): Promise<LibraryLog | null> {
    if (!vault) return null;
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const log = new LibraryLog(
      await deriveKeys(raw),
      fetchImpl,
      undefined,
      { vault, key: await localKey(raw) },
      true,
    );
    await ensureSyncPolicy();
    const saved = await log.kept<Snapshot>(SNAPSHOT);
    for (const [name, seq, row] of saved?.entries ?? []) {
      log.acknowledged.set(name, { seq, row });
      log.entries.set(name, { seq, row });
    }
    return log;
  }

  /**
   * Every row of this library written into the library `libraryKey` opens, merged with what is already there: the
   * library this browser used on its own, handed to the TV it links to. The new log, or null when it couldn't be
   * opened or written — in which case this one is left as it was.
   */
  async moveTo(libraryKey: string): Promise<LibraryLog | null> {
    await this.saving;
    const next = await LibraryLog.open(libraryKey, this.fetchImpl, this.storage);
    if (!next || next.moved) return null;
    return (await next.writeRows(this.rows())) ? next : null;
  }

  /** The rows, each merged over what the log already holds for it, written in batches. */
  async writeRows(rows: Row[]): Promise<boolean> {
    if (this.offline) {
      for (const row of rows) this.keepLocally(row);
      // Kept once it is in this browser's store, which the next `openLocal` reads.
      await this.saving;
      return true;
    }
    return this.flushRows(`den.writeRows.${crypto.randomUUID()}`, [
      rows.filter(trackerEvent),
      rows.filter((row) => !trackerEvent(row)),
    ]);
  }

  /**
   * The library ended: a library kept only here is dropped from this browser, and one on den-edge is deleted there,
   * which retires its id so a device still holding the key gets `410 library_moved`.
   */
  async forget(): Promise<boolean> {
    await this.saving;
    if (this.offline) {
      await this.local?.vault.remove(`${this.keys.id}:`);
      return true;
    }
    try {
      const res = await this.send(`/lib/${this.keys.id}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /** A library kept only here takes a write as done: merged in, and kept for the next visit. */
  private keepLocally(row: Row): Row {
    const name = rowName(row);
    const current = this.entries.get(name);
    const merged = current ? merge(current.row, row) : row;
    this.entries.set(name, { seq: 0, row: merged });
    this.acknowledged.set(name, { seq: 0, row: merged });
    this.dirty = true;
    this.persist();
    return merged;
  }

  /**
   * Every row in the log, or null when den-edge can't be reached. A row that doesn't open is skipped. A library
   * that moved to a new key comes back empty and `moved`. With a copy kept from an earlier visit it opens from that
   * at once, `fromCache`, and asks den-edge nothing until `refresh`.
   */
  static async open(
    libraryKey: string,
    // Wrapped rather than passed bare. This is kept on the instance and later called as
    // `this.fetchImpl(…)`, which makes it a METHOD call — and a browser's `fetch` throws "Illegal
    // invocation" when its `this` is anything but the window. Every write and every refresh went through
    // that, so saving failed before a request was made: nothing in the Network tab, nothing in the
    // console, just "Couldn't save that". Only `open` escaped it, by calling the local binding instead.
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
    vault: Vault | null = libraryVault,
  ): Promise<LibraryLog | null> {
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const keys = await deriveKeys(raw);
    const log = new LibraryLog(
      keys,
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
      log.memberRegistered = saved.memberRegistered ?? false;
      log.generation = saved.generation;
      log.head = saved.head;
      for (const [name, seq, row] of saved.entries) {
        log.acknowledged.set(name, { seq, row });
        log.entries.set(name, { seq, row });
      }
      // Shown before den-edge is asked anything: an unanswered request kept the kept library off the screen. A
      // membership not yet registered is registered beside it, and claimed once den-edge has it; `refresh`, which
      // follows at once, sends the work kept here.
      if (log.memberRegistered) useLibraryCredential(keys);
      else
        void log.registerMember().then(() => {
          if (log.memberRegistered && !log.refused) useLibraryCredential(keys);
        });
      log.fromCache = true;
      log.projectJournal();
      // Unsent work is drawn too, without sending it: a reload while den-edge is out of reach showed none of it.
      await log.projectKept();
      return log;
    }
    // Register before exposing the proof to relayed requests.
    await log.registerMember();
    useLibraryCredential(keys);
    let since = 0;
    const partial = await log.kept<Snapshot>(PARTIAL);
    if (partial) {
      log.generation = partial.generation;
      log.head = since = partial.head;
      for (const [name, seq, row] of partial.entries) {
        log.acknowledged.set(name, { seq, row });
        log.entries.set(name, { seq, row });
      }
    }
    for (;;) {
      let res: Response;
      try {
        res = await log.send(`/lib/${log.keys.id}/changes?since=${since}&limit=1000`, {
          headers: log.headers(),
        });
      } catch {
        return null;
      }
      await policy;
      if (res.status === 404) {
        if (!(await log.stageRecovery())) return null;
        log.forgetPartial();
        log.memberRegistered = false;
        log.head = 0;
        for (const entry of log.entries.values()) entry.seq = 0;
        return log.restoreJournal();
      }
      if (res.status === 410) {
        log.forgetPartial();
        log.moved = true;
        return log;
      }
      if (!res.ok) return null;
      let page: Page;
      try {
        page = (await res.json()) as Page;
      } catch {
        return null;
      }
      if (log.generation && page.generation && log.generation !== page.generation) {
        if (!(await log.stageRecovery())) return null;
        log.memberRegistered = false;
        await log.registerMember();
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
        log.forgetPartial();
        return log.restoreJournal();
      }
      log.keepPartial();
      since = page.entries.at(-1)?.seq ?? page.head;
    }
  }

  rows(): Row[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  /**
   * Incremental foreground refresh. Uses the same serialization boundary as writes. True only when it changed what
   * this browser holds: a row arrived, the log was reset, or kept work reached den-edge. A poll that finds nothing
   * new is false, so what is built from the library is not rebuilt on every 30-second refresh.
   */
  async refresh(): Promise<boolean> {
    // Nothing else writes a library kept only here.
    if (this.offline) return false;
    // Null when den-edge couldn't be read (a page, or the rest of them); `unreported` keeps what the pages read did.
    const run = this.writes.then(async (): Promise<true | null> => {
      try {
        for (;;) {
          const res = await this.send(
            `/lib/${this.keys.id}/changes?since=${this.head}&limit=1000`,
            { headers: this.headers() },
          );
          if (res.status === 410) this.moved = true;
          if (res.status === 404) {
            // Only the first 404 has rows den-edge acknowledged to put back; an empty relay answers it every time.
            const staged = [...this.entries.values()].some((entry) => entry.seq > 0);
            if (!(await this.stageRecovery())) return null;
            this.memberRegistered = false;
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            this.acknowledged.clear();
            this.dirty = true;
            if (staged) this.unreported = true;
            return true; // A first offline action must be able to create the log on reconnect: `replay` sends it.
          }
          if (!res.ok) return null;
          // The log is here again (or always was): a refused start is over, and the membership stands again.
          if (this.refused || !hasLibraryCredential()) {
            this.refused = false;
            // Register before exposing the proof to relayed requests.
            await this.registerMember();
            useLibraryCredential(this.keys);
          }
          const page = (await res.json()) as Page;
          if (
            (this.generation && page.generation && this.generation !== page.generation) ||
            page.head < this.head
          ) {
            if (!(await this.stageRecovery())) return null;
            this.memberRegistered = false;
            await this.registerMember();
            this.generation = page.generation;
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            this.acknowledged.clear();
            this.dirty = true;
            this.unreported = true;
            continue; // Reread a restored store from zero; transport sequence is not a field timestamp.
          }
          this.generation = page.generation;
          for (const entry of page.entries) {
            try {
              const row = believe(await open(this.keys, entry.k, entry.v));
              const previous = this.entries.get(rowName(row));
              if (!previous || entry.seq > previous.seq) {
                this.entries.set(rowName(row), {
                  seq: entry.seq,
                  row: previous ? merge(previous.row, row) : row,
                });
                this.unreported = true;
              }
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
        return null;
      }
    });
    this.writes = run.catch(() => null);
    if ((await run) === null) return false;
    const changed = this.unreported;
    this.unreported = false;
    this.persist();
    // Rows that arrived may carry actions to project; with none, the projections already stand.
    if (changed) this.projectJournal();
    return (await this.replay()) || changed;
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
    const snapshot = this.snapshot();
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

  private snapshot(): Snapshot {
    return {
      generation: this.generation,
      head: this.head,
      memberRegistered: this.memberRegistered,
      entries: [...this.acknowledged].map(([name, { seq, row }]) => [name, seq, row]),
    };
  }

  /** The pages a first read has read so far (`PARTIAL`); a failure only costs the next visit those pages. */
  private keepPartial(): void {
    if (!this.local) return;
    const snapshot = this.snapshot();
    this.saving = this.saving.then(() => this.keep(PARTIAL, snapshot)).catch(() => undefined);
  }

  private forgetPartial(): void {
    const local = this.local;
    if (!local) return;
    this.saving = this.saving
      .then(() => local.vault.remove(`${this.keys.id}:${PARTIAL}`))
      .catch(() => undefined);
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
  async write(local: Row, outcome?: Outcome): Promise<Row | null> {
    const run = this.writes.then(() => this.writeSerial(local, outcome));
    this.writes = run.catch(() => null);
    return run;
  }

  private async writeSerial(local: Row, outcome?: Outcome): Promise<Row | null> {
    if (this.offline) return this.keepLocally(local);
    const seen = this.entries.get(rowName(local))?.row;
    let target = seen ? merge(seen, local) : local;
    for (let round = 0; round < ROUNDS; round++) {
      const name = rowName(target);
      const base = this.entries.get(name)?.seq ?? 0;
      const { k, v } = await seal(this.keys, target);
      let batch: Batch;
      try {
        const res = await this.send(`/lib/${this.keys.id}/batch`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes: [{ k, base, v }] }),
        });
        if (!res.ok) {
          await this.failed(res, outcome);
          return null;
        }
        batch = (await res.json()) as Batch;
      } catch {
        return null;
      }
      const applied = batch.applied.find((a) => a.k === k);
      if (applied) {
        this.acknowledge(name, applied.seq, target);
        if (outcome) outcome.applied = true;
        await this.registerMember();
        return target;
      }
      const conflict = batch.conflicts.find((c) => c.k === k);
      if (!conflict) return null;
      if (conflict.v === null) {
        // What this browser remembered belongs to a log that was reset.
        this.entries.delete(name);
        this.acknowledged.delete(name);
        continue;
      }
      const theirs = believe(await open(this.keys, k, conflict.v));
      this.entries.set(name, { seq: conflict.seq, row: theirs });
      target = merge(theirs, target);
    }
    return null;
  }

  /**
   * A write den-edge answered with an error. `410`: the library `moved`. `403 new_libraries_closed`: den-edge will
   * not start this library — `refused`, and this browser stops claiming a membership of it. With no log there,
   * `library::is_member` refuses the proof, so every relayed write carrying it (`/metadata/title`) was a 401. One of
   * `REFUSALS` refuses the write itself, and sending it again gets the same answer: `outcome.refused`. Anything else
   * may pass.
   */
  private async failed(res: Response, outcome?: Outcome): Promise<void> {
    if (res.status === 410) {
      this.moved = true;
      return;
    }
    const refusals = REFUSALS[res.status];
    if (!refusals) return;
    const code = await errorCode(res);
    if (res.status === 403 && code === 'new_libraries_closed') {
      this.refused = true;
      this.refusedAt = Date.now();
      forgetLibraryCredential();
      return;
    }
    if (refusals !== 'any' && !refusals.includes(code)) return;
    if (outcome) outcome.refused = true;
    console.warn(`den: den-edge refused a library write (${res.status} ${code ?? ''})`);
  }

  /**
   * A request to den-edge that gives up when it has not started answering after `REQUEST_MS`, or when its body then
   * stops arriving for as long. The body is read through here, so a stall fails the read even where aborting the
   * request would not end it.
   */
  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timedOut = () => new DOMException('den-edge stopped answering', 'TimeoutError');
    const deadline = setTimeout(() => controller.abort(timedOut()), REQUEST_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(path, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(deadline);
    }
    if (!res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        let stall: ReturnType<typeof setTimeout> | undefined;
        try {
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              stall = setTimeout(() => reject(timedOut()), REQUEST_MS);
            }),
          ]);
          if (next.done) stream.close();
          else stream.enqueue(next.value);
        } catch (error) {
          controller.abort(error);
          void reader.cancel(error).catch(() => undefined);
          stream.error(error);
        } finally {
          clearTimeout(stall);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  private headers(): Record<string, string> {
    return { 'x-den-library-token': this.keys.token };
  }

  /** Register this browser's membership, once at a time: a cached open starts it while `refresh` may ask too. */
  private registerMember(): Promise<void> {
    if (this.memberRegistered || this.offline) return Promise.resolve();
    return (this.registering ??= this.putMember().finally(() => (this.registering = undefined)));
  }

  private async putMember(): Promise<void> {
    try {
      const res = await this.send(`/lib/${this.keys.id}/member`, {
        method: 'PUT',
        headers: {
          ...this.headers(),
          'x-den-library-member': `${this.keys.id}:${this.keys.member}`,
        },
      });
      if (res.ok) {
        this.memberRegistered = true;
        this.dirty = true;
        this.persist();
      }
    } catch {
      // Sync and playback remain usable; a later write/open retries registration.
    }
  }

  /** Persist one bulk intent atomically in the browser before any request. Network chunks are resumable. */
  async writeActions(journals: SettingsRow[]): Promise<boolean> {
    if (!journals.length) return true;
    if (journals.some((row) => !trackerEvent(row))) return false;
    if (this.offline) {
      for (const row of journals) {
        this.keepLocally(row);
        this.keepLocally(trackerEvent(row)!.after);
      }
      return true;
    }
    if (!this.storage) return false;
    const key = this.pendingPrefix + 'bulk:' + crypto.randomUUID();
    try {
      const sealed = await Promise.all(journals.map((row) => seal(this.keys, row)));
      this.storage.setItem(key, JSON.stringify({ bulk: sealed }));
    } catch {
      return false;
    }
    const outcome: Outcome = { refused: false };
    await this.flushRows(key, [journals, journals.map((row) => trackerEvent(row)!.after)], outcome);
    // Refused for good before any of it landed, it is not kept to be refused again: the viewer is told it wasn't
    // saved. Refused after some of it landed, the rest stays kept, as work kept from before does.
    if (outcome.refused && !outcome.applied) {
      this.discard(key);
      return false;
    }
    for (const row of journals) this.project(trackerEvent(row)!.after);
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

  /**
   * den-edge already holds exactly `row` as the row `name`, as far as this browser knows: sending it would only write
   * the same row again under a new sequence. A retried bulk resent the chunks already applied, and recovery after a
   * restore resent every row, not only what the restored log lacks.
   */
  private holds(name: string, row: Row): boolean {
    const known = this.acknowledged.get(name);
    return (
      !!known &&
      known.seq > 0 &&
      this.entries.get(name)?.seq === known.seq &&
      canonical(known.row) === canonical(row)
    );
  }

  /** den-edge applied this browser's write of `row`: it now holds exactly that, at `seq`. */
  private acknowledge(name: string, seq: number, row: Row): void {
    this.entries.set(name, { seq, row });
    this.acknowledged.set(name, { seq, row });
    this.dirty = true;
  }

  private async flushRows(
    key: string,
    groups: Row[][],
    outcome: Outcome = { refused: false },
  ): Promise<boolean> {
    // Replayed by `replay` only once this send is over, rather than sent twice at once.
    this.flushing.add(key);
    const run = this.writes.then(async () => {
      for (const rows of groups) {
        for (let offset = 0; offset < rows.length; offset += 32) {
          const due = rows.slice(offset, offset + 32).flatMap((local) => {
            const name = rowName(local),
              previous = this.entries.get(name);
            const row = previous ? merge(previous.row, local) : local;
            return this.holds(name, row) ? [] : [{ row, name, base: previous?.seq ?? 0 }];
          });
          if (!due.length) continue;
          const chunk = await Promise.all(
            due.map(async (entry) => ({ ...entry, ...(await seal(this.keys, entry.row)) })),
          );
          const res = await this.send(`/lib/${this.keys.id}/batch`, {
            method: 'POST',
            headers: { ...this.headers(), 'content-type': 'application/json' },
            body: JSON.stringify({ writes: chunk.map(({ k, v, base }) => ({ k, v, base })) }),
          });
          if (!res.ok) {
            await this.failed(res, outcome);
            return false;
          }
          const result = (await res.json()) as Batch;
          for (const entry of chunk) {
            const applied = result.applied.find(({ k }) => k === entry.k);
            if (applied) {
              this.acknowledge(entry.name, applied.seq, entry.row);
              outcome.applied = true;
            }
            // CAS merge/retry without leaving the lock.
            else if (!(await this.writeSerial(entry.row, outcome))) return false;
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
    return run
      .catch(() => false)
      .then((sent) => {
        if (sent) this.rejected.delete(key);
        else if (outcome.refused) this.rejected.set(key, Date.now());
        return sent;
      })
      .finally(() => this.flushing.delete(key));
  }

  /** The immutable journal is authoritative; its snapshot repairs an interrupted projection write. */
  writeAction(journal: SettingsRow): Promise<Row | null> {
    return this.act(journal, true);
  }

  /**
   * `writeAction`, and the replay of one kept from before (`fresh` false). A fresh action den-edge refuses for good is
   * dropped and says it wasn't saved; a kept one stays kept, and is sent again after `RECHECK_MS`.
   */
  private async act(journal: SettingsRow, fresh: boolean): Promise<Row | null> {
    const event = trackerEvent(journal);
    if (!event) return null;
    if (this.offline) {
      this.keepLocally(journal);
      return this.keepLocally(event.after);
    }
    const storageKey = this.pendingPrefix + event.id;
    // Persist ciphertext before starting the network operation. Quota/privacy errors fail visibly.
    try {
      if (this.storage)
        this.storage.setItem(storageKey, JSON.stringify(await seal(this.keys, journal)));
    } catch {
      return null;
    }
    const outcome = { refused: false };
    this.flushing.add(storageKey);
    const accepted = await this.write(journal, outcome).finally(() =>
      this.flushing.delete(storageKey),
    );
    if (!accepted && outcome.refused) {
      if (fresh) {
        this.discard(storageKey);
        return null;
      }
      this.rejected.set(storageKey, Date.now());
    }
    if (!accepted && !this.storage) return null;
    if (accepted) {
      this.rejected.delete(storageKey);
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

  /** Drop work kept in this browser (`pendingPrefix`). */
  private discard(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      /* Replaying it is refused again, and costs only the request. */
    }
  }

  private project(after: Row): Row {
    const name = rowName(after);
    const current = this.entries.get(name);
    const row = current ? merge(current.row, after) : after;
    if (!current || canonical(current.row) !== canonical(row)) this.projected++;
    this.entries.set(name, { seq: current?.seq ?? 0, row });
    return row;
  }

  /** Each piece of work kept in this browser (`pendingPrefix`), opened; one that doesn't open is left out. */
  private async keptWork(): Promise<KeptWork[]> {
    if (!this.storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(this.pendingPrefix)) keys.push(key);
    }
    const kept: KeptWork[] = [];
    for (const key of keys) {
      try {
        const pending = JSON.parse(this.storage.getItem(key)!) as {
          k: string;
          v: string;
          bulk?: { k: string; v: string }[];
          restore?: { k: string; v: string }[];
        };
        const sealed = pending.restore ?? pending.bulk ?? [pending];
        const rows = await Promise.all(sealed.map(({ k, v }) => open(this.keys, k, v)));
        kept.push({ key, rows, kind: pending.restore ? 'restore' : pending.bulk ? 'bulk' : 'one' });
      } catch {
        /* Unreadable: `replay` keeps it, and it has nothing to show. */
      }
    }
    return kept;
  }

  /** What the work kept in this browser will do once sent, shown now: projected, and nothing sent. */
  private async projectKept(): Promise<void> {
    for (const work of await this.keptWork()) this.projectWork(work);
  }

  private projectWork({ rows, kind }: KeptWork): void {
    for (const row of rows) {
      if (kind === 'restore') this.project(row);
      else if (row.kind === 'set' && trackerEvent(row)) this.project(trackerEvent(row)!.after);
    }
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
    this.projectJournal();
    await this.replay();
    return this;
  }

  /** Projections are recoverable from immutable accepted events, including after server compaction. */
  private projectJournal(): void {
    for (const { row } of [...this.entries.values()]) {
      const event = trackerEvent(row);
      if (event) this.project(event.after);
    }
  }

  /**
   * Send the work kept in this browser (`pendingPrefix`). True when some of it reached den-edge, or when drawing it
   * changed a row here even though it could not be sent (kept by another tab, or den-edge failed the batch).
   */
  private async replay(): Promise<boolean> {
    const projected = this.projected;
    // Kept, and sent once a read finds the log again (`refresh`).
    if (this.refused && Date.now() - this.refusedAt < RECHECK_MS)
      return this.projectKeptChanged(projected);
    // Tried again: refused once more, it waits another `RECHECK_MS`.
    this.refused = false;
    const waiting = this.pendingActions;
    let delivered = false;
    const kept = (await this.keptWork()).sort(
      (a, b) => Number(a.kind === 'restore') - Number(b.kind === 'restore'),
    );
    for (const work of kept) {
      const { key, rows, kind } = work;
      // Sent by a send that ended since it was read.
      if (this.flushing.has(key) || this.storage?.getItem(key) == null) continue;
      if (Date.now() - (this.rejected.get(key) ?? 0) < RECHECK_MS) {
        this.projectWork(work);
        continue;
      }
      this.flushing.add(key);
      try {
        if (kind === 'restore') {
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
        // Only `writeAction` and `writeActions` keep work other than recovery, and only actions: anything else can
        // never be sent, and would be counted as waiting (`pendingActions`) for good.
        if (
          !rows.every((row): row is SettingsRow => row.kind === 'set' && trackerEvent(row) !== null)
        ) {
          this.discard(key);
          continue;
        }
        if (kind === 'bulk') {
          for (const row of rows) this.project(trackerEvent(row)!.after);
          await this.flushRows(key, [rows, rows.map((row) => trackerEvent(row)!.after)]);
        } else await this.act(rows[0]!, false);
      } catch {
        /* Keep unsent work; never acknowledge or delete it. */
      } finally {
        this.flushing.delete(key);
      }
    }
    if (
      !this.storage &&
      this.recoveryRows &&
      Date.now() - (this.rejected.get(this.pendingPrefix + 'recovery') ?? 0) >= RECHECK_MS
    ) {
      const rows = this.recoveryRows;
      if (
        await this.flushRows(this.pendingPrefix + 'recovery', [
          rows.filter(trackerEvent),
          rows.filter((row) => !trackerEvent(row)),
        ])
      ) {
        delivered = true;
        this.recoveryRows = undefined;
      }
    }
    return delivered || this.pendingActions < waiting || this.projected !== projected;
  }

  /** Kept work not sent now is still drawn; true when that changed a row since `projected`. */
  private async projectKeptChanged(projected: number): Promise<boolean> {
    await this.projectKept();
    return this.projected !== projected;
  }
}

/** den-edge's `error` code for a refused request, or undefined when the body is not one. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** The key what this browser keeps is sealed under: the library key's, and good for nothing else. */
async function localKey(libraryKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const bytes = await hkdf(libraryKey, 'den/web/local/v1', 'enc', 32);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `value` as JSON with every object's keys in order, so two equal rows read the same whatever built them. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function merge(theirs: Row, ours: Row): Row {
  if (theirs.kind === 'rec' && ours.kind === 'rec') return mergeTitle(theirs, ours);
  if (theirs.kind === 'ep' && ours.kind === 'ep') return mergeEpisode(theirs, ours);
  if (theirs.kind === 'set' && ours.kind === 'set') return mergeSettings(theirs, ours);
  return theirs;
}
