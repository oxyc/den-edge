// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): read whole, and written a
// row at a time with compare-and-set. The TV writes it whenever the library changes. What den-edge last said is kept
// in this browser (`localVault.ts`), so a return visit starts from it and asks only for what changed since.

import { blankEpisode, blankTitle } from './actions';
import { hkdf } from './crypto';
import { applyOps, opsFor, projectDocument, projectEpisode, touched, type Op } from './libraryV4';
import { libraryVault, type Vault } from './localVault';
import { forgetLibraryCredential, hasLibraryCredential, useLibraryCredential } from './relayFetch';
import {
  believe,
  compareStamps,
  deriveKeys,
  encodeDocument,
  fromBase64url,
  isDocument,
  mergeDocument,
  mergeEpisode,
  mergeSettings,
  mergeTitle,
  mergeV3,
  newest,
  open,
  openEntry,
  openPlaintext,
  rowName,
  seal,
  sealPlaintext,
  toBase64url,
  wellFormed,
  ZERO_STAMP,
  type DocumentRow,
  type EpisodeRow,
  type LibraryKeys,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
  type WatchRow,
} from './wire';
import { trackerEvent } from './trackerEvents';
import { ensureSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';

interface Entry {
  seq: number;
  row: Row;
}

interface RawEntry {
  k: string;
  seq: number;
  v: string;
}

interface Page {
  generation?: string;
  entries: RawEntry[];
  head: number;
  more: boolean;
}

/** `v4_form`'s answer (§10): the documents of the switch, and the rows staged as they are stored. */
interface V4Form {
  documents: { name: string; plaintext: string }[];
  keep: string[];
}

/** `v4_dry_run`'s answer (§10 step 2). */
interface DryRun {
  pass: boolean;
  abort: { reason: string; title?: string; name?: string; field?: string; coordinate?: string }[];
  pending_differences: { account: string; key: string }[];
  counts: Record<string, unknown>;
}

/** The highest library format this build reads and writes. */
export const WIRE = 4;

/**
 * What a move to another key carries (library v4 §12, `LibraryLog.moving`): the decoded rows, the plaintext of each
 * newer-format document, and the head and generation they were read at.
 */
export interface Moving {
  rows: Row[];
  kept: { name: string; plaintext: Uint8Array<ArrayBuffer> }[];
  head: number;
  generation: string | null;
}

/** Why a move did not start: a row only a newer build can carry, or a library that can't be read or moved now. */
export type MoveRefusal = 'update_required' | 'unavailable';

/** Rows a v4 library holds only after a restore or an old build's write, and the switch converts (§10). */
const legacy = (row: Row): boolean =>
  row.kind === 'rec' ||
  row.kind === 'ep' ||
  row.kind === 'wat' ||
  row.kind === 'snt' ||
  trackerEvent(row) !== null;

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

/** A ready build retains these writes and retries them after the library can be read again. */
const RETRYABLE_REFUSALS = new Set([
  'rewrite_in_progress',
  'generation_changed',
  'upgrade_required',
]);

interface Batch {
  applied: { k: string; seq: number }[];
  /** `omitted`: den-edge left the value out of a long answer (§13); it is read from `/changes`. */
  conflicts: { k: string; seq: number; v: string | null; omitted?: boolean }[];
}

/** What a return visit starts from: the rows as den-edge last gave them, and where in its log that was. */
interface Snapshot {
  generation?: string;
  head: number;
  entries: [name: string, seq: number, row: Row][];
  memberRegistered?: boolean;
  /**
   * The wire form of a library kept only here (`openLocal`), which has no den-edge to say it; absent means 2. One kept
   * on den-edge remembers den-edge's answer in localStorage instead.
   */
  wireMin?: number;
}

/** What the device switching a library to v3 says about itself (`switchWebOnly`), for den-core's `v3_form`. */
interface SwitchContext {
  performer: string;
  stamp: Stamp;
  simkl?: { account: string; credential: string; connectedAt: Stamp };
}

/**
 * One piece of work kept in this browser (`pendingPrefix`), opened: a recovery, a bulk of actions, one action, or a
 * library v4 edit kept as its den-core writes (`ops`, §11: never as encoded rows).
 */
interface KeptWork {
  key: string;
  rows: Row[];
  kind: 'restore' | 'bulk' | 'one' | 'rows' | 'ops';
  ops?: Op[];
}

/** Under what `LibraryLog.keep` holds the log itself; a new format takes a new name, so an old copy is never misread. */
const SNAPSHOT = 'log.v1';
/** The same for a library at v4, whose documents a build from before it would misread as rows. */
const SNAPSHOT_V4 = 'log.v4';

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
const REWRITE_BATCH_MAX = 200;
const REWRITE_BATCH_MAX_BYTES = 2_000_000;

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
  /** A newer generation a refused write named, which writes use until a read takes it (`adoptGeneration`). */
  private writeGeneration?: string;
  /** Highest wire minimum this browser has observed for this library; it never falls back. */
  private wireMin = 2;
  /**
   * A typed upgrade fence for the UI: the library's minimum, or a row's format or framing, is newer than this build
   * (`WIRE`), which then writes nothing (§4 *Newer rows*).
   */
  upgradeRequired: number | null = null;
  /** Rows that can't be attributed to a name (§4 *Unreadable rows*), by `k`, with why. None delivers while any is. */
  readonly unreadable = new Map<string, string>();
  /** Rows of a framing newer than this build, by `k`, kept unread. None delivers while any is. */
  readonly newerFraming = new Set<string>();
  /** Documents of a newer `format`, by name: read, never written, their targets held. */
  private readonly newerDocuments = new Set<string>();
  /** Why the switch to v4 last failed (§10 step 3); the library stays v3 and read-only meanwhile. */
  switchFailure: string | null = null;
  /** A backup from before Library v3, which this build does not convert and does not write (§10). */
  predatesV3 = false;
  /** When `compact` last tried, so a refused one is not tried on every refresh. */
  private compactedAt = 0;
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
  /** den-edge's code for the last write it refused for good (`library_full`), so a caller can say which it was. */
  refusal: string | null = null;
  /**
   * When den-edge last refused each piece of kept work for good (`failed`), by its key: a full library, a row it will
   * not take. That piece is sent again after `RECHECK_MS`, not on every refresh, where it was refused every 30 seconds
   * for as long as the tab stayed open; the rest of the kept work is sent as before.
   */
  private readonly rejected = new Map<string, number>();
  /** Opened from this browser's copy without asking den-edge: `refresh` brings it up to date. */
  fromCache = false;

  get wireMinimum(): number {
    return this.wireMin;
  }

  /** Nothing is written: the library needs a newer build, a switch to v4 failed, or it predates v3. */
  get readOnly(): boolean {
    return this.upgradeRequired !== null || this.switchFailure !== null || this.predatesV3;
  }

  /**
   * The switch to v4 is this build's to run (§10): a v3 library on den-edge, or a v4 one in which v2 or v3 rows
   * appear again (a restore, or an old build's write).
   */
  get needsV4(): boolean {
    if (this.offline || this.moved || this.upgradeRequired !== null || this.predatesV3)
      return false;
    if (this.wireMin === 3) return true;
    return this.wireMin === WIRE && [...this.acknowledged.values()].some(({ row }) => legacy(row));
  }

  private constructor(
    private readonly keys: LibraryKeys,
    private readonly fetchImpl: typeof fetch,
    private readonly storage?: Storage,
    private readonly local: { vault: Vault; key: CryptoKey } | null = null,
    /** A library that lives only in this browser (`openLocal`): nothing is asked of den-edge, or sent to it. */
    private readonly offline = false,
  ) {
    const remembered = Number(this.storage?.getItem(`den.libraryWireMin.${this.keys.id}`));
    if (Number.isInteger(remembered) && remembered >= 2) this.wireMin = remembered;
    if (this.wireMin > WIRE) this.upgradeRequired = this.wireMin;
  }

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
    log.takeForm(saved);
    for (const [name, seq, row] of saved?.entries ?? []) {
      if (!wellFormed(row)) continue;
      log.acknowledged.set(name, { seq, row });
      log.entries.set(name, { seq, row });
    }
    return log;
  }

  /**
   * The wire form a library kept only here was saved in, where it is newer than this tab's: another tab switched it to
   * v3 (`switchWebOnly`). This tab's rows are in the older form and are dropped for the saved ones, which `takeKept`
   * then reads; merging them in would put v2 episode rows beside the v3 watches made from them. True when it changed.
   */
  private takeForm(saved: Snapshot | undefined): boolean {
    const form = saved?.wireMin;
    if (!Number.isInteger(form) || form! <= this.wireMin) return false;
    this.wireMin = form!;
    if (this.wireMin > WIRE) this.upgradeRequired = this.wireMin;
    this.entries.clear();
    this.acknowledged.clear();
    return true;
  }

  /**
   * Before a library kept only here takes a write: when another tab has switched it to v3 since this one opened it,
   * take that form first, so the write is made in it (`write` converts an episode row only in v3) and not dropped
   * when it is saved (`takeKept`).
   */
  private async followKeptForm(): Promise<void> {
    if (!this.offline) return;
    const saved = await this.kept<Snapshot>(SNAPSHOT);
    if (!this.takeForm(saved)) return;
    for (const [name, , row] of saved?.entries ?? []) {
      if (!wellFormed(row)) continue;
      this.entries.set(name, { seq: 0, row });
      this.acknowledged.set(name, { seq: 0, row });
    }
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
    // v3 rows written into a v2 library would be rows its devices don't read: its watched episodes would go missing
    // there. So that library is switched to v3 first; the TV reads the new form from den-edge's wire minimum. A v2
    // library taking v2 rows, or a v3 one taking either, needs nothing (`writeRows` converts v2 episode rows).
    if (this.wireMin >= 3 && next.wireMin < 3 && !(await next.switchWebOnly())) return null;
    return (await next.writeRows(this.rows())) ? next : null;
  }

  /** The rows, each merged over what the log already holds for it, written in batches. */
  async writeRows(rows: Row[]): Promise<boolean> {
    await this.followKeptForm();
    if (this.readOnly) return false;
    if (this.wireMin >= WIRE && !this.offline) {
      // Title and episode rows (an import, or a library this browser kept) and actions are edits: den-core's writes.
      // v3 watch and receipt rows go in as the documents its switch makes of them, merged with what is there.
      const ops = rows.flatMap((row) => {
        const event = trackerEvent(row);
        if (event) return opsFor(event.before, event.after);
        return row.kind === 'rec' || row.kind === 'ep' ? opsFor(this.before(row), row) : [];
      });
      let documents: DocumentRow[];
      try {
        documents = v3Documents(rows.filter((row) => row.kind === 'wat' || row.kind === 'snt'));
      } catch (error) {
        console.warn('den: these rows could not be written into a Library v4 library', error);
        return false;
      }
      const rest = rows.filter((row) => isDocument(row) || (row.kind === 'set' && !legacy(row)));
      return (
        (await this.flushRows(`den.writeRows.${crypto.randomUUID()}`, [[...documents, ...rest]])) &&
        this.writeOps(ops)
      );
    }
    if (this.wireMin >= 3) {
      rows = rows.flatMap((row): Row[] => {
        const projected = trackerEvent(row)?.after ?? row;
        if (projected.kind !== 'ep') return [projected];
        const converted = this.v3EpisodeWrite(projected);
        return converted ? [converted] : [];
      });
    }
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

  /** Atomically replace a web-only v2 library with den-core's v3 form. */
  async switchWebOnly(context?: SwitchContext): Promise<boolean> {
    if (this.moved || this.upgradeRequired) return false;
    await ensureSyncPolicy();
    if (this.offline) return this.switchLocal(context);
    let rewrite: string | undefined;
    try {
      const opened = await this.send(`/lib/${this.keys.id}/rewrite`, {
        method: 'POST',
        headers: this.headers(),
      });
      if (!opened.ok) {
        await this.failed(opened);
        return false;
      }
      const offer = (await opened.json()) as { rewrite?: unknown; base?: unknown };
      if (typeof offer.rewrite !== 'string' || typeof offer.base !== 'number') return false;
      rewrite = offer.rewrite;
      const offeredGeneration = opened.headers.get('x-den-generation');
      // The fence fixes `base`; read through it before deriving the replacement. `entries` may also contain local,
      // unacknowledged edits, which replay after the commit instead of being mistaken for state at `base`.
      await this.refresh();
      if (!offeredGeneration || this.generation !== offeredGeneration || this.head !== offer.base) {
        await this.abortRewrite(rewrite);
        return false;
      }
      const converted = this.v3Form(offer.base, context);
      const sealed = await Promise.all(converted.map((row) => seal(this.keys, row)));
      const chunks: (typeof sealed)[] = [];
      let chunk: typeof sealed = [];
      for (const write of sealed) {
        const candidate = [...chunk, write];
        if (
          chunk.length &&
          (candidate.length > REWRITE_BATCH_MAX ||
            new TextEncoder().encode(JSON.stringify({ writes: candidate })).length >
              REWRITE_BATCH_MAX_BYTES)
        ) {
          chunks.push(chunk);
          chunk = [write];
        } else chunk = candidate;
      }
      if (chunk.length) chunks.push(chunk);
      for (const writes of chunks) {
        const staged = await this.send(`/lib/${this.keys.id}/rewrite/${rewrite}/rows`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes }),
        });
        if (!staged.ok) {
          await this.failed(staged);
          await this.abortRewrite(rewrite);
          return false;
        }
      }
      const committed = await this.send(`/lib/${this.keys.id}/rewrite/${rewrite}/commit`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ base: offer.base, wireMin: 3 }),
      });
      if (!committed.ok) {
        await this.failed(committed);
        await this.abortRewrite(rewrite);
        return false;
      }
      this.generation = committed.headers.get('x-den-generation') ?? undefined;
      this.writeGeneration = undefined;
      this.wireMin = Math.max(this.wireMin, 3);
      this.head = 0;
      this.entries.clear();
      this.acknowledged.clear();
      this.dirty = true;
      this.unreported = true;
      return await this.refresh();
    } catch {
      if (rewrite) await this.abortRewrite(rewrite);
      return false;
    }
  }

  /** den-core's v3 form of the rows this browser holds as acknowledged, at `base`. */
  private v3Form(base: number, context?: SwitchContext): Row[] {
    const now = Date.now();
    return syncPolicy<Row[]>({
      op: 'v3_form',
      rows: [...this.acknowledged.values()].map(({ row }) => row),
      now,
      context: context && {
        performer: context.performer,
        stamp: context.stamp,
        base,
        seed_bound: now,
        accounts: context.simkl
          ? [
              {
                provider: 'simkl',
                account: context.simkl.account,
                credential: context.simkl.credential,
                connected_at: context.simkl.connectedAt,
              },
            ]
          : [],
      },
    });
  }

  /**
   * `switchWebOnly` for a library kept only here: the same v3 form, replacing the copy in this browser rather than on
   * den-edge, which has none. Under the library's lock, after taking up what another tab saved (`takeKept`), so no
   * tab's rows are left out; the saved copy records the form, which every other tab then takes (`followKeptForm`).
   */
  private async switchLocal(context?: SwitchContext): Promise<boolean> {
    await this.saving;
    try {
      return await exclusive(`den.library.${this.keys.id}`, async () => {
        await this.takeKept();
        if (this.wireMin >= 3) return true;
        const converted = this.v3Form(this.head, context);
        const entries = converted.map((row): [string, number, Row] => [rowName(row), 0, row]);
        if (entries.length) await this.keep(SNAPSHOT, { ...this.snapshot(), entries, wireMin: 3 });
        else await this.local?.vault.remove(`${this.keys.id}:${SNAPSHOT}`);
        this.entries.clear();
        this.acknowledged.clear();
        for (const [name, seq, row] of entries) {
          this.entries.set(name, { seq, row });
          this.acknowledged.set(name, { seq, row });
        }
        this.wireMin = 3;
        return true;
      });
    } catch (error) {
      console.warn('den: the library kept in this browser could not be switched', error);
      return false;
    }
  }

  /**
   * Library v4 §10: convert this library to documents, checked before it is committed. Inside the fence the log is
   * read through `base`; den-core's `v4_form` converts it and `v4_dry_run` checks the conversion against shipped v3.
   * A difference in derived state aborts — nothing is written, the reason is kept (`switchFailure`) and the library
   * stays read-only until a later try passes. A difference only in pending tracker commands is logged and the switch
   * goes on. True when it committed.
   */
  async switchToV4(performer: string): Promise<boolean> {
    if (!this.needsV4) return false;
    await ensureSyncPolicy();
    const switched = await this.fenced(async (base, raw) => {
      const now = Date.now();
      const rows = await Promise.all(
        raw.map(async ({ k, seq, v }) => ({
          k,
          seq,
          bytes: k.length + v.length,
          row: await this.plainRow(k, v),
        })),
      );
      let form: V4Form;
      try {
        form = syncPolicy<V4Form>({ op: 'v4_form', rows, base, performer, now });
      } catch (error) {
        const reason = (error as Error).message.replace(/^Sync policy rejected the action: /, '');
        if (reason === 'pre_v3') {
          this.predatesV3 = true;
          console.warn('den: this library is a backup from before Library v3; it is left as it is');
        } else {
          this.switchFailure = reason;
          console.error(`den: the switch to Library v4 could not convert the library (${reason})`);
        }
        return null;
      }
      const dry = syncPolicy<DryRun>({ op: 'v4_dry_run', rows, form, now });
      console.info('den: Library v4 dry run', dry.counts);
      if (dry.pending_differences.length)
        console.warn(
          `den: Library v4 decides ${dry.pending_differences.length} tracker commands differently from v3`,
          dry.pending_differences,
        );
      if (!dry.pass) {
        const reasons = [...new Set(dry.abort.map(({ reason }) => reason))];
        this.switchFailure = reasons.join(', ');
        console.error('den: the switch to Library v4 was aborted by its dry run', dry.abort);
        return null;
      }
      const stored = new Map(raw.map((entry) => [entry.k, entry.v]));
      const writes = [
        ...(await Promise.all(
          form.documents.map(({ name, plaintext }) =>
            sealPlaintext(this.keys, name, fromBase64url(plaintext)),
          ),
        )),
        ...form.keep.map((k) => ({ k, v: stored.get(k)! })),
      ];
      return { writes, wireMin: WIRE };
    });
    if (switched) {
      this.switchFailure = null;
      console.info('den: the library switched to Library v4');
    }
    return switched;
  }

  /**
   * Library v4 §4 *Unreadable rows*: once the log is read to its head, a fenced rewrite at the same minimum that
   * stages every other row as it is stored, leaving out each unreadable one — unless it reads at `base` after all.
   * True when one was removed.
   */
  async compact(): Promise<boolean> {
    if (this.offline || this.wireMin < WIRE || !this.unreadable.size || this.readOnly) return false;
    if (Date.now() - this.compactedAt < RECHECK_MS) return false;
    this.compactedAt = Date.now();
    const removing = new Set(this.unreadable.keys());
    return this.fenced(async (_, raw) => {
      const writes: { k: string; v: string }[] = [];
      let removed = 0;
      for (const entry of raw) {
        if (removing.has(entry.k)) {
          const opened = await openEntry(this.keys, entry.k, entry.v);
          if ('unreadable' in opened) {
            console.warn(
              `den: removing the unreadable library row ${entry.k} (${opened.unreadable})`,
            );
            removed++;
            continue;
          }
          this.unreadable.delete(entry.k);
        }
        writes.push({ k: entry.k, v: entry.v });
      }
      return removed ? { writes, wireMin: this.wireMin } : null;
    });
  }

  /**
   * One fenced rewrite (v3 §9): open it, read every row through its `base`, stage what `build` makes of them, and
   * commit. `build` answering null aborts it, and nothing changes. On a commit this browser reads the new log from
   * the start; its kept work is sent again after.
   */
  private async fenced(
    build: (
      base: number,
      raw: RawEntry[],
    ) => Promise<{ writes: { k: string; v: string }[]; wireMin: number } | null>,
  ): Promise<boolean> {
    let rewrite: string | undefined;
    try {
      const opened = await this.send(`/lib/${this.keys.id}/rewrite`, {
        method: 'POST',
        headers: this.headers(),
      });
      if (!opened.ok) {
        // Another device's switch or a restore since this browser read the log: it reads the new one instead, which
        // may need no rewrite at all (`needsV4`).
        if ((await this.failed(opened)) === 'generation_changed') await this.refresh();
        return false;
      }
      const offer = (await opened.json()) as { rewrite?: unknown; base?: unknown };
      if (typeof offer.rewrite !== 'string' || typeof offer.base !== 'number') return false;
      rewrite = offer.rewrite;
      const raw = await this.readRaw(offer.base, opened.headers.get('x-den-generation'));
      const plan = raw && (await build(offer.base, raw));
      if (!plan) {
        await this.abortRewrite(rewrite);
        return false;
      }
      for (const writes of chunks(plan.writes)) {
        const staged = await this.send(`/lib/${this.keys.id}/rewrite/${rewrite}/rows`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes }),
        });
        if (!staged.ok) {
          await this.failed(staged);
          await this.abortRewrite(rewrite);
          return false;
        }
      }
      const committed = await this.send(`/lib/${this.keys.id}/rewrite/${rewrite}/commit`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ base: offer.base, wireMin: plan.wireMin }),
      });
      if (!committed.ok) {
        await this.failed(committed);
        await this.abortRewrite(rewrite);
        return false;
      }
      this.generation = committed.headers.get('x-den-generation') ?? undefined;
      this.writeGeneration = undefined;
      this.wireMin = Math.max(this.wireMin, plan.wireMin);
      this.head = 0;
      this.entries.clear();
      this.acknowledged.clear();
      this.unreadable.clear();
      this.dirty = true;
      this.unreported = true;
      await this.refresh();
      return true;
    } catch (error) {
      console.warn('den: a rewrite of the library failed', error);
      if (rewrite) await this.abortRewrite(rewrite);
      return false;
    }
  }

  /** Every row through `base` as den-edge stores it, read inside a rewrite's fence; null when it moved on. */
  private async readRaw(base: number, generation: string | null): Promise<RawEntry[] | null> {
    const rows: RawEntry[] = [];
    let since = 0;
    for (;;) {
      const res = await this.send(`/lib/${this.keys.id}/changes?since=${since}&limit=1000`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      if (generation && res.headers.get('x-den-generation') !== generation) return null;
      const page = (await res.json()) as Page;
      if (page.head !== base) return null;
      rows.push(...page.entries.filter((entry) => entry.seq <= base));
      if (!page.more || page.entries.length === 0) return rows;
      since = page.entries.at(-1)!.seq;
    }
  }

  /**
   * A stored row's plaintext as den-core's `v4_form` reads it, the same as the TV gives it: the parsed JSON of every
   * row that opens under its own name (an episode row of a film included, which den-core then drops), and null for
   * one that doesn't.
   */
  private async plainRow(k: string, v: string): Promise<unknown> {
    const opened = await openEntry(this.keys, k, v);
    if ('row' in opened) return opened.row;
    if ('unknown' in opened) return opened.unknown;
    if ('json' in opened) return opened.json;
    return null;
  }

  private async abortRewrite(rewrite: string): Promise<void> {
    try {
      await this.send(`/lib/${this.keys.id}/rewrite/${rewrite}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    } catch {
      /* The server expires abandoned stages; no live library rows were changed. */
    }
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
      // A library this tab never read (one a key reset started) is deleted under the generation den-edge gives it.
      if (!this.generation) {
        const standing = await this.standing();
        if (standing && 'head' in standing && standing.generation)
          this.generation = standing.generation;
      }
      const res = await this.send(`/lib/${this.keys.id}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /** The `{id}` in `/lib/{id}/…`: not secret, and what a `410 library_moved` names as a successor. */
  get libraryId(): string {
    return this.keys.id;
  }

  /** `x-den-library-member` for this library: a new library's first write names it (`NEW_LIBRARIES=members`). */
  get memberProof(): string {
    return `${this.keys.id}:${this.keys.member}`;
  }

  /**
   * Library v4 §12: what a move of this library to another key carries, read from den-edge to its head. Every
   * document and settings row, decoded, to be sealed again under the destination's names; a document of a newer
   * `format` as its plaintext, unchanged. A row whose name this build can't rebuild — a newer framing, or a kind it
   * doesn't know — refuses the move (`update_required`), and so do v2 or v3 rows the switch has yet to convert. An
   * unreadable row is left behind: it can't be attributed to a name, and §4 removes it anyway. `set:recovery` stays
   * too: a recovery code wraps the old key, and a reset ends it (recovery-code §9). `set:devices` keeps only `device`
   * (the one moving it): every other device is cut off, and lists itself again once it pairs back in.
   */
  async moving(device: string): Promise<Moving | { refused: MoveRefusal }> {
    if (this.offline || this.moved || this.wireMin < WIRE) return { refused: 'unavailable' };
    if (this.wireMin > WIRE || this.switchFailure !== null || this.predatesV3)
      return { refused: 'update_required' };
    await ensureSyncPolicy();
    // Writes queued before the move land in the log it reads.
    await this.writes;
    let read: { entries: RawEntry[]; head: number; generation: string | null } | null;
    try {
      read = await this.readAll();
    } catch {
      read = null;
    }
    if (!read) return { refused: 'unavailable' };
    const rows: Row[] = [];
    const kept: Moving['kept'] = [];
    for (const { k, v } of read.entries) {
      const opened = await openEntry(this.keys, k, v);
      if ('unknown' in opened || 'newerFraming' in opened) {
        console.warn(`den: the library row ${k} can't be moved by this build`);
        return { refused: 'update_required' };
      }
      if ('unreadable' in opened) {
        if (opened.json) return { refused: 'unavailable' };
        console.warn(`den: the unreadable library row ${k} stays behind (${opened.unreadable})`);
        continue;
      }
      const row = opened.row;
      if (legacy(row)) return { refused: 'unavailable' };
      if (row.kind === 'set' && row.name === 'recovery') continue;
      if (row.kind === 'set' && row.name === 'devices') {
        rows.push({
          ...row,
          values: Object.fromEntries(
            Object.entries(row.values).filter(([name]) => name.startsWith(`${device}.`)),
          ),
        });
        continue;
      }
      if (opened.newer)
        kept.push({ name: rowName(row), plaintext: (await openPlaintext(this.keys, k, v))! });
      else rows.push(row);
    }
    return { rows, kept, head: read.head, generation: read.generation };
  }

  /** Every row in the log to its head, as den-edge stores it; null when a page couldn't be read. */
  private async readAll(): Promise<{
    entries: RawEntry[];
    head: number;
    generation: string | null;
  } | null> {
    const entries: RawEntry[] = [];
    let since = 0;
    let generation: string | null = null;
    for (;;) {
      const res = await this.send(`/lib/${this.keys.id}/changes?since=${since}&limit=1000`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const page = (await res.json()) as Page;
      generation ??= page.generation ?? res.headers.get('x-den-generation');
      if ((page.generation ?? generation) !== generation) return null;
      entries.push(...page.entries);
      if (!page.more || page.entries.length === 0) return { entries, head: page.head, generation };
      since = page.entries.at(-1)!.seq;
    }
  }

  /**
   * A library to move another into (§12), by its key: nothing is read or asked of den-edge until `takeMoved`, and the
   * relayed services' credential stays the current library's.
   */
  static async destination(
    libraryKey: string,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
  ): Promise<LibraryLog> {
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    return new LibraryLog(await deriveKeys(raw), fetchImpl, storage);
  }

  /**
   * Work this browser kept for this library and hasn't sent (`pendingPrefix`), sealed again under `to`'s key and
   * kept for it: after a key reset, an edit another tab saved here reaches the library under its new key. A piece
   * that doesn't open is left where it was.
   */
  async rekeyKept(to: LibraryLog): Promise<void> {
    if (!this.storage) return;
    const reseal = (sealed: { k: string; v: string }[]) =>
      Promise.all(sealed.map(async ({ k, v }) => seal(to.keys, await open(this.keys, k, v))));
    for (const key of this.keptKeys()) {
      try {
        const pending = JSON.parse(this.storage.getItem(key)!) as {
          k?: string;
          v?: string;
          ops?: string;
          bulk?: { k: string; v: string }[];
          restore?: { k: string; v: string }[];
          rows?: { k: string; v: string }[];
        };
        let moved: unknown;
        if (pending.ops !== undefined)
          moved = { ops: await to.sealKept(await this.openKept(pending.ops)) };
        else if (pending.bulk) moved = { bulk: await reseal(pending.bulk) };
        else if (pending.restore) moved = { restore: await reseal(pending.restore) };
        else if (pending.rows) moved = { rows: await reseal(pending.rows) };
        else moved = (await reseal([{ k: pending.k!, v: pending.v! }]))[0];
        this.storage.setItem(
          to.pendingPrefix + key.slice(this.pendingPrefix.length),
          JSON.stringify(moved),
        );
        this.storage.removeItem(key);
      } catch (error) {
        console.warn('den: an unsent edit could not be moved to the new library key', error);
      }
    }
  }

  /** The storage keys of the work this browser kept for this library (`pendingPrefix`). */
  private keptKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < (this.storage?.length ?? 0); i++) {
      const key = this.storage!.key(i);
      if (key?.startsWith(this.pendingPrefix)) keys.push(key);
    }
    return keys;
  }

  /**
   * The rows of a move (§12) written here: each re-sealed under this library's name for it and merged with this
   * library's version of that name; over 256 KiB merged, this library's version stands (§11). A newer-format document
   * goes as its plaintext and never over a version already here. The first write starts the library at minimum 4,
   * named by `member` — the library it moves from. True when every row is here.
   */
  async takeMoved(moving: Moving, member: string): Promise<boolean> {
    await ensureSyncPolicy();
    const rows = new Map(moving.rows.map((row) => [rowName(row), row]));
    const kept = new Map(moving.kept.map((entry) => [entry.name, entry.plaintext]));
    for (let round = 0; round < ROUNDS && (rows.size || kept.size); round++) {
      const writes: { name: string; row?: Row; base: number; k: string; v: string }[] = [];
      for (const [name, ours] of rows) {
        const held = this.acknowledged.get(name);
        if (held && isDocument(held.row) && held.row.format > WIRE) {
          rows.delete(name);
          continue;
        }
        const row = held ? merge(held.row, ours) : ours;
        if (held && canonical(held.row) === canonical(row)) {
          rows.delete(name);
          continue;
        }
        if (isDocument(row) && !encodeDocument(row, false)) {
          console.warn(`den: ${name} would be too large merged with the library it moves into`);
          rows.delete(name);
          continue;
        }
        writes.push({ name, row, base: held?.seq ?? 0, ...(await seal(this.keys, row)) });
      }
      for (const [name, plaintext] of kept) {
        if (this.acknowledged.has(name)) {
          kept.delete(name);
          continue;
        }
        writes.push({ name, base: 0, ...(await sealPlaintext(this.keys, name, plaintext)) });
      }
      for (const chunk of chunks(writes)) {
        const res = await this.send(`/lib/${this.keys.id}/batch`, {
          method: 'POST',
          headers: {
            ...this.headers(),
            'content-type': 'application/json',
            'x-den-library-member': member,
            'x-den-wire-min': String(WIRE),
          },
          body: JSON.stringify({ writes: chunk.map(({ k, base, v }) => ({ k, base, v })) }),
        });
        if (!res.ok) {
          await this.failed(res);
          return false;
        }
        this.generation = res.headers.get('x-den-generation') ?? this.generation;
        const batch = (await res.json()) as Batch;
        for (const write of chunk) {
          const applied = batch.applied.find(({ k }) => k === write.k);
          if (applied) {
            rows.delete(write.name);
            kept.delete(write.name);
            continue;
          }
          const conflict = batch.conflicts.find(({ k }) => k === write.k);
          if (!conflict || conflict.omitted || conflict.v === null) return false;
          // Another version is here: the next round merges onto it.
          const theirs = await this.readEntry({ k: conflict.k, v: conflict.v });
          if (!theirs) return false;
          this.acknowledged.set(write.name, { seq: conflict.seq, row: theirs });
        }
      }
    }
    return rows.size === 0 && kept.size === 0;
  }

  /**
   * The end of a move away from this library to `successor` (§12, v2 §1 step 3): deleted on den-edge, which retires
   * its id, so a device still holding its key gets `410 library_moved`. The `DELETE` names the head the move copied
   * through and the successor; a den-edge that knows them refuses a write since (`409 head_changed`) and names the
   * successor in its `410`. `changed` when something was written after `moving` read it — a new head, or a new
   * generation — so the move copies again first. `failed` when it wasn't deleted, by this move or at all: another
   * device's concurrent reset deleted it first, or den-edge refused. `unknown` when the answer was lost and whether it
   * was deleted can't be told now: the new library must then stay, and the pending reset is settled later
   * (`settle`).
   */
  async endMoved(
    moving: Moving,
    successor: LibraryLog,
  ): Promise<'deleted' | 'changed' | 'failed' | 'unknown'> {
    const check = await this.standing();
    if (check === null) return 'failed';
    if ('moved' in check) return check.successor === successor.keys.id ? 'deleted' : 'failed';
    if (check.head !== moving.head || check.generation !== moving.generation) return 'changed';
    let res: Response;
    try {
      res = await this.send(`/lib/${this.keys.id}`, {
        method: 'DELETE',
        headers: {
          ...this.headers(),
          'x-den-generation': moving.generation ?? '0',
          'x-den-base': String(moving.head),
          'x-den-successor': successor.keys.id,
        },
      });
    } catch {
      const after = await this.standing();
      if (after === null) return 'unknown';
      if ('head' in after) return 'failed';
      // A den-edge that names no successor can't say whose move it was; this one had just copied it, so it is ours.
      return after.successor === undefined || after.successor === successor.keys.id
        ? 'deleted'
        : 'failed';
    }
    if (res.ok) return 'deleted';
    const code = await errorCode(res);
    return code === 'generation_changed' || code === 'head_changed' ? 'changed' : 'failed';
  }

  /**
   * Where this library stands on den-edge: its head and generation, `moved` with the successor its `410` names
   * (when den-edge records one), or null when den-edge can't be read.
   */
  async standing(): Promise<
    { head: number; generation: string | null } | { moved: true; successor?: string } | null
  > {
    try {
      const res = await this.send(`/lib/${this.keys.id}/changes?since=0&limit=1`, {
        headers: this.headers(),
      });
      if (res.status === 410) {
        const body = (await res.json().catch(() => ({}))) as { successor?: unknown };
        return {
          moved: true,
          successor: typeof body.successor === 'string' ? body.successor : undefined,
        };
      }
      if (!res.ok) return null;
      const page = (await res.json()) as Page;
      return {
        head: page.head,
        generation: page.generation ?? res.headers.get('x-den-generation'),
      };
    } catch {
      return null;
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
    const saved = (await log.kept<Snapshot>(SNAPSHOT_V4)) ?? (await log.kept<Snapshot>(SNAPSHOT));
    if (saved) {
      await policy;
      log.memberRegistered = saved.memberRegistered ?? false;
      log.generation = saved.generation;
      log.head = saved.head;
      for (const [name, seq, row] of saved.entries) {
        if (!wellFormed(row)) continue;
        log.noteFormat(row);
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
        if (!wellFormed(row)) continue;
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
        // Registered under the generation it now reads: under the old one den-edge refuses it.
        log.generation = page.generation;
        await log.registerMember();
        log.head = since = 0;
        for (const entry of log.entries.values()) entry.seq = 0;
        if (log.wireMin >= WIRE)
          for (const [name, { row }] of log.entries) if (legacy(row)) log.entries.delete(name);
        log.acknowledged.clear();
        continue;
      }
      log.generation = page.generation;
      for (const entry of page.entries) {
        // Tampered with, sealed under another library's key, or newer than this build: not read as a row.
        const row = await log.readEntry(entry);
        if (!row) continue;
        const previous = log.entries.get(rowName(row));
        log.entries.set(rowName(row), {
          seq: entry.seq,
          row: previous ? merge(previous.row, row) : row,
        });
        log.acknowledged.set(rowName(row), { seq: entry.seq, row });
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

  /** Every row, a v4 document shown as the title or season row it stands for (`projectDocument`). */
  rows(): Row[] {
    return [...this.entries.values()].flatMap(({ row }) =>
      isDocument(row) ? projectDocument(row) : [row],
    );
  }

  /** Every v4 document as it is held, with the seq den-edge last gave it: what tracker delivery decides on (§9). */
  documents(): { seq: number; document: DocumentRow }[] {
    return [...this.entries.values()].flatMap(({ seq, row }) =>
      isDocument(row) ? [{ seq, document: row }] : [],
    );
  }

  private document(name: string): DocumentRow | undefined {
    const row = this.entries.get(name)?.row;
    return row && isDocument(row) ? row : undefined;
  }

  /**
   * A stored row read as library v4 reads one (§4), keeping track of what can't be: an unreadable row by its `k`, to
   * be removed (`compact`); a newer framing or format, which stops this build writing. Null for a row not read.
   */
  private async readEntry(entry: { k: string; v: string }): Promise<Row | null> {
    const opened = await openEntry(this.keys, entry.k, entry.v);
    this.unreadable.delete(entry.k);
    this.newerFraming.delete(entry.k);
    if ('unreadable' in opened) {
      console.warn(`den: the library row ${entry.k} is unreadable (${opened.unreadable})`);
      this.unreadable.set(entry.k, opened.unreadable);
      return null;
    }
    if ('newerFraming' in opened) {
      this.newerFraming.add(entry.k);
      this.upgradeRequired ??= WIRE + 1;
      return null;
    }
    if ('unknown' in opened) return null;
    this.noteFormat(opened.row);
    return believe(opened.row);
  }

  /** A document of a newer format is read, never written, and says this build needs updating (§4). */
  private noteFormat(row: Row): void {
    if (!isDocument(row)) return;
    if (row.format > WIRE) {
      this.newerDocuments.add(rowName(row));
      this.upgradeRequired ??= row.format;
    } else this.newerDocuments.delete(rowName(row));
  }

  /**
   * Incremental foreground refresh. Uses the same serialization boundary as writes. True only when it changed what
   * this browser holds: a row arrived, the log was reset, or kept work reached den-edge. A poll that finds nothing
   * new is false, so what is built from the library is not rebuilt on every 30-second refresh.
   */
  async refresh(): Promise<boolean> {
    // Nothing else writes a library kept only here but another tab, whose rows each save takes up (`takeKept`).
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
            // Registered under the generation it now reads: under the old one den-edge refuses it.
            this.generation = page.generation;
            this.writeGeneration = undefined;
            await this.registerMember();
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            // Switched to v4 meanwhile: what was read of the v3 log is not drawn beside its documents.
            if (this.wireMin >= WIRE)
              for (const [name, { row }] of this.entries)
                if (legacy(row)) this.entries.delete(name);
            this.acknowledged.clear();
            this.dirty = true;
            this.unreported = true;
            continue; // Reread a restored store from zero; transport sequence is not a field timestamp.
          }
          this.generation = page.generation;
          this.writeGeneration = undefined;
          for (const entry of page.entries) {
            // Unreadable rows are skipped individually, as on initial open.
            const row = await this.readEntry(entry);
            if (!row) continue;
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

  /**
   * Keep den-edge's rows for the next visit, in the order they changed; a failure only costs that visit a full read.
   * A library kept only here is saved whole by each tab that has it open, so what another tab saved is merged in
   * first (`takeKept`), under one lock per library where the browser has `navigator.locks`.
   */
  private persist(): void {
    if (!this.dirty || !this.local) return;
    this.dirty = false;
    const snapshot = this.offline ? undefined : this.snapshot();
    // A library at v4 is kept under its own name, and the older copy goes, so neither is read for the other.
    const [name, other] =
      this.wireMin >= WIRE && !this.offline ? [SNAPSHOT_V4, SNAPSHOT] : [SNAPSHOT, SNAPSHOT_V4];
    const save = async (kept: Snapshot) => {
      await this.local?.vault.remove(`${this.keys.id}:${other}`);
      return kept.entries.length
        ? this.keep(name, kept)
        : this.local?.vault.remove(`${this.keys.id}:${name}`);
    };
    this.saving = this.saving
      .then(() =>
        snapshot
          ? save(snapshot)
          : exclusive(`den.library.${this.keys.id}`, async () => {
              await this.takeKept();
              await save(this.snapshot());
            }),
      )
      .catch((error: unknown) => {
        this.dirty = true;
        console.warn('den: the library could not be kept for the next visit', error);
      });
  }

  /** Every row another tab kept of this library kept only here, merged with this tab's the way a write is merged. */
  private async takeKept(): Promise<void> {
    const saved = await this.kept<Snapshot>(SNAPSHOT);
    this.takeForm(saved);
    for (const [name, , row] of saved?.entries ?? []) {
      const ours = this.acknowledged.get(name)?.row;
      const merged = ours ? merge(row, ours) : row;
      this.entries.set(name, { seq: 0, row: merged });
      this.acknowledged.set(name, { seq: 0, row: merged });
    }
  }

  private snapshot(): Snapshot {
    return {
      generation: this.generation,
      head: this.head,
      memberRegistered: this.memberRegistered,
      entries: [...this.acknowledged].map(([name, { seq, row }]) => [name, seq, row]),
      ...(this.offline && this.wireMin > 2 ? { wireMin: this.wireMin } : {}),
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
    const document = this.document(`title:${ref.type}:${ref.id}`);
    if (document) return projectDocument(document)[0] as TitleRow;
    const row = this.entries.get(`rec:${ref.type}:${ref.id}`)?.row;
    return row?.kind === 'rec' ? row : undefined;
  }

  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined {
    const document = ref.type === 'tv' && this.document(`season:tv:${ref.id}:${season}`);
    if (document)
      return projectEpisode(this.document(`title:tv:${ref.id}`), document, ref, season, episode);
    const row = this.entries.get(`ep:${ref.type}:${ref.id}:${season}:${episode}`)?.row;
    if (row?.kind === 'ep') return row;
    if (ref.type !== 'tv') return undefined;
    const block = Math.floor(episode / 32);
    const watch = this.entries.get(`wat:tv:${ref.id}:${season}:${block}`)?.row;
    if (watch?.kind !== 'wat') return undefined;
    const register = watch.entries[String(episode)];
    if (!register) return undefined;
    const title = this.title(ref);
    const resets = [watch.seasonReset, title?.episodesReset].filter(
      (value): value is Stamp => value !== null && value !== undefined,
    );
    const state = syncPolicy<{
      watched: boolean;
      resume: EpisodeRow['progress'] | null;
      viewing: number;
      watched_at: number | null;
    }>({ op: 'episode_state', register, resets, now: Date.now() });
    const at: Stamp =
      state.resume?.at ?? (state.watched_at ? [state.watched_at, 0, ''] : ZERO_STAMP);
    return {
      kind: 'ep',
      schema: 2,
      title: { type: 'tv', id: ref.id },
      season,
      episode,
      progress: state.resume ?? { value: state.watched ? 1 : 0, viewing: state.viewing, at },
    };
  }

  private v3EpisodeWrite(row: EpisodeRow): WatchRow | null {
    const block = Math.floor(row.episode / 32);
    const name = `wat:tv:${row.title.id}:${row.season}:${block}`;
    const current = this.entries.get(name)?.row;
    const watch: WatchRow =
      current?.kind === 'wat'
        ? current
        : {
            kind: 'wat',
            schema: 3,
            title: row.title,
            season: row.season,
            block,
            seasonReset: null,
            entries: {},
          };
    const previous = watch.entries[String(row.episode)] ?? null;
    const kind =
      row.progress.value >= 0.95
        ? 'mark_watched'
        : row.progress.value === 0
          ? 'unwatch'
          : 'progress';
    const register = syncPolicy<WatchRow['entries'][string] | null>({
      op: 'register_write',
      action: {
        kind,
        value: row.progress.value,
        viewing: row.progress.viewing,
        seconds: row.progress.seconds,
        watched_at: row.progress.at[0],
        at: row.progress.at,
      },
      current: previous,
      resets: [watch.seasonReset].filter((value): value is Stamp => value !== null),
      now: Date.now(),
    });
    if (!register) return null;
    return { ...watch, entries: { ...watch.entries, [String(row.episode)]: register } };
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
  async write(local: Row, outcome?: Outcome, durable = true): Promise<Row | null> {
    await this.followKeptForm();
    if (this.readOnly) return null;
    if (this.wireMin >= WIRE && !this.offline && local.kind !== 'set') {
      if (local.kind !== 'rec' && local.kind !== 'ep') return null;
      return this.writeEdit(this.before(local), local, outcome, durable);
    }
    if (this.wireMin >= 3 && local.kind === 'ep') {
      const converted = this.v3EpisodeWrite(local);
      if (!converted) return local;
      local = converted;
    }
    let kept: string | undefined;
    if (durable && !this.offline && this.storage) {
      kept = this.pendingPrefix + 'rows:' + crypto.randomUUID();
      try {
        this.storage.setItem(kept, JSON.stringify({ rows: [await seal(this.keys, local)] }));
      } catch {
        return null;
      }
    }
    const run = this.writes.then(() => this.writeSerial(local, outcome));
    this.writes = run.catch(() => null);
    const saved = await run;
    if (saved) {
      // A return visit opens the acknowledged snapshot before it reaches den-edge. Keep the applied row there before
      // dropping its recovery copy, or an immediate reload briefly restores the older row and an offline reload loses
      // the edit altogether.
      this.persist();
      await this.saving;
      if (kept) this.discard(kept);
    }
    return saved ?? (kept ? this.project(local) : null);
  }

  /** What a title or episode row stood at before an edit made from it: as read, or blank for one never held. */
  private before(row: TitleRow | EpisodeRow): Row {
    return row.kind === 'rec'
      ? (this.title(row.title) ?? blankTitle(row.title, row.addedAt))
      : (this.episode(row.title, row.season, row.episode) ??
          blankEpisode(row.title, row.season, row.episode));
  }

  /**
   * `before` as den-edge holds it, without kept work drawn over it: kept work is drawn into `entries` as soon as the
   * library opens, so an edit kept from before read from there would already be made, and would be dropped unsent.
   */
  private storedBefore(row: TitleRow | EpisodeRow): Row {
    const stored = (name: string) => {
      const held = this.acknowledged.get(name)?.row;
      return held && isDocument(held) ? held : undefined;
    };
    if (row.kind === 'rec') {
      const document = stored(`title:${row.title.type}:${row.title.id}`);
      return document
        ? (projectDocument(document)[0] as TitleRow)
        : blankTitle(row.title, row.addedAt);
    }
    const season = row.title.type === 'tv' && stored(`season:tv:${row.title.id}:${row.season}`);
    return (
      (season &&
        projectEpisode(
          stored(`title:tv:${row.title.id}`),
          season,
          row.title,
          row.season,
          row.episode,
        )) ||
      blankEpisode(row.title, row.season, row.episode)
    );
  }

  /**
   * Library v4 §8: one edit, written as den-core's writes on the documents it touches. Resolves to the title or
   * episode as it now reads, or null when it was not saved.
   */
  private async writeEdit(
    before: Row,
    after: Row,
    outcome?: Outcome,
    durable = true,
  ): Promise<Row | null> {
    if (!(await this.writeOps(opsFor(before, after), outcome, durable))) return null;
    const now =
      after.kind === 'rec'
        ? this.title(after.title)
        : after.kind === 'ep'
          ? this.episode(after.title, after.season, after.episode)
          : undefined;
    return now ?? after;
  }

  /**
   * Send `ops`, kept first in this browser as they are (§11), so a write den-edge refuses for now — a rewrite under
   * way, a generation change, a library that needs a newer build — is sent again later and drawn meanwhile. True
   * when sent or kept; false when it was not saved: refused for good, or nowhere to keep it. `key` is a piece of
   * kept work already holding them.
   */
  private async writeOps(
    ops: Op[],
    outcome: Outcome = { refused: false },
    durable = true,
    key?: string,
  ): Promise<boolean> {
    if (!ops.length) return true;
    let kept = key;
    if (!kept && durable && this.storage) {
      kept = this.pendingPrefix + 'ops:' + crypto.randomUUID();
      try {
        this.storage.setItem(kept, JSON.stringify({ ops: await this.sealKept(ops) }));
      } catch {
        return false;
      }
    }
    if (kept) this.flushing.add(kept);
    const run = this.writes.then(() => this.sendOps(ops, outcome));
    this.writes = run.catch(() => false);
    const sent = await run
      .catch((error: unknown) => {
        console.warn('den: a library write failed', error);
        return false;
      })
      .finally(() => kept && this.flushing.delete(kept));
    if (sent) {
      this.persist();
      await this.saving;
      if (kept) {
        this.discard(kept);
        this.rejected.delete(kept);
      }
      return true;
    }
    if (outcome.refused) {
      // A fresh edit refused for good is not kept to be refused again; one kept from before waits `RECHECK_MS`.
      if (key) this.rejected.set(key, Date.now());
      else if (kept) this.discard(kept);
      return false;
    }
    if (!kept) return false;
    this.projectOps(ops);
    // Kept: saved, for a fresh edit; still waiting, for kept work sent again.
    return !key;
  }

  /**
   * `ops` sent as den-core writes them, compare-and-set, derived from den-edge's own version of each document — not
   * from what this browser draws, which already shows kept writes. A conflict is read and the writes derived again
   * (§8).
   */
  private async sendOps(ops: Op[], outcome: Outcome): Promise<boolean> {
    const stored = (name: string) => {
      const row = this.acknowledged.get(name)?.row;
      return row && isDocument(row) ? row : undefined;
    };
    for (let round = 0; round < ROUNDS; round++) {
      // A document of a newer format is never written: the write waits for this build to be updated (§4).
      if (touched(ops).some((name) => this.newerDocuments.has(name))) return false;
      const documents = applyOps(ops, stored);
      if (!documents.length) return true;
      const writes: { name: string; document: DocumentRow; base: number; k: string; v: string }[] =
        [];
      for (const document of documents) {
        const name = rowName(document);
        const encoded = encodeDocument(document, true);
        if (!encoded) {
          console.warn(`den: ${name} is full, so this change to it was not saved`);
          this.refusal = 'document_full';
          outcome.refused = true;
          return false;
        }
        const sealed = await sealPlaintext(this.keys, name, encoded.plaintext);
        writes.push({ name, document, base: this.acknowledged.get(name)?.seq ?? 0, ...sealed });
      }
      let batch: Batch;
      try {
        const res = await this.send(`/lib/${this.keys.id}/batch`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes: writes.map(({ k, base, v }) => ({ k, base, v })) }),
        });
        if (!res.ok) {
          const code = await this.failed(res, outcome);
          if (code === 'generation_changed' && this.adoptGeneration(res)) continue;
          return false;
        }
        batch = (await res.json()) as Batch;
      } catch {
        return false;
      }
      for (const write of writes) {
        const applied = batch.applied.find(({ k }) => k === write.k);
        if (!applied) continue;
        this.acknowledge(write.name, applied.seq, write.document);
        outcome.applied = true;
      }
      if (!batch.conflicts.length) {
        await this.registerMember();
        return true;
      }
      for (const conflict of batch.conflicts) {
        const write = writes.find(({ k }) => k === conflict.k);
        if (!write) continue;
        if (conflict.omitted) return false;
        if (conflict.v === null) {
          this.entries.delete(write.name);
          this.acknowledged.delete(write.name);
          continue;
        }
        const theirs = await this.readEntry({ k: conflict.k, v: conflict.v });
        if (!theirs) return false;
        this.entries.set(write.name, { seq: conflict.seq, row: theirs });
        this.acknowledged.set(write.name, { seq: conflict.seq, row: theirs });
        this.dirty = true;
      }
    }
    return false;
  }

  /**
   * The generation a `generation_changed` refusal names, taken for writes: true when it was new, and a write may go
   * again. What this browser has read stays under the old one, so the next `refresh` still sees the change, reads
   * the new log from the start and writes back (§11) — a switch or a restore is never taken for the log it was.
   */
  private adoptGeneration(res: Response): boolean {
    const current = res.headers.get('x-den-generation');
    if (!current || current === (this.writeGeneration ?? this.generation)) return false;
    console.warn(`den: library generation changed during a write; retrying with ${current}`);
    this.writeGeneration = current;
    return true;
  }

  /** What kept `ops` will do once sent, drawn now. */
  private projectOps(ops: Op[]): void {
    try {
      for (const document of applyOps(ops, (name) => this.document(name))) {
        const name = rowName(document);
        this.entries.set(name, { seq: this.entries.get(name)?.seq ?? 0, row: document });
        this.projected++;
      }
    } catch (error) {
      console.warn('den: a kept library write could not be drawn', error);
    }
  }

  /** The seq den-edge last gave the row `name`, 0 for none: the base a compare-and-set write of it is made on. */
  seqOf(name: string): number {
    return this.entries.get(name)?.seq ?? 0;
  }

  /**
   * One row exactly as given, compare-and-set on `base`: a delivery document on the seq it was read at before the
   * commands it settles were decided, or a delivery row's lease on the seq it was read at (§9). A conflict is not
   * merged: the row is read again, and the caller decides again next pass.
   */
  async writeAt(row: DocumentRow | SettingsRow, base: number): Promise<boolean> {
    if (this.readOnly || this.offline) return false;
    let changed = false;
    const run = this.writes.then(async () => {
      const name = rowName(row);
      const { k, v } = await seal(this.keys, row);
      const res = await this.send(`/lib/${this.keys.id}/batch`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ writes: [{ k, base, v }] }),
      });
      if (!res.ok) {
        changed = (await this.failed(res)) === 'generation_changed';
        return false;
      }
      const batch = (await res.json()) as Batch;
      const applied = batch.applied.find((entry) => entry.k === k);
      if (applied) {
        this.acknowledge(name, applied.seq, row);
        return true;
      }
      const conflict = batch.conflicts.find((entry) => entry.k === k);
      const theirs = conflict?.v ? await this.readEntry({ k, v: conflict.v }) : null;
      if (conflict && theirs) {
        this.entries.set(name, { seq: conflict.seq, row: theirs });
        this.acknowledged.set(name, { seq: conflict.seq, row: theirs });
        this.dirty = true;
      }
      return false;
    });
    this.writes = run.catch(() => false);
    const written = await run.catch(() => false);
    if (written) this.persist();
    // `base` is a seq of a log that is gone: the new one is read now, so the caller's next pass decides on it.
    if (changed) await this.refresh();
    return written;
  }

  /** Kept work's ops, sealed under the library's key: they say what was watched. */
  private async sealKept(ops: Op[]): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8.encode('den/kept-ops') },
      this.keys.enc,
      utf8.encode(JSON.stringify(ops)),
    );
    const bytes = new Uint8Array(iv.length + sealed.byteLength);
    bytes.set(iv);
    bytes.set(new Uint8Array(sealed), iv.length);
    return toBase64url(bytes);
  }

  private async openKept(text: string): Promise<Op[]> {
    const bytes = fromBase64url(text);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8.encode('den/kept-ops') },
      this.keys.enc,
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as Op[];
  }

  private async writeSerial(local: Row, outcome?: Outcome): Promise<Row | null> {
    if (this.offline) return this.keepLocally(local);
    const seen = this.entries.get(rowName(local))?.row;
    let target = seen ? merge(seen, local) : local;
    for (let round = 0; round < ROUNDS; round++) {
      // The library went to v4 under this write (a generation change): a v2 or v3 row is never written into it.
      // Its kept copy is sent again as the v4 writes it stands for (`v4Work`).
      if (this.wireMin >= WIRE && !this.offline && legacy(target)) return null;
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
          const code = await this.failed(res, outcome);
          if (code === 'generation_changed' && this.adoptGeneration(res)) continue;
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
  private async failed(res: Response, outcome?: Outcome): Promise<string | undefined> {
    if (res.status === 410) {
      this.moved = true;
      return;
    }
    const code = await errorCode(res);
    if (RETRYABLE_REFUSALS.has(code ?? '')) {
      if (code === 'upgrade_required') this.upgradeRequired = this.wireMin;
      this.refusal = code ?? String(res.status);
      return code;
    }
    const refusals = REFUSALS[res.status];
    if (!refusals) return;
    if (res.status === 403 && code === 'new_libraries_closed') {
      this.refused = true;
      this.refusedAt = Date.now();
      forgetLibraryCredential();
      return;
    }
    if (refusals !== 'any' && !refusals.includes(code)) return;
    if (outcome) outcome.refused = true;
    this.refusal = code ?? String(res.status);
    console.warn(`den: den-edge refused a library write (${res.status} ${code ?? ''})`);
    return code;
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
    this.observeProtocol(res);
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
    return {
      'x-den-library-token': this.keys.token,
      'x-den-wire': String(WIRE),
      'x-den-generation': this.writeGeneration ?? this.generation ?? '0',
    };
  }

  private observeProtocol(res: Response): void {
    const minimum = Number(res.headers.get('x-den-wire-min'));
    if (!Number.isInteger(minimum) || minimum < 2 || minimum <= this.wireMin) return;
    this.wireMin = minimum;
    if (minimum > WIRE) this.upgradeRequired = minimum;
    // Another device switched it: what kept this browser from writing a v3 library no longer applies.
    if (minimum >= WIRE) {
      this.switchFailure = null;
      this.predatesV3 = false;
    }
    try {
      this.storage?.setItem(`den.libraryWireMin.${this.keys.id}`, String(minimum));
    } catch {
      /* The in-memory monotonic fence still holds for this visit. */
    }
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
    if (this.readOnly) return false;
    // v4 writes no history rows (§8): each action is the writes it makes, kept as one piece of work.
    if (this.wireMin >= WIRE && !this.offline)
      return this.writeOps(
        journals.flatMap((row) => {
          const event = trackerEvent(row)!;
          return opsFor(event.before, event.after);
        }),
      );
    if (this.offline) {
      await this.followKeptForm();
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
    // A library now at v4 takes no v2 or v3 row back (`v4Work`): the switch already converted what this browser read
    // of the old log. Staging them anyway can overflow localStorage for a large library, and then the new log is
    // never read: every write goes on carrying the old generation.
    const rows = [...this.entries.values()]
      .filter((entry) => entry.seq > 0 && !(this.wireMin >= WIRE && legacy(entry.row)))
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
    } catch (error) {
      console.warn(
        'den: the library changed generation, but its rows could not be kept to recover',
        error,
      );
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
      for (const group of groups) {
        const rows = coalesce(group);
        for (let offset = 0; offset < rows.length; offset += 32) {
          const due = rows.slice(offset, offset + 32).flatMap((local) => {
            const name = rowName(local),
              previous = this.entries.get(name);
            const row = previous ? merge(previous.row, local) : local;
            if (this.holds(name, row)) return [];
            // A merge over the cap leaves the log's version as it stands, and this copy's extra state goes (§11).
            if (isDocument(row) && !encodeDocument(row, false)) {
              console.warn(`den: ${name} would be too large merged with this browser's copy`);
              return [];
            }
            return [{ row, name, base: previous?.seq ?? 0 }];
          });
          if (!due.length) continue;
          const sealed = await Promise.all(
            due.map(async (entry) => ({ ...entry, ...(await seal(this.keys, entry.row)) })),
          );
          // Split by bytes too: 32 v4 documents can be far more than den-edge takes in one batch.
          for (const chunk of chunks(sealed)) {
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
    if (this.readOnly) return null;
    if (this.wireMin >= WIRE && !this.offline) return this.writeEdit(event.before, event.after);
    if (this.offline) {
      await this.followKeptForm();
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
    const accepted = await this.write(journal, outcome, false).finally(() =>
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
    // The accepted immutable event is the durable source of this projection; keeping a second generic row would
    // send it twice when local pending cleanup itself failed.
    const saved = await this.write(event.after, undefined, false);
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
          rows?: { k: string; v: string }[];
          ops?: string;
        };
        if (pending.ops !== undefined) {
          kept.push({ key, rows: [], kind: 'ops', ops: await this.openKept(pending.ops) });
          continue;
        }
        const sealed = pending.restore ?? pending.bulk ?? pending.rows ?? [pending];
        const rows = await Promise.all(sealed.map(({ k, v }) => open(this.keys, k, v)));
        kept.push({
          key,
          rows,
          kind: pending.restore ? 'restore' : pending.bulk ? 'bulk' : pending.rows ? 'rows' : 'one',
        });
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

  private projectWork(work: KeptWork): void {
    if (this.wireMin >= WIRE && !this.offline) {
      let converted: { restore: Row[]; ops: Op[] };
      try {
        converted = this.v4Work(work);
      } catch (error) {
        // Kept, and sent once it converts (`replay` keeps it too); only its drawing is missing meanwhile.
        console.warn('den: kept library work could not be read as Library v4', error);
        return;
      }
      for (const row of converted.restore) this.project(row);
      this.projectOps(converted.ops);
      return;
    }
    const { rows, kind } = work;
    for (const row of rows) {
      if (kind === 'restore') this.project(row);
      else if (row.kind === 'set' && trackerEvent(row)) this.project(trackerEvent(row)!.after);
    }
  }

  /**
   * Kept work as a v4 library takes it (§11): rows written back as they are — documents, and settings less a
   * delivery row's `lease` and switch-only facts — and edits as den-core writes. An edit this build kept before the
   * switch is turned into those writes: an action or a title or episode row as ops, and episode progress kept on v3
   * (a `wat` row, which `write` makes of it) as the season document den-core's switch makes of it, merged when sent.
   * A recovery copy of the v3 log itself, and receipts, are discarded: the switch already converted that log.
   */
  private v4Work(work: KeptWork): { restore: Row[]; ops: Op[] } {
    if (work.kind === 'ops') return { restore: [], ops: work.ops ?? [] };
    const restore: Row[] = [];
    const ops: Op[] = [];
    if (work.kind !== 'restore')
      restore.push(...v3Documents(work.rows.filter((row) => row.kind === 'wat')));
    for (const row of work.rows) {
      const event = trackerEvent(row);
      if (event) {
        if (work.kind !== 'restore') ops.push(...opsFor(event.before, event.after));
      } else if (isDocument(row)) restore.push(row);
      else if (row.kind === 'set')
        restore.push(
          row.name.startsWith('deliver:')
            ? { ...row, values: row.values.since ? { since: row.values.since } : {} }
            : row,
        );
      else if ((row.kind === 'rec' || row.kind === 'ep') && work.kind !== 'restore')
        ops.push(...opsFor(this.storedBefore(row), row));
    }
    return { restore, ops };
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
        if (this.wireMin >= WIRE && !this.offline) {
          const { restore, ops } = this.v4Work(work);
          for (const row of restore) this.project(row);
          if (ops.length && !(await this.writeOps(ops, undefined, false, key))) continue;
          if (!restore.length) this.discard(key);
          else if ((await this.flushRows(key, [restore])) && kind === 'restore')
            this.recoveryRows = undefined;
          continue;
        }
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
        if (kind === 'rows') {
          for (const row of rows) this.project(row);
          await this.flushRows(key, [rows]);
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
      const groups =
        this.wireMin >= WIRE
          ? [this.v4Work({ key: '', rows, kind: 'restore' }).restore]
          : [rows.filter(trackerEvent), rows.filter((row) => !trackerEvent(row))];
      if (await this.flushRows(this.pendingPrefix + 'recovery', groups)) {
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

/** `work` under the lock `name` in every tab of this browser; with no `navigator.locks`, just `work`. */
export function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(name, work) : work();
}

/**
 * One row per name, the rows that share it merged. Under v3 every episode of a 32-episode block is a write of the
 * same `wat` row, so an import marking several of them would otherwise send that row twice in one batch, which
 * den-edge refuses whole (`invalid_batch`).
 */
function coalesce(rows: Row[]): Row[] {
  const byName = new Map<string, Row>();
  for (const row of rows) {
    const name = rowName(row);
    const held = byName.get(name);
    byName.set(name, held ? merge(held, row) : row);
  }
  return [...byName.values()];
}

/**
 * v3 `wat` and `snt` rows as the documents den-core's switch makes of them (`v4_form`), to be merged with what a v4
 * log holds. Throws when den-core refuses them, so they are kept rather than lost.
 */
function v3Documents(rows: Row[]): DocumentRow[] {
  if (!rows.length) return [];
  return syncPolicy<{ documents: { document: DocumentRow }[] }>({
    op: 'v4_form',
    rows: rows.map((row, index) => ({ k: '', seq: index + 1, bytes: 0, row })),
    base: rows.length,
    performer: '',
    now: Date.now(),
  }).documents.map(({ document }) => document);
}

/** Writes in batches den-edge takes: at most `REWRITE_BATCH_MAX` of them, and `REWRITE_BATCH_MAX_BYTES` of body. */
function chunks<T>(writes: T[]): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const write of writes) {
    const size = utf8.encode(JSON.stringify(write)).length + 1;
    if (
      chunk.length &&
      (chunk.length >= REWRITE_BATCH_MAX || bytes + size > REWRITE_BATCH_MAX_BYTES - 16)
    ) {
      out.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(write);
    bytes += size;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

function merge(theirs: Row, ours: Row): Row {
  if (isDocument(theirs) && isDocument(ours)) {
    // A document of a newer format is never merged by this build; the newer of the two stands (§4).
    if (theirs.format > WIRE || ours.format > WIRE)
      return ours.format > theirs.format ? ours : theirs;
    return mergeDocument(theirs, ours);
  }
  if (theirs.kind === 'rec' && ours.kind === 'rec') return mergeTitle(theirs, ours);
  if (theirs.kind === 'ep' && ours.kind === 'ep') return mergeEpisode(theirs, ours);
  if (theirs.kind === 'set' && ours.kind === 'set') return mergeSettings(theirs, ours);
  if (theirs.kind === 'wat' && ours.kind === 'wat') return mergeV3(theirs, ours);
  if (theirs.kind === 'snt' && ours.kind === 'snt') return mergeV3(theirs, ours);
  return theirs;
}
