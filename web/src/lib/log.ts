// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): read whole, and written a
// row at a time with compare-and-set. The TV writes it whenever the library changes. What den-edge last said is kept
// in this browser (`localVault.ts`), so a return visit starts from it and asks only for what changed since.

import { blankEpisode, blankTitle } from './actions';
import { exclusive } from './exclusive';
import { householdScoped } from './householdScope';
import { resetAssistantRows } from './libraryAssistantAuthority';
import { PRE_V4_BACKUP_ERROR } from './libraryErrors';
import { applyOps, opsFor, projectDocument, projectEpisode, touched, type Op } from './libraryV4';
import { libraryVault, type Vault } from './localVault';
import { libraryLocalKey } from './libraryLocalKey';
import { openLibraryLocalValue, sealLibraryLocalValue } from './libraryLocalValue';
import { LibraryFactStore, type LibraryFactEntry } from './libraryFactStore';
import { retryAfterMs } from './retryAfter';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import {
  kidApprovalName,
  validateKidTitleApprovals,
  type KidTitleApprovalsDocument,
} from './kidTitleApprovals';
import {
  profilesConstructDirectory,
  profilesMaterialize,
  profilesMerge,
  profilesSnapshotDigest,
  type ProfileCreateJournal,
  type ProfilesSnapshotRow,
} from './profilesCore';
import type { ProfileDirectoryAuthority } from './profileKidCreateWorker';
import { profileResetHeadersAllowed, profileResetRoute } from './profileKeyResetRoutes';
import { forgetLibraryCredential, hasLibraryCredential, useLibraryCredential } from './relayFetch';
import type { LibraryRelayMembership } from './relayFetch';
import { startupMark } from './startupTiming';
import { noteLibraryHydrate } from './libraryStartupMetrics';
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
  newestSummary,
  open,
  openEntry,
  openPlaintext,
  rowName,
  rowKey,
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
} from './wire';
import { trackerEvent } from './trackerEvents';
import { episodeRow, titleRow } from './titleView';
import { ensureDeferredSyncPolicy, ensureSyncPolicy } from './syncLoader';
import { inPolicySlices, syncPolicy, type PolicySliceOptions } from './syncCore';
import { openKeptInWorker, projectRowsInWorker } from './libraryWorkerClient';
import type { LibraryWire } from './libraryServiceProtocol';

interface Entry {
  seq: number;
  row: Row;
}

/** Every mutation advances a version, including conflict replacement and generation reset paths. */
class ChangedMap<K, V> extends Map<K, V> {
  constructor(private readonly changed: () => void) {
    super();
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    this.changed();
    return this;
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.changed();
    return deleted;
  }

  override clear(): void {
    if (!this.size) return;
    super.clear();
    this.changed();
  }
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

const responseEntry = (value: unknown): value is RawEntry =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as RawEntry).k === 'string' &&
  /^[0-9a-f]{64}$/.test((value as RawEntry).k) &&
  Number.isSafeInteger((value as RawEntry).seq) &&
  (value as RawEntry).seq > 0 &&
  typeof (value as RawEntry).v === 'string';

const responsePage = (value: unknown): value is Page =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Array.isArray((value as Page).entries) &&
  (value as Page).entries.every(responseEntry) &&
  Number.isSafeInteger((value as Page).head) &&
  (value as Page).head >= 0 &&
  typeof (value as Page).more === 'boolean';

const responseBatch = (value: unknown): value is Batch => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const answer = value as Batch;
  return (
    Array.isArray(answer.applied) &&
    answer.applied.every(
      (entry) =>
        !!entry &&
        typeof entry.k === 'string' &&
        /^[0-9a-f]{64}$/.test(entry.k) &&
        Number.isSafeInteger(entry.seq) &&
        entry.seq > 0,
    ) &&
    Array.isArray(answer.conflicts) &&
    answer.conflicts.every(
      (entry) =>
        !!entry &&
        typeof entry.k === 'string' &&
        /^[0-9a-f]{64}$/.test(entry.k) &&
        Number.isSafeInteger(entry.seq) &&
        entry.seq > 0 &&
        (entry.v === null || typeof entry.v === 'string') &&
        (entry.omitted === undefined || typeof entry.omitted === 'boolean'),
    )
  );
};

const boundAAD = (name: string, binding: string): Uint8Array<ArrayBuffer> =>
  utf8.encode(`${name}\u0000${binding}`);

/** A household member authorizes the first write that creates one of its profile activity libraries. */
function profileLibraryWriteHeaders(
  household: { readonly id: string; readonly member: string },
  profile: { readonly token: string },
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-den-library-token': profile.token,
    'x-den-library-member': `${household.id}:${household.member}`,
    'x-den-wire': '4',
    'x-den-wire-min': '4',
    'x-den-generation': '0',
  };
}

/** The highest library format this build reads and writes. */
export const WIRE = 4;

export { PRE_V4_BACKUP_ERROR } from './libraryErrors';

/** den-edge fenced this library against this older client (`426` plus a newer `x-den-wire-min`). */
export class LibraryUpdateRequiredError extends Error {
  constructor(readonly requiredWire: number) {
    super('A newer version of Den is required to open this library.');
    this.name = 'LibraryUpdateRequiredError';
  }
}

/**
 * What a move to another key carries (library v4 §12, `LibraryLog.moving`): the decoded rows, the plaintext of each
 * newer-format document, and the head and generation they were read at.
 */
export interface Moving {
  rows: Row[];
  kept: { name: string; plaintext: Uint8Array<ArrayBuffer> }[];
  head: number;
  generation: string | null;
  /** The device moving it. */
  device: string;
  /** The assistant grants the move revoked (assistant v1 §10), for that device's own revoked set. */
  revokedGrants: string[];
}

/** Why a move did not start: a row only a newer build can carry, or a library that can't be read or moved now. */
export type MoveRefusal = 'update_required' | 'unavailable' | 'profiles';

/**
 * How the end of a move went for the library it left (`endMoved`):
 * - `deleted`: by this move.
 * - `changed`: written to after the move read it; copy again first.
 * - `failed`: still there, and fenced against a late `DELETE`, so the new library can go.
 * - `lost`: another device's reset deleted it, naming its own successor; the new library is a copy nobody needs.
 * - `lost_unnamed`: deleted, naming no successor, so whose move it was can't be told; the new library stays.
 * - `unknown`: den-edge can't say yet; the new library, and the pending reset, stay.
 */
export type MoveEnd = 'deleted' | 'changed' | 'failed' | 'lost' | 'lost_unnamed' | 'unknown';

/**
 * What a key reset's `DELETE` names as its successor (`x-den-successor`), and den-edge's `410` names back: the
 * lowercase hex SHA-256 of the new library's id. The device that reset knows that id and can match it; nobody else
 * who reads the `410` learns the new id.
 */
export async function successorTag(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(id));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A `410`'s successor read against `tag`: no successor is never ours (it may be a marker den-edge couldn't read). */
function movedTo(moved: { successor?: string }, tag: string): MoveEnd {
  if (moved.successor === undefined) return 'lost_unnamed';
  return moved.successor === tag ? 'deleted' : 'lost';
}

/**
 * An old-format row in a restored backup. These are recognized only to refuse the restore read-only; this build no
 * longer projects or converts them.
 */
const preV4Row = (row: unknown): boolean => {
  if (!row || typeof row !== 'object') return false;
  const { kind, name, schema } = row as { kind?: unknown; name?: unknown; schema?: unknown };
  return (
    kind === 'rec' ||
    kind === 'ep' ||
    kind === 'wat' ||
    kind === 'snt' ||
    (kind === 'set' && typeof name === 'string' && name.startsWith('tracker-event:')) ||
    (schema === 1 && 'after' in row)
  );
};

/**
 * A legacy row that carries no edit at all. Old local builds could persist the blank row used to open a title or
 * episode; it has no watchlist, history, progress, reaction or tombstone to convert. Comparing it with the exact
 * blank through v4's operation builder is deliberately stricter than checking the visible values: a zero-valued
 * field with a real stamp is an un-watch or removal that must not be discarded.
 */
const emptyPreV4Row = (row: Row): boolean => {
  try {
    if (row.kind === 'rec') return opsFor(blankTitle(row.title, row.addedAt), row).length === 0;
    if (row.kind === 'ep')
      return opsFor(blankEpisode(row.title, row.season, row.episode), row).length === 0;
    return false;
  } catch {
    return false;
  }
};

/**
 * Filled in by a write: whether den-edge refused it for good (`failed`), rather than being out of reach, and whether
 * any of its rows were applied before that.
 */
interface Outcome {
  refused: boolean;
  applied?: boolean;
  /** Another device had written a document first, so what was drawn of this write was derived again on theirs. */
  merged?: boolean;
}

/** What an edit answered before it was sent came to (`LibraryLog.onDeferred`). */
export interface DeferredDelivery {
  /** `kept`: den-edge was out of reach, and the edit stays in this browser to be sent again. */
  outcome: 'sent' | 'kept' | 'refused';
  /** The rows this browser holds changed with it: a refusal taken back, or another device's edit merged in. */
  changed: boolean;
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

/**
 * A library kept whole, as rows and where in its log they were read to: one kept only here (`openLocal`), a first
 * read's pages so far (`PARTIAL`), or a copy an earlier build kept of one on den-edge (`convertSnapshot`).
 */
interface Snapshot {
  generation?: string;
  head: number;
  entries: [name: string, seq: number, row: Row][];
  /** Durable local revision; restoring the same rows must not look like a new authority revision. */
  rowsVersion?: number;
  /** A null document records a newer, correctly named directory that failed validation (fail closed offline too). */
  profileDirectory?: [seq: number, document: ProfileDirectoryDocument | null];
  kidTitleApprovals?: [kid: string, seq: number, document: KidTitleApprovalsDocument][];
  /**
   * The wire form of a library kept only here (`openLocal`), which has no den-edge to say it; absent means 2. One kept
   * on den-edge remembers den-edge's answer in the browser runtime vault instead.
   */
  wireMin?: number;
}

interface InvalidProfileDirectory {
  readonly invalidProfileDirectory: true;
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
  /** Settings rows sent in the same batch as `ops` (`LibraryLog.withRider`). */
  riders?: SettingsRow[];
  /** The generation a recovery was staged to be written back into (`stageRecovery`). */
  generation?: string;
}

/**
 * Under what `LibraryLog.keep` holds a library kept only here; a new format takes a new name, so an old copy is never
 * misread. Earlier builds kept a library on den-edge whole under it too, before v4.
 */
const SNAPSHOT = 'log.v1';
/** Where earlier builds kept a library on den-edge at v4 whole; `convertSnapshot` moves it into the fact store. */
const SNAPSHOT_V4 = 'log.v4';
/** The generation this browser's membership was registered under (`putMember`). */
const MEMBER = 'log-member.v1';
/** Unsealed existence marker for a browser-local library. It contains no key or library data. */
const LOCAL_LIBRARY = 'runtime:meta:local-library';

/**
 * Under what a first read of the log keeps the pages it has read so far, so a read cut off on a slow link goes on
 * from there on the next visit instead of from the start. Never opened as the library: it is not whole.
 */
const PARTIAL = 'log-partial.v1';

/** How long a log den-edge refused to start waits before its kept work is sent again (`refused`). */
const RECHECK_MS = 10 * 60_000;
/** How long kept work pauses after den-edge says an exclusive profile migration holds the household. */
const MIGRATION_RECHECK_MS = 60_000;

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
const text = new TextDecoder();

export class LibraryLog {
  private entriesVersion = 0;
  /** Each row as last read or written, by the name its key is the HMAC of. */
  private readonly entries = new ChangedMap<string, Entry>(() => this.entriesVersion++);
  /** Read-only household control state; it is never projected into an activity library. */
  private profileDirectoryEntry?: { seq: number; document: ProfileDirectoryDocument };
  /** Highest transport sequence seen for the control row, including an invalid replacement. */
  private profileDirectorySeq = 0;
  private readonly kidApprovalEntries = new Map<
    string,
    { seq: number; document: KidTitleApprovalsDocument }
  >();
  /** A page of den-edge's log was read in the generation it now answers at, by this instance (not only a kept copy). */
  private readCurrentGeneration = false;
  /** Projecting v4 documents allocates rows. Every consumer of one unchanged log shares the completed snapshot. */
  private rowsCache?: { version: number; at: number; reconsiderAt: number; rows: Row[] };
  /** One whole-log maximum, prepared with the sliced first projection and invalidated by every entries mutation. */
  private newestCache?: {
    version: number;
    at: number;
    stamp: Stamp;
    reconsiderAt: number;
  };
  /**
   * Each row exactly as den-edge last gave it or applied this browser's write of it, without this browser's unsent
   * edits: what the next visit starts from.
   */
  private readonly acknowledged = new Map<string, Entry>();
  /**
   * Names `acknowledged` took from this browser's own writes, with the generation they were written in, that the fact
   * store has yet to keep (`keepAcknowledged`). A read of the log keeps its rows itself (`keepFacts`).
   */
  private readonly unkept = new Map<string, string | undefined>();
  /** How many times `project` changed a row: `replay` says it changed what this browser holds by it. */
  private projected = 0;
  /** Kept work (`pendingPrefix`) being sent now, which `replay` leaves to that send. */
  private readonly flushing = new Set<string>();
  /** Told how each edit answered before it was sent came to end; the authority turns that into what the page sees. */
  onDeferred: ((delivery: DeferredDelivery) => void) | null = null;
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
  /** `observedGeneration` as this page set it. */
  private observed?: string;
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
  /** A restored pre-v4 backup is left untouched and read-only. */
  private preV4Backup = false;
  /** When `compact` last tried, so a refused one is not tried on every refresh. */
  private compactedAt = 0;
  /** Why den-core's compaction guard last refused to remove the unreadable rows (§4); delivery stays paused. */
  compactionRefused: string | null = null;
  /** `compactedKeys` as this page added to it. */
  private readonly compacted = new Set<string>();
  /** Vault-backed runtime work, mirrored so synchronous UI facts stay synchronous after async startup. */
  private readonly pending = new Map<string, string>();
  private runtimeVault: Vault | null;
  /** Individually retained authority and small selected facts; absent on storage adapters without atomic batches. */
  private factStore: LibraryFactStore | null = null;
  private runtimeFallback = false;
  private runtimeChannel?: BroadcastChannel;
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
   * When den-edge last refused an ordinary write with `409 migration_in_progress` (`Date.now()`), 0 for never or since
   * a write landed. An exclusive profile migration holds the household: nothing was applied, the write stays kept
   * (never `refusal`, which drops a fresh edit), and kept work waits `MIGRATION_RECHECK_MS` instead of being retried
   * on every refresh.
   */
  private migrationLockedAt = 0;
  /**
   * Until when den-edge has asked for no more batches (`429 rate_limited`, this library's write budget), as
   * `Date.now()`; 0 for never or since a write landed. Like a migration lock, nothing was applied and the write is
   * neither dropped nor resent on every refresh: kept work waits out the `Retry-After` it was given.
   */
  private throttledUntil = 0;
  /**
   * When den-edge last refused each piece of kept work for good (`failed`), by its key: a full library, a row it will
   * not take. That piece is sent again after `RECHECK_MS`, not on every refresh, where it was refused every 30 seconds
   * for as long as the tab stayed open; the rest of the kept work is sent as before.
   */
  private readonly rejected = new Map<string, number>();
  /** Opened from this browser's copy without asking den-edge: `refresh` brings it up to date. */
  fromCache = false;
  /**
   * A narrow log's (`openNarrow`): the newest stamp of the whole library it did not read. Its other rows are not here,
   * so it never keeps the finished-view marker, which is built from them.
   */
  private narrowNewest: Stamp | null = null;
  /** How many generation changes (library v2 §2) `refresh` has read and written back: a recovery reconcile follows each. */
  generationChanges = 0;
  /**
   * A `refresh` that answers whether this pass read den-edge's log to its head, in one generation, where "nothing new"
   * and "not read" differ: `refresh`'s own answer says only whether something changed, which is also false when
   * den-edge could not be read. The answer is this pass's own, never another caller's.
   */
  async readToHead(): Promise<boolean> {
    return (await this.pass()).reachedHead;
  }

  get wireMinimum(): number {
    return this.wireMin;
  }

  /**
   * An exclusive profile migration has held this household since a write last bounced off it (`409
   * migration_in_progress`). Reads and playback are unaffected; edits are kept on this device meanwhile.
   */
  get migrationLocked(): boolean {
    return this.migrationLockedAt > 0 && Date.now() - this.migrationLockedAt < MIGRATION_RECHECK_MS;
  }

  /** An Owner Restore aborted the migration attempt that held the household: its lock is gone. */
  noteMigrationReleased(): void {
    this.migrationLockedAt = 0;
  }

  /** Record what a refused split open or Restore already proved: another attempt holds the household lock. */
  noteMigrationLocked(): void {
    this.migrationLockedAt = Date.now();
  }

  /** den-edge's store generation as this browser last read it. */
  get currentGeneration(): string | undefined {
    return this.generation;
  }

  /**
   * The generation this browser last watched for ten minutes and then took a lease under (v3 §6 *Taking*), kept with
   * the library so a reload under it may take again at once. Any other generation is watched first.
   */
  get observedGeneration(): string | undefined {
    return this.observed;
  }

  set observedGeneration(generation: string | undefined) {
    this.observed = generation;
    if (generation) void this.putMeta('observed', generation);
  }

  /** Nothing is written when the library needs a newer build or a pre-v4 backup was restored. */
  get readOnly(): boolean {
    return this.upgradeRequired !== null || this.preV4Backup;
  }

  get readOnlyReason(): string | null {
    if (this.preV4Backup) return PRE_V4_BACKUP_ERROR;
    if (this.upgradeRequired !== null)
      return 'A newer version of Den is required to open this library.';
    return null;
  }

  private constructor(
    private readonly keys: LibraryKeys,
    private readonly fetchImpl: typeof fetch,
    private readonly storage?: Storage,
    private readonly local: { vault: Vault; key: CryptoKey } | null = null,
    /** A library that lives only in this browser (`openLocal`): nothing is asked of den-edge, or sent to it. */
    private readonly offline = false,
    vault: Vault | null = local?.vault ?? null,
    /** Per-instance protocol capability. Wire 5 still carries library-v4 encrypted rows. */
    private readonly instanceWire: LibraryWire = WIRE,
  ) {
    this.runtimeVault = vault;
  }

  private get runtimePrefix(): string {
    return `${this.keys.id}:runtime:`;
  }

  private get pendingPrefix(): string {
    return `${this.runtimePrefix}pending:`;
  }

  private get legacyPendingPrefix(): string {
    return `den.pendingTracker.${this.keys.id}.`;
  }

  private metaKey(name: string): string {
    return `${this.runtimePrefix}meta:${name}`;
  }

  private legacyMetaKey(name: 'observed' | 'wireMin' | 'compacted'): string {
    const part =
      name === 'observed' ? 'ObservedGeneration' : name === 'wireMin' ? 'WireMin' : 'Compacted';
    return `den.library${part}.${this.keys.id}`;
  }

  private legacyEntries(prefix: string): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    try {
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage!.key(index);
        if (!key?.startsWith(prefix)) continue;
        const value = this.storage!.getItem(key);
        if (value !== null) found.push([key, value]);
      }
    } catch {
      // Blocked storage contributes nothing; IndexedDB may still work.
    }
    return found;
  }

  /** Import old localStorage state write-before-delete, then initialize every synchronous runtime mirror. */
  private async initializeRuntime(): Promise<void> {
    let stored = new Map<string, string>();
    if (this.runtimeVault) {
      try {
        stored = new Map(
          (await this.runtimeVault.entries(this.runtimePrefix)).map(([key, value]) => [
            key,
            text.decode(value),
          ]),
        );
      } catch {
        // IndexedDB refused or disappeared. Preserve the former localStorage fallback for this visit.
        this.runtimeVault = null;
      }
    }
    if (!this.runtimeVault && this.storage)
      try {
        // Merely touching Storage can throw in a blocked/private frame.
        void this.storage.length;
        this.runtimeFallback = true;
      } catch {
        this.runtimeFallback = false;
      }
    const legacy: Array<[oldKey: string, newKey: string, value: string]> = [
      ...this.legacyEntries(this.legacyPendingPrefix).map(
        ([key, value]) =>
          [key, this.pendingPrefix + key.slice(this.legacyPendingPrefix.length), value] as [
            string,
            string,
            string,
          ],
      ),
      ...(['observed', 'wireMin', 'compacted'] as const).flatMap((name) => {
        const oldKey = this.legacyMetaKey(name);
        try {
          const value = this.storage?.getItem(oldKey);
          return value === null || value === undefined
            ? []
            : ([[oldKey, this.metaKey(name), value]] as Array<[string, string, string]>);
        } catch {
          return [];
        }
      }),
    ];
    for (const [oldKey, newKey, value] of legacy) {
      if (this.runtimeVault) {
        try {
          const existing = stored.get(newKey);
          let imported = existing ?? value;
          // These facts accumulate: a partially completed earlier import must not discard the stronger legacy fact.
          if (oldKey === this.legacyMetaKey('wireMin') && existing !== undefined)
            imported = String(Math.max(Number(existing) || 2, Number(value) || 2));
          else if (oldKey === this.legacyMetaKey('compacted') && existing !== undefined) {
            try {
              imported = JSON.stringify([
                ...new Set([
                  ...(JSON.parse(existing) as string[]),
                  ...(JSON.parse(value) as string[]),
                ]),
              ]);
            } catch {
              imported = existing;
            }
          }
          if (existing !== imported) {
            await this.runtimeVault.put(newKey, utf8.encode(imported));
            stored.set(newKey, imported);
          }
          this.storage?.removeItem(oldKey);
        } catch {
          // The old value remains authoritative until a later visit can import it.
          if (!stored.has(newKey)) stored.set(newKey, value);
        }
      } else stored.set(newKey, value);
    }
    this.installRuntime(stored);
    this.listenForRuntimeChanges();
  }

  private get runtimeAvailable(): boolean {
    return this.runtimeVault !== null || this.runtimeFallback;
  }

  private installRuntime(stored: ReadonlyMap<string, string>): void {
    this.pending.clear();
    for (const [key, value] of stored)
      if (key.startsWith(this.pendingPrefix)) this.pending.set(key, value);
    this.observed = stored.get(this.metaKey('observed'));
    const remembered = Number(stored.get(this.metaKey('wireMin')));
    if (Number.isInteger(remembered) && remembered >= 2) this.wireMin = remembered;
    if (this.wireMin > this.instanceWire) this.upgradeRequired = this.wireMin;
    try {
      const compacted = stored.get(this.metaKey('compacted'));
      if (compacted) for (const key of JSON.parse(compacted) as string[]) this.compacted.add(key);
    } catch {
      // Malformed optimization metadata is ignored; no library content depends on it.
    }
  }

  private listenForRuntimeChanges(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.runtimeChannel = new BroadcastChannel(`den-library-runtime:${this.keys.id}`);
      this.runtimeChannel.onmessage = (event: MessageEvent<{ key?: string; value?: string }>) => {
        const { key, value } = event.data ?? {};
        if (!key?.startsWith(this.runtimePrefix)) return;
        if (key.startsWith(this.pendingPrefix)) {
          if (value === undefined) this.pending.delete(key);
          else this.pending.set(key, value);
        } else if (key === this.metaKey('observed')) this.observed = value;
        else if (key === this.metaKey('wireMin')) {
          const minimum = Number(value);
          if (Number.isInteger(minimum) && minimum > this.wireMin) {
            this.wireMin = minimum;
            if (minimum > this.instanceWire) this.upgradeRequired = minimum;
          }
        } else if (key === this.metaKey('compacted') && value) {
          try {
            for (const compacted of JSON.parse(value) as string[]) this.compacted.add(compacted);
          } catch {
            /* Ignore malformed optimization metadata from another tab. */
          }
        }
      };
    } catch {
      // Live cross-tab hints are optional; startup and replay re-scan IndexedDB.
    }
  }

  private announceRuntime(key: string, value?: string): void {
    try {
      this.runtimeChannel?.postMessage({ key, value });
    } catch {
      // A later IndexedDB scan remains authoritative.
    }
  }

  private async putRuntime(key: string, value: string, legacyKey?: string): Promise<boolean> {
    try {
      if (this.runtimeVault) await this.runtimeVault.put(key, utf8.encode(value));
      else {
        const fallback = legacyKey;
        if (!fallback || !this.runtimeFallback || !this.storage) return false;
        this.storage.setItem(fallback, value);
      }
      this.announceRuntime(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private putMeta(name: 'observed' | 'wireMin' | 'compacted', value: string): Promise<boolean> {
    return this.putRuntime(this.metaKey(name), value, this.legacyMetaKey(name));
  }

  private async keepPending(key: string, value: string): Promise<boolean> {
    const legacyKey = this.legacyPendingPrefix + key.slice(this.pendingPrefix.length);
    if (!(await this.putRuntime(key, value, legacyKey))) return false;
    this.pending.set(key, value);
    return true;
  }

  /** Re-scan before replay so work written or removed by another tab is never hidden by the sync count mirror. */
  private async refreshPending(): Promise<void> {
    const found = new Map<string, string>();
    if (this.runtimeVault) {
      try {
        for (const [key, value] of await this.runtimeVault.entries(this.pendingPrefix))
          found.set(key, text.decode(value));
      } catch {
        return;
      }
    }
    for (const [key, value] of this.legacyEntries(this.legacyPendingPrefix))
      found.set(this.pendingPrefix + key.slice(this.legacyPendingPrefix.length), value);
    this.pending.clear();
    for (const [key, value] of found) this.pending.set(key, value);
  }

  private async discard(key: string): Promise<void> {
    const legacyKey = this.legacyPendingPrefix + key.slice(this.pendingPrefix.length);
    try {
      if (this.runtimeVault) await this.runtimeVault.delete(key);
      this.storage?.removeItem(legacyKey);
      this.pending.delete(key);
      this.announceRuntime(key);
    } catch {
      // Retrying accepted work is harmless; a later scan keeps counting it.
    }
  }

  private async forgetRuntime(): Promise<void> {
    try {
      await this.runtimeVault?.remove(`${this.keys.id}:`);
    } catch {
      // The library itself is already gone; stale encrypted cache is harmless and may be cleared later.
    }
    for (const [key] of this.legacyEntries(this.legacyPendingPrefix))
      try {
        this.storage?.removeItem(key);
      } catch {
        /* Blocked legacy storage is already unusable. */
      }
    for (const name of ['observed', 'wireMin', 'compacted'] as const)
      try {
        this.storage?.removeItem(this.legacyMetaKey(name));
      } catch {
        /* Blocked legacy storage is already unusable. */
      }
    this.pending.clear();
    this.runtimeChannel?.close();
    this.runtimeChannel = undefined;
  }

  /** Release runtime-only resources when a service authority gives up this log. */
  close(): void {
    this.runtimeChannel?.close();
    this.runtimeChannel = undefined;
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
    wire: LibraryWire = WIRE,
  ): Promise<LibraryLog | null> {
    return this.openLocalFromVault(libraryKey, vault, fetchImpl, true, wire);
  }

  /** Open only a browser-local library that was previously created in this vault. */
  static async openExistingLocal(
    libraryKey: string,
    vault: Vault | null = libraryVault,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    wire: LibraryWire = WIRE,
  ): Promise<LibraryLog | null> {
    return this.openLocalFromVault(libraryKey, vault, fetchImpl, false, wire);
  }

  private static async openLocalFromVault(
    libraryKey: string,
    vault: Vault | null,
    fetchImpl: typeof fetch,
    create: boolean,
    wire: LibraryWire,
  ): Promise<LibraryLog | null> {
    if (!vault) return null;
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const keys = await deriveKeys(raw);
    const marker = `${keys.id}:${LOCAL_LIBRARY}`;
    const registered = await vault.get(marker);
    if (!create && !registered) return null;
    if (create && !registered) await vault.put(marker, Uint8Array.of(1));
    const log = new LibraryLog(
      keys,
      fetchImpl,
      undefined,
      { vault, key: await libraryLocalKey(raw) },
      true,
      vault,
      wire,
    );
    await log.initializeRuntime();
    log.factStore = vault ? await LibraryFactStore.open(libraryKey, vault) : null;
    await ensureSyncPolicy();
    let saved = await log.kept<Snapshot>(SNAPSHOT);
    const legacyEntries = saved?.entries.filter(([, , row]) => preV4Row(row)) ?? [];
    const onlyBlankLegacyRows =
      !!saved &&
      legacyEntries.length > 0 &&
      !saved.profileDirectory &&
      !saved.kidTitleApprovals?.length &&
      legacyEntries.every(([, , row]) => emptyPreV4Row(row));
    if (saved && onlyBlankLegacyRows) {
      // These rows cannot affect a v4 library. Remove them once so every later launch opens directly in v4 without
      // asking the viewer to confirm data loss; compatible settings or documents beside them remain intact.
      saved = {
        ...saved,
        wireMin: WIRE,
        entries: saved.entries.filter(([, , row]) => !preV4Row(row)),
      };
      if (saved.entries.length) await log.keep(SNAPSHOT, saved);
      else {
        await vault.delete(`${keys.id}:${SNAPSHOT}`);
        saved = undefined;
      }
    }
    if (!saved?.entries.length) log.wireMin = WIRE;
    else if ((saved.wireMin ?? 2) < WIRE) log.preV4Backup = true;
    log.takeForm(saved);
    await inPolicySlices(saved?.entries ?? [], ([name, seq, row]) => {
      if (!wellFormed(row)) return;
      if (preV4Row(row)) {
        log.preV4Backup = true;
        return;
      }
      log.acknowledged.set(name, { seq, row });
      log.entries.set(name, { seq, row });
    });
    if (Number.isSafeInteger(saved?.rowsVersion) && saved!.rowsVersion! >= 0)
      log.entriesVersion = saved!.rowsVersion!;
    log.restoreProfileDirectory(saved);
    log.restoreKidTitleApprovals(saved);
    return log;
  }

  /** Take a newer saved protocol form before reading its rows. */
  private takeForm(saved: Snapshot | undefined): boolean {
    const form = saved?.wireMin;
    if (!Number.isInteger(form) || form! <= this.wireMin) return false;
    this.wireMin = form!;
    if (this.wireMin > this.instanceWire) this.upgradeRequired = this.wireMin;
    this.entries.clear();
    this.acknowledged.clear();
    return true;
  }

  /** Before a browser-local write, take a newer form saved by another tab. */
  private async followKeptForm(): Promise<void> {
    if (!this.offline) return;
    const saved = await this.kept<Snapshot>(SNAPSHOT);
    if (!this.takeForm(saved)) return;
    for (const [name, , row] of saved?.entries ?? []) {
      if (!wellFormed(row)) continue;
      if (preV4Row(row)) {
        this.preV4Backup = true;
        continue;
      }
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
    const next = await LibraryLog.open(libraryKey, this.fetchImpl, this.storage, this.runtimeVault);
    if (!next || next.moved || next.readOnly) return null;
    // A recovery code stays with the library it opens: none is copied into another (recovery-code §9).
    const rows = [...this.entries.values()]
      .map(({ row }) => row)
      .filter((row) => !(row.kind === 'set' && row.name === 'recovery'));
    return (await next.writeRows(rows)) ? next : null;
  }

  /** The rows, each merged over what the log already holds for it, written in batches. */
  async writeRows(rows: Row[]): Promise<boolean> {
    await ensureDeferredSyncPolicy();
    await this.followKeptForm();
    if (this.readOnly) return false;
    if (rows.some((row) => preV4Row(row) && row.kind === 'set')) {
      this.preV4Backup = true;
      return false;
    }
    const ops = rows.flatMap((row) =>
      row.kind === 'rec' || row.kind === 'ep' ? opsFor(this.storedBefore(row), row) : [],
    );
    const rest = rows.filter((row) => isDocument(row) || row.kind === 'set');
    if (this.offline) {
      // Kept once for the whole batch: each keep reads and rewrites every row the library holds, so keeping after each
      // row made an import of n rows cost n². Measured on a 2,000-row local library: 54 s, at batches of 100.
      for (const row of [...applyOps(ops, (name) => this.document(name)), ...rest])
        this.keepLocally(row, false);
      this.persist();
      // Kept once it is in this browser's store, which the next `openLocal` reads.
      await this.saving;
      return true;
    }
    const rowsWritten =
      !rest.length || (await this.flushRows(`den.writeRows.${crypto.randomUUID()}`, [rest]));
    const written = rowsWritten && (await this.writeOps(ops));
    // Bulk document writes are acknowledged directly by `flushRows`, unlike edits sent through `writeOps`. Keep
    // those acknowledgements before answering: a local-library merge is followed immediately by navigation, and a
    // return visit must not reopen the older fact-store cursor without the rows den-edge just accepted.
    this.persist();
    await this.saving;
    return written;
  }

  /**
   * Wait until this instance's durable copy includes every write it has already accepted. A browser-local library
   * is reopened from that copy when it is merged into a paired library, so the handoff must not race `persist`.
   */
  async settlePersistence(): Promise<void> {
    await this.saving;
    if (this.offline) this.dirty = true;
    if (!this.dirty) return;
    // Checkpoint the live local authority even when its earlier write was already kept. Another page authority can
    // have finished an older snapshot after this one opened; `persist` merges that copy under the cross-tab lock and
    // writes this authority's current rows back before the transfer reopens the source.
    this.persist();
    await this.saving;
    if (this.dirty) throw new Error('The library could not be kept for transfer');
  }

  /**
   * Every `k` this browser has removed by compaction, kept with the library: none is removed twice (§4). Null when
   * storage is blocked or absent (a private window): a new page there couldn't know what an earlier one removed.
   */
  private get compactedKeys(): Set<string> | null {
    if (this.runtimeVault) return new Set(this.compacted);
    if (!this.runtimeFallback || !this.storage) return null;
    try {
      const kept = this.storage.getItem(this.legacyMetaKey('compacted'));
      return new Set([...this.compacted, ...(kept ? (JSON.parse(kept) as string[]) : [])]);
    } catch {
      return null;
    }
  }

  private async rememberCompacted(keys: string[]) {
    for (const k of keys) this.compacted.add(k);
    if (this.runtimeVault)
      try {
        const held = await this.runtimeVault.get(this.metaKey('compacted'));
        if (held)
          for (const key of JSON.parse(text.decode(held)) as string[]) this.compacted.add(key);
      } catch {
        // `putMeta` below reports the persistence failure; this visit still remembers its own keys.
      }
    if (!(await this.putMeta('compacted', JSON.stringify([...this.compacted])))) {
      // Storage failed after the compaction: this page still remembers them.
      console.warn("den: the library rows removed by compaction couldn't be kept");
    }
  }

  /**
   * Library v4 §4 *Unreadable rows*: once the log is read to its head, a fenced rewrite at the same minimum that
   * stages every other row as it is stored, leaving out each row that **fails to open** at `base` — and only when
   * den-core's `compaction_guard` allows that many. A row that opens is exactly what some writer sealed: if this
   * build can't read it (`invalid_json`, `identity`, a den-core shape check), another may, so it is never removed and
   * delivery stays paused. Nor is a `k` this browser compacted before, so two builds can't remove and restore one row
   * in a loop. True when one was removed.
   */
  async compact(): Promise<boolean> {
    if (this.offline || this.wireMin < WIRE || !this.unreadable.size || this.readOnly) return false;
    if (Date.now() - this.compactedAt < RECHECK_MS) return false;
    await ensureDeferredSyncPolicy();
    this.compactedAt = Date.now();
    const compacted = this.compactedKeys;
    // Without storage this page can't know what an earlier page removed, so it removes nothing: compacting again
    // there would bring back the loop compacting each `k` once exists to stop.
    if (!compacted) {
      this.compactionRefused = 'storage_blocked';
      console.warn(
        `den: ${this.unreadable.size} library rows can't be read, and this browser can't remember compactions; not removing them, delivery stays paused`,
      );
      return false;
    }
    const removing = new Set(
      [...this.unreadable]
        .filter(([k, why]) => why === 'open' && !compacted.has(k))
        .map(([k]) => k),
    );
    if (!removing.size) {
      this.compactionRefused = 'rows_open';
      console.warn(
        `den: ${this.unreadable.size} library rows can't be read here but open, or were removed once already; not removing them, delivery stays paused`,
      );
      return false;
    }
    const removedKeys: string[] = [];
    const done = await this.fenced(async (_, raw) => {
      const writes: { k: string; v: string }[] = [];
      let removed = 0;
      for (const entry of raw) {
        if (removing.has(entry.k)) {
          const opened = await openEntry(this.keys, entry.k, entry.v);
          if ('unreadable' in opened && opened.unreadable === 'open') {
            console.warn(`den: removing the library row ${entry.k}, which fails to open`);
            removedKeys.push(entry.k);
            removed++;
            continue;
          }
          if (!('unreadable' in opened)) this.unreadable.delete(entry.k);
        }
        writes.push({ k: entry.k, v: entry.v });
      }
      if (!removed) return null;
      const verdict = syncPolicy<{ compact: boolean; reason?: string }>({
        op: 'compaction_guard',
        unreadable: removed,
        rows: raw.length,
      });
      if (!verdict.compact) {
        this.compactionRefused = verdict.reason ?? 'refused';
        console.warn(
          `den: ${removed} of ${raw.length} library rows can't be read; not removing them (${this.compactionRefused}), delivery stays paused`,
        );
        return null;
      }
      this.compactionRefused = null;
      return { writes, wireMin: this.wireMin };
    });
    if (done) await this.rememberCompacted(removedKeys);
    return done;
  }

  /**
   * One fenced rewrite: open it, read every row through its `base`, stage what `build` makes of them, and
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
        // Another device's rewrite or a restore since this browser read the log: read the new generation instead.
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
      await this.forgetRuntime();
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
      const gone = res.ok || res.status === 404;
      if (gone) await this.forgetRuntime();
      return gone;
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
   * Register, then reveal only the derived capability the page-side relay may use. The raw library key and the
   * broader read/write tokens never cross the LibraryService boundary.
   */
  async relayMembership(): Promise<LibraryRelayMembership | null> {
    if (this.offline || this.moved || this.refused) return null;
    await this.registerMember();
    if (!this.memberRegistered || this.moved || this.refused) return null;
    return { libraryId: this.keys.id, memberToken: this.keys.member };
  }

  /**
   * Worker-only compound key reset transport (profiles-v1 §9.1): exactly the reset routes of this library under its
   * own token and wire.
   */
  async resetRequest(input: {
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly path: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<{ readonly status: number; readonly body: unknown }> {
    const headers = input.headers ?? {};
    const route = profileResetRoute(this.keys.id, input.method, input.path);
    if (
      route === null ||
      !profileResetHeadersAllowed(route, headers) ||
      (input.body !== undefined) !== (route.kind === 'acquire' || route.kind === 'successor') ||
      (route.kind === 'retire' &&
        (typeof headers['x-den-exclusive-attempt'] !== 'string' ||
          typeof headers['x-den-successor'] !== 'string'))
    )
      throw new Error('Profile key reset method, path or header is not allowed');
    const extra: Record<string, string> = { ...headers };
    if (route.kind === 'retire') {
      const standing = await this.standing();
      if (standing === null) throw new Error('The library generation could not be read');
      if ('moved' in standing) return { status: 410, body: { error: 'library_moved' } };
      extra['x-den-generation'] = standing.generation ?? '0';
    }
    const response = await this.send(
      input.path,
      {
        method: input.method,
        headers: {
          ...this.headers(),
          ...extra,
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      },
      false,
    );
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      if (response.ok) throw new Error('Profile key reset response is not JSON');
    }
    return { status: response.status, body };
  }

  /**
   * Every row of this library to its head, each opened under its keys, for the reset's authenticated observations:
   * `absent` when the library does not exist, `moved` when it was retired, null when it could not be read, and a throw
   * for a row that does not open or a directory that violates its contract (a reset never proceeds on evidence it
   * cannot authenticate).
   */
  async resetSnapshot(): Promise<
    | 'absent'
    | 'moved'
    | {
        readonly base: number;
        readonly generation: string | null;
        readonly rows: ProfilesSnapshotRow[];
        /** The names of every row this build reads. */
        readonly names: string[];
        readonly directory: ProfileDirectoryDocument | null;
      }
    | null
  > {
    const entries: RawEntry[] = [];
    let since = 0;
    let generation: string | null = null;
    let head: number;
    for (;;) {
      const res = await this.send(
        `/lib/${this.keys.id}/changes?since=${since}&limit=1000`,
        { headers: this.headers() },
        false,
      );
      if (res.status === 404) return 'absent';
      if (res.status === 410) return 'moved';
      if (!res.ok) return null;
      const page = (await res.json()) as Page;
      generation ??= page.generation ?? res.headers.get('x-den-generation');
      if ((page.generation ?? generation) !== generation) return null;
      entries.push(...page.entries);
      head = page.head;
      if (!page.more || page.entries.length === 0) break;
      since = page.entries.at(-1)!.seq;
    }
    const rows = entries
      .map(({ k, v, seq }) => ({ k, v, seq }))
      .sort((left, right) => (left.k < right.k ? -1 : left.k > right.k ? 1 : 0));
    const names: string[] = [];
    let directory: ProfileDirectoryDocument | null = null;
    for (const { k, v } of rows) {
      const opened = await openEntry(this.keys, k, v);
      if ('unreadable' in opened)
        throw new Error(`Library row ${k} does not open (${opened.unreadable})`);
      if ('invalidProfileDirectory' in opened) throw new Error('The profile directory is invalid');
      if ('profileDirectory' in opened) directory = opened.profileDirectory;
      else if ('row' in opened) names.push(rowName(opened.row));
    }
    return { base: head, generation, rows, names, directory };
  }

  private async writeProfileLibrary(
    keys: LibraryKeys,
    writes: readonly { readonly k: string; readonly v: string }[],
  ): Promise<void> {
    // The first chunk creates the library at generation 0; each later chunk carries the generation den-edge answered.
    // A retried attempt finds the library already created, and den-edge's 409 names its generation.
    let generation = '0';
    for (const chunk of chunks(writes.map((write) => ({ ...write, base: 0 })))) {
      const post = () =>
        this.send(
          `/lib/${keys.id}/batch`,
          {
            method: 'POST',
            // NEW_LIBRARIES=members accepts an existing household member as the authority creating this library.
            headers: {
              ...profileLibraryWriteHeaders(this.keys, keys),
              'x-den-generation': generation,
            },
            body: JSON.stringify({ writes: chunk }),
          },
          false,
        );
      let response = await post();
      const current = response.headers.get('x-den-generation');
      if (response.status === 409 && current && current !== generation) {
        generation = current;
        response = await post();
      }
      if (!response.ok)
        throw new Error(
          `Profile library write was refused (${response.status} ${await response.text().catch(() => '')})`,
        );
      generation = response.headers.get('x-den-generation') ?? generation;
      const value = (await response.json()) as unknown;
      if (!responseBatch(value))
        throw new Error('Profile library write returned malformed evidence');
      const answer = value;
      if (answer.applied.length + answer.conflicts.length !== chunk.length)
        throw new Error('Profile library write was incomplete');
    }
  }

  private async readProfileLibrary(keys: LibraryKeys): Promise<RawEntry[]> {
    const rows: RawEntry[] = [];
    let since = 0;
    for (;;) {
      const response = await this.send(
        `/lib/${keys.id}/changes?since=${since}&limit=1000`,
        {
          headers: {
            'x-den-library-token': keys.token,
            'x-den-wire': String(WIRE),
            'x-den-generation': '0',
          },
        },
        false,
      );
      if (!response.ok) throw new Error('Profile library readback failed');
      const value = (await response.json()) as unknown;
      if (!responsePage(value)) throw new Error('Profile library readback was malformed');
      const page = value;
      rows.push(...page.entries);
      if (!page.more || page.entries.length === 0) return rows;
      since = page.entries.at(-1)!.seq;
    }
  }

  /** Fresh authenticated directory authority for den-core's Kid creation planner. */
  async readKidProfileDirectory(): Promise<{
    readonly directory: ProfileDirectoryDocument;
    readonly authority: ProfileDirectoryAuthority;
  }> {
    const snapshot = await this.readAll();
    if (!snapshot || !snapshot.generation)
      throw new Error('Profile-aware household could not be read to a stable generation');
    let found: { row: RawEntry; directory: ProfileDirectoryDocument } | undefined;
    for (const row of snapshot.entries) {
      const opened = await openEntry(this.keys, row.k, row.v);
      if ('invalidProfileDirectory' in opened) throw new Error('Profile directory is corrupt');
      if ('profileDirectory' in opened) found = { row, directory: opened.profileDirectory };
    }
    if (!found) throw new Error('Kid creation requires an active profile directory');
    this.acceptProfileDirectory(found.row, found.directory);
    return {
      directory: found.directory,
      authority: { base: found.row.seq, generation: snapshot.generation },
    };
  }

  /** Fresh, validated authority for one Kid's household approval document. */
  async readKidTitleApprovals(kid: string): Promise<{
    readonly directory: ProfileDirectoryDocument;
    readonly document: KidTitleApprovalsDocument | null;
    readonly base: number;
    readonly generation: string;
  }> {
    const snapshot = await this.readAll();
    if (!snapshot || !snapshot.generation)
      throw new Error('Profile-aware household could not be read to a stable generation');
    let directory: ProfileDirectoryDocument | undefined;
    let approval: { seq: number; document: KidTitleApprovalsDocument } | undefined;
    for (const row of snapshot.entries) {
      const opened = await openEntry(this.keys, row.k, row.v);
      if ('invalidProfileDirectory' in opened) throw new Error('Profile directory is corrupt');
      if ('profileDirectory' in opened) directory = opened.profileDirectory;
      if ('kidTitleApprovals' in opened && opened.kidTitleApprovals.kid === kid)
        approval = { seq: row.seq, document: opened.kidTitleApprovals };
    }
    if (!directory) throw new Error('Kid approvals require an active profile directory');
    const entry = directory.profiles[kid];
    if (!entry || entry.role !== 'kid' || entry.deleted.value)
      throw new Error('That is not a live Kid profile');
    let document: KidTitleApprovalsDocument | null = null;
    if (approval)
      try {
        document = validateKidTitleApprovals(approval.document, directory);
      } catch {
        // Preserve the invalid row's sequence so an Owner can repair it with an authoritative replacement.
      }
    if (document) this.acceptKidTitleApprovals({ seq: approval!.seq }, document);
    return { directory, document, base: approval?.seq ?? 0, generation: snapshot.generation };
  }

  /** Create an empty activity library and prove its only initial row decrypts exactly under the journal key. */
  async createAndVerifyKidProfileLibrary(journal: ProfileCreateJournal): Promise<void> {
    await this.createAndVerifyProfileLibrary(await this.kidProfileKeys(journal));
  }

  /** A profile library's first write, started under this household's member proof and read back exactly. */
  private async createAndVerifyProfileLibrary(keys: LibraryKeys): Promise<void> {
    const initial: SettingsRow = { kind: 'set', schema: 2, name: 'prefs', values: {} };
    const expected = await seal(keys, initial);
    await this.writeProfileLibrary(keys, [expected]);
    const rows = await this.readProfileLibrary(keys);
    if (rows.length !== 1 || rows[0]!.k !== expected.k)
      throw new Error('Profile activity library contains unexpected rows');
    const [wanted, actual] = await Promise.all([
      openPlaintext(keys, expected.k, expected.v),
      openPlaintext(keys, rows[0]!.k, rows[0]!.v),
    ]);
    if (
      wanted === null ||
      actual === null ||
      wanted.length !== actual.length ||
      wanted.some((byte, index) => byte !== actual[index])
    )
      throw new Error('Profile activity library readback did not match its initial row');
  }

  /**
   * Make this library a household born profile-aware in this browser (den#295), opened through `destination` at wire
   * 5. In order: its first write (an empty `set:prefs`) starts it at wire minimum 5; this browser registers as its
   * member; the Owner library is started under that membership, as a Kid's is; then the `profiles` directory goes in
   * by CAS. The directory is the same committed shape as every profile household, and its
   * evidence what this household really was: `source` the household before the directory (generation 0, its one
   * row), `ownerHead` the Owner library as read back. A born household has no backup, so `backup` names none
   * (`born`) and carries the source digest, the whole of what one would hold; a restore that looks it up finds
   * nothing and changes nothing. Every step is idempotent on `plan`, so a run cut off anywhere is finished by running
   * it again, and a household whose directory names this attempt is already done.
   */
  async createBornHousehold(plan: {
    readonly attempt: string;
    readonly ownerProfile: string;
    readonly ownerKey: string;
    readonly createdAt: number;
  }): Promise<void> {
    const owner = await libraryKeys(plan.ownerKey);
    let household = await this.readBornHousehold();
    if (household.kind === 'absent') {
      const first = await seal(this.keys, { kind: 'set', schema: 2, name: 'prefs', values: {} });
      const res = await this.send(`/lib/${this.keys.id}/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-den-library-token': this.keys.token,
          'x-den-wire': '5',
          'x-den-wire-min': '5',
          'x-den-generation': '0',
        },
        body: JSON.stringify({ writes: [{ ...first, base: 0 }] }),
      });
      // 409: a run cut off after the write landed, or another tab's run; either way the household is there.
      if (!res.ok && res.status !== 409)
        throw new LibraryStartRefused(res.status, await errorCode(res), retryAfterMs(res, 60_000));
      household = await this.readBornHousehold();
      if (household.kind === 'absent') throw new Error('The new household was not kept');
    }
    if (household.directory) {
      if (household.directory.migration.attempt !== plan.attempt)
        throw new Error('The household already holds another profile directory');
      return;
    }
    this.generation = household.generation;
    await this.registerMember();
    if (!this.memberRegistered) throw new Error('The household membership was not registered');
    await this.createAndVerifyProfileLibrary(owner);
    const ownerRows = await this.readProfileLibrary(owner);
    const ownerHead = profilesSnapshotDigest('owner', {
      libraryId: owner.id,
      base: ownerRows.at(-1)?.seq ?? 0,
      wireMin: WIRE,
      rows: ownerRows,
    });
    const source = profilesSnapshotDigest('source', {
      libraryId: this.keys.id,
      generation: 0,
      base: household.head,
      wireMin: 5,
      rows: household.entries,
    });
    const at: Stamp = [plan.createdAt, 0, plan.ownerProfile.slice(0, 16)];
    const { directory } = profilesConstructDirectory({
      attempt: plan.attempt,
      source: { generation: 0, head: source },
      backup: { id: 'born', digest: source },
      owner: {
        id: plan.ownerProfile,
        display: { value: { name: 'Owner' }, at },
        libraryKey: plan.ownerKey,
        libraryAt: at,
        policy: { value: { maximumAge: null, unknownRatings: 'allow' }, at },
        deletedAt: at,
      },
      ownerHead,
    });
    const outcome = await this.casKidProfileDirectory(
      { base: 0, generation: household.generation },
      directory as ProfileDirectoryDocument,
    );
    if (outcome === 'committed') return;
    const after = await this.readBornHousehold();
    if (after.kind === 'present' && after.directory?.migration.attempt === plan.attempt) return;
    throw new Error(`The household directory was not committed (${outcome})`);
  }

  /** This household from den-edge to its head, with its directory when it has one; `absent` before its first write. */
  private async readBornHousehold(): Promise<
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'present';
        readonly entries: RawEntry[];
        readonly head: number;
        readonly generation: string;
        readonly directory?: ProfileDirectoryDocument;
      }
  > {
    const standing = await this.send(`/lib/${this.keys.id}/changes?since=0&limit=1`, {
      headers: this.headers(),
    });
    if (standing.status === 404) return { kind: 'absent' };
    if (!standing.ok) throw new Error(`The household could not be read (${standing.status})`);
    const snapshot = await this.readAll();
    if (!snapshot?.generation) throw new Error('The household could not be read to its head');
    let directory: ProfileDirectoryDocument | undefined;
    for (const row of snapshot.entries) {
      const opened = await openEntry(this.keys, row.k, row.v);
      if ('invalidProfileDirectory' in opened) throw new Error('Profile directory is corrupt');
      if ('profileDirectory' in opened) directory = opened.profileDirectory;
    }
    return {
      kind: 'present',
      entries: snapshot.entries,
      head: snapshot.head,
      generation: snapshot.generation,
      ...(directory ? { directory } : {}),
    };
  }

  /** Exact `set:profiles` row CAS. A lost response is deliberately reported as unknown. */
  async casKidProfileDirectory(
    authority: ProfileDirectoryAuthority,
    directory: ProfileDirectoryDocument,
  ): Promise<'committed' | 'conflict' | 'unknown'> {
    const materialized = profilesMaterialize(directory);
    const write = await sealPlaintext(this.keys, 'profiles', fromBase64url(materialized.plaintext));
    let response: Response;
    try {
      response = await this.send(`/lib/${this.keys.id}/batch`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'x-den-wire': '5',
          'x-den-generation': authority.generation,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ writes: [{ ...write, base: authority.base }] }),
      });
    } catch {
      return 'unknown';
    }
    if (!response.ok) {
      if (response.status === 409 && (await errorCode(response)) === 'generation_changed')
        return 'conflict';
      throw new Error('Kid directory CAS was refused');
    }
    try {
      const value = (await response.json()) as unknown;
      if (!responseBatch(value)) return 'unknown';
      const applied = value.applied.find(({ k }) => k === write.k);
      if (applied) {
        this.acceptProfileDirectory({ seq: applied.seq }, materialized.directory);
        return 'committed';
      }
      if (value.conflicts.some(({ k }) => k === write.k)) return 'conflict';
      return 'unknown';
    } catch {
      // A successful response whose evidence was lost or malformed is ambiguous and must be reconciled by reread.
      return 'unknown';
    }
  }

  async casKidTitleApprovals(
    authority: { base: number; generation: string },
    document: KidTitleApprovalsDocument,
    directory: ProfileDirectoryDocument,
  ): Promise<'committed' | 'conflict' | 'unknown'> {
    const validated = validateKidTitleApprovals(document, directory);
    const write = await sealPlaintext(
      this.keys,
      kidApprovalName(validated.kid),
      utf8.encode(canonical(validated)),
    );
    let response: Response;
    try {
      response = await this.send(`/lib/${this.keys.id}/batch`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'x-den-wire': '5',
          'x-den-generation': authority.generation,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ writes: [{ ...write, base: authority.base }] }),
      });
    } catch {
      return 'unknown';
    }
    if (!response.ok) {
      if (response.status === 409 && (await errorCode(response)) === 'generation_changed')
        return 'conflict';
      throw new Error('Kid approval CAS was refused');
    }
    try {
      const value = (await response.json()) as unknown;
      if (!responseBatch(value)) return 'unknown';
      const applied = value.applied.find(({ k }) => k === write.k);
      if (applied) {
        this.acceptKidTitleApprovals({ seq: applied.seq }, validated);
        return 'committed';
      }
      if (value.conflicts.some(({ k }) => k === write.k)) return 'conflict';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Valid approvals projected only through the current live directory; malformed/stale documents approve none. */
  approvedTitleKeys(kid: string): string[] {
    const directory = this.profileDirectoryEntry?.document;
    const document = this.kidApprovalEntries.get(kid)?.document;
    if (!directory || !document) return [];
    try {
      return Object.entries(validateKidTitleApprovals(document, directory).approvals)
        .filter(([, approval]) => approval.value === 'allow')
        .map(([key]) => key);
    } catch {
      return [];
    }
  }

  /** Confirm candidate retirement with its owner token; ambiguous network outcomes remain retryable. */
  async retireKidProfileLibrary(journal: ProfileCreateJournal): Promise<boolean> {
    const keys = await this.kidProfileKeys(journal);
    try {
      const standing = await this.send(`/lib/${keys.id}/changes?since=0&limit=1`, {
        headers: {
          'x-den-library-token': keys.token,
          'x-den-wire': String(WIRE),
          'x-den-generation': '0',
        },
      });
      if (standing.status === 404 || standing.status === 410) return true;
      if (!standing.ok) return false;
      const page = (await standing.json()) as unknown;
      if (!responsePage(page)) return false;
      const generation = page.generation ?? standing.headers.get('x-den-generation');
      if (!generation) return false;
      const response = await this.send(`/lib/${keys.id}`, {
        method: 'DELETE',
        headers: {
          'x-den-library-token': keys.token,
          'x-den-wire': String(WIRE),
          'x-den-generation': generation,
        },
      });
      return response.ok || response.status === 404 || response.status === 410;
    } catch {
      return false;
    }
  }

  /**
   * This household's directory as den-edge holds it now: null for a household without profiles, `gone` when den-edge
   * holds no library under this key (never written, or retired).
   */
  async readDirectory(): Promise<ProfileDirectoryDocument | null | 'gone'> {
    const standing = await this.send(`/lib/${this.keys.id}/changes?since=0&limit=1`, {
      headers: this.headers(),
    });
    if (standing.status === 404 || standing.status === 410) return 'gone';
    if (!standing.ok) throw new Error(`The household could not be read (${standing.status})`);
    const household = await this.readBornHousehold();
    if (household.kind === 'absent') return 'gone';
    return household.directory ?? null;
  }

  /**
   * Every v4 document this library holds on den-edge, read to its head: its watch history, watchlist, progress and
   * ratings, which a household join carries into another household (den#295). `gone` when den-edge holds no library
   * under this key; null when it couldn't be read whole. A row this build can't read as a document, or a row in an
   * older form, also answers null: what isn't carried would be lost when the library is retired.
   */
  async activityDocuments(): Promise<{ documents: DocumentRow[]; head: number } | 'gone' | null> {
    try {
      const standing = await this.send(`/lib/${this.keys.id}/changes?since=0&limit=1`, {
        headers: this.headers(),
      });
      if (standing.status === 404 || standing.status === 410) return 'gone';
      if (!standing.ok) return null;
      const read = await this.readAll();
      if (!read) return null;
      // Keyed by name, so a row read twice is carried once, as its newest.
      const documents = new Map<string, DocumentRow>();
      for (const { k, v } of read.entries) {
        const opened = await openEntry(this.keys, k, v);
        if ('unknown' in opened || 'newerFraming' in opened) return null;
        if (!('row' in opened)) continue;
        if (opened.newer || preV4Row(opened.row)) return null;
        if (isDocument(opened.row)) documents.set(k, opened.row);
      }
      return { documents: [...documents.values()], head: read.head };
    } catch {
      return null;
    }
  }

  /**
   * Merge `documents` into this library and prove den-edge holds every one of them: a fresh read of each, merged
   * with what was sent, is what den-edge holds unchanged. Merging is den-core's, so sending them again changes nothing.
   */
  async takeDocuments(documents: DocumentRow[]): Promise<boolean> {
    if (!(await this.readToHead())) return false;
    if (documents.length && !(await this.writeRows(documents))) return false;
    const held = await this.activityDocuments();
    if (held === null || held === 'gone') return false;
    const byName = new Map(held.documents.map((document) => [rowName(document), document]));
    return documents.every((document) => {
      const current = byName.get(rowName(document));
      return !!current && canonical(mergeDocument(current, document)) === canonical(current);
    });
  }

  /**
   * Retire this library on den-edge under its own token: true once den-edge holds none under this key. With `base`,
   * only while its head is still that one (`409 head_changed` otherwise): what was written since was not carried.
   */
  async retire(base?: number): Promise<boolean> {
    try {
      const standing = await this.send(`/lib/${this.keys.id}/changes?since=0&limit=1`, {
        headers: this.headers(),
      });
      if (standing.status === 404 || standing.status === 410) return true;
      if (!standing.ok) return false;
      const page = (await standing.json()) as Page;
      const generation = page.generation ?? standing.headers.get('x-den-generation');
      if (generation) this.generation = generation;
      const response = await this.send(`/lib/${this.keys.id}`, {
        method: 'DELETE',
        headers: {
          ...this.headers(),
          ...(base === undefined ? {} : { 'x-den-base': String(base) }),
        },
      });
      return response.ok || response.status === 404 || response.status === 410;
    } catch {
      return false;
    }
  }

  async adoptKidProfileDirectory(directory: ProfileDirectoryDocument): Promise<void> {
    validateStoredProfileDirectory(directory);
    const current = await this.readKidProfileDirectory();
    const merged = profilesMerge(directory, current.directory);
    if (profilesMaterialize(merged).jcs !== profilesMaterialize(current.directory).jcs)
      throw new Error('Fresh household directory does not contain the created Kid');
  }

  /** Re-prove an acknowledged/replayed create result from the current authenticated directory. */
  async proveKidProfileResult(result: {
    readonly profile: string;
    readonly name: string;
    readonly maximumAge: number;
  }): Promise<void> {
    const current = await this.readKidProfileDirectory();
    const profile = current.directory.profiles[result.profile];
    if (
      !profile ||
      profile.role !== 'kid' ||
      profile.deleted.value ||
      profile.display.value.name !== result.name ||
      profile.policy.value.maximumAge !== result.maximumAge ||
      profile.policy.value.unknownRatings !== 'block'
    )
      throw new Error('Fresh household directory does not contain the created Kid');
  }

  private async kidProfileKeys(journal: ProfileCreateJournal): Promise<LibraryKeys> {
    return libraryKeys(journal.key);
  }

  /**
   * Library v4 §12: what a move of this library to another key carries, read from den-edge to its head. Every
   * document and settings row, decoded, to be sealed again under the destination's names; a document of a newer
   * `format` as its plaintext, unchanged. A row whose name this build can't rebuild — a newer framing, or a kind it
   * doesn't know — refuses the move (`update_required`), as does a restored pre-v4 backup. An
   * unreadable row is left behind: it can't be attributed to a name, and §4 removes it anyway. `set:recovery` stays
   * too: a recovery code wraps the old key, and a reset ends it (recovery-code §9). `set:devices` keeps only `device`
   * (the one moving it): every other device is cut off, and lists itself again once it pairs back in.
   */
  async moving(
    device: string,
    /**
     * The compound reset (profiles-v1 §9) moves a profile household whose valid directory row the caller replaces with
     * the successor directory: that row is then left behind rather than refusing the move. An invalid one still stops it.
     */
    options: { replaceProfileDirectory?: boolean } = {},
  ): Promise<Moving | { refused: MoveRefusal }> {
    if (this.offline || this.moved || this.wireMin < WIRE) return { refused: 'unavailable' };
    if (this.wireMin > Math.max(WIRE, this.instanceWire) || this.preV4Backup)
      return { refused: 'update_required' };
    await ensureDeferredSyncPolicy();
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
    const entries = await Promise.all(
      read.entries.map(async ({ k, v }) => ({ k, v, opened: await openEntry(this.keys, k, v) })),
    );
    // This fresh read, not an earlier projection, decides: a directory that appeared since still refuses, whatever
    // else the log holds. The profile libraries must rotate with the household (profiles-v1 §9), never alone.
    if (
      entries.some(({ opened }) =>
        options.replaceProfileDirectory
          ? 'invalidProfileDirectory' in opened
          : 'profileDirectory' in opened || 'invalidProfileDirectory' in opened,
      )
    ) {
      console.warn('den: a profile-aware household needs the compound key reset');
      return { refused: options.replaceProfileDirectory ? 'unavailable' : 'profiles' };
    }
    for (const { k, v, opened } of entries) {
      if ('profileDirectory' in opened || 'invalidProfileDirectory' in opened) continue;
      // A compound household reset deliberately drops title exceptions; they never acquire successor authority.
      if ('kidTitleApprovals' in opened) continue;
      if ('unknown' in opened || 'newerFraming' in opened) {
        console.warn(`den: the library row ${k} can't be moved by this build`);
        return { refused: 'update_required' };
      }
      if ('unreadable' in opened) {
        // Not attributable to a name, so not movable; §4 removes it anyway. It never blocks the move.
        console.warn(`den: the unreadable library row ${k} stays behind (${opened.unreadable})`);
        continue;
      }
      const row = opened.row;
      if (preV4Row(row)) return { refused: 'unavailable' };
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
    // Assistant v1 §10: no drop-box key is carried, and every grant goes revoked.
    const assistant = await resetAssistantRows(rows, Date.now());
    return {
      rows: assistant.rows,
      kept,
      head: read.head,
      generation: read.generation,
      device,
      revokedGrants: assistant.revoked,
    };
  }

  /**
   * Every row in the log to its head, as den-edge stores it; null when a page couldn't be read. `wire` overrides the
   * wire this instance speaks: a household at minimum 5 answers 426 to a read at 4.
   */
  private async readAll(wire?: number): Promise<{
    entries: RawEntry[];
    head: number;
    generation: string | null;
  } | null> {
    const entries: RawEntry[] = [];
    let since = 0;
    let generation: string | null = null;
    for (;;) {
      const res = await this.send(`/lib/${this.keys.id}/changes?since=${since}&limit=1000`, {
        headers: {
          ...this.headers(),
          ...(wire === undefined ? {} : { 'x-den-wire': String(wire) }),
        },
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
   * Every document and settings row den-edge holds for this library, read from the start to its head and opened.
   * What is really there, apart from anything this browser holds or still has to send, with how many live rows
   * den-edge holds (`entries`). Null when it could not be read whole.
   */
  async heldRows(): Promise<{ rows: Row[]; entries: number } | null> {
    if (this.offline) return null;
    let read: { entries: RawEntry[] } | null;
    try {
      read = await this.readAll(this.wireMin > WIRE ? this.wireMin : undefined);
    } catch {
      read = null;
    }
    if (!read) return null;
    const rows: Row[] = [];
    let entries = 0;
    for (const { k, v } of read.entries) {
      if (!v) continue;
      entries++;
      const opened = await openEntry(this.keys, k, v);
      if (!('row' in opened)) continue;
      rows.push(opened.row);
    }
    return { rows, entries };
  }

  /** How long den-edge last asked this library's writes to wait (`429` with `Retry-After`), or 0. */
  get retryAfterMs(): number {
    return Math.max(0, this.throttledUntil - Date.now());
  }

  /**
   * A library to move another into (§12), by its key: nothing is read or asked of den-edge until `takeMoved`, and the
   * relayed services' credential stays the current library's.
   */
  static async destination(
    libraryKey: string,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
    vault: Vault | null = libraryVault,
    wire: LibraryWire = WIRE,
  ): Promise<LibraryLog> {
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const log = new LibraryLog(await deriveKeys(raw), fetchImpl, storage, null, false, vault, wire);
    await log.initializeRuntime();
    return log;
  }

  /**
   * A library the compound key reset (profiles-v1 §9.1) reads, moves from or talks to under its own token, at the wire
   * its role requires. Unlike `open` it registers nothing, hands no relayed service its credential and writes nothing
   * to a library that holds a lock; one read teaches it the library's minimum so `moving` can decide.
   */
  static async forReset(
    libraryKey: string,
    wire: LibraryWire,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
    vault: Vault | null = libraryVault,
  ): Promise<LibraryLog> {
    const log = await LibraryLog.destination(libraryKey, fetchImpl, storage, vault, wire);
    const standing = await log.standing();
    // Requests that write (a member registration) carry the generation the library reports.
    if (standing && 'generation' in standing && standing.generation)
      log.generation = standing.generation;
    return log;
  }

  /**
   * Work this browser kept for this library and hasn't sent (`pendingPrefix`), sealed again under `to`'s key and
   * kept for it: after a key reset, an edit another tab saved here reaches the library under its new key. A piece
   * that doesn't open is left where it was.
   */
  async rekeyKept(to: LibraryLog): Promise<void> {
    await this.refreshPending();
    const reseal = (sealed: { k: string; v: string }[]) =>
      Promise.all(sealed.map(async ({ k, v }) => seal(to.keys, await open(this.keys, k, v))));
    for (const [key, encoded] of this.pending) {
      try {
        const pending = JSON.parse(encoded) as {
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
        const movedKey = to.pendingPrefix + key.slice(this.pendingPrefix.length);
        if (!(await to.keepPending(movedKey, JSON.stringify(moved))))
          throw new Error('destination runtime storage refused the pending edit');
        await this.discard(key);
      } catch (error) {
        console.warn('den: an unsent edit could not be moved to the new library key', error);
      }
    }
  }

  /**
   * The rows of a move (§12) written here: each re-sealed under this library's name for it and merged with this
   * library's version of that name; over 256 KiB merged, this library's version stands (§11). A newer-format document
   * goes as its plaintext and never over a version already here. The first write starts the library at minimum 4,
   * named by `member` — the library it moves from. True when every row is here.
   */
  async takeMoved(moving: Moving, member: string): Promise<boolean> {
    await ensureDeferredSyncPolicy();
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
            'x-den-wire-min': String(this.instanceWire),
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
            // Held as written, so copying again after a write to the old library sends only what changed.
            if (write.row) this.acknowledge(write.name, applied.seq, write.row);
            rows.delete(write.name);
            kept.delete(write.name);
            continue;
          }
          const conflict = batch.conflicts.find(({ k }) => k === write.k);
          if (!conflict || conflict.omitted || conflict.v === null) return false;
          if (write.name === 'profiles' && kept.has('profiles')) {
            // A repeated move finds the successor directory already written; it is the same document or a refusal.
            const theirs = await openPlaintext(this.keys, conflict.k, conflict.v);
            const ours = kept.get('profiles')!;
            if (!theirs || theirs.length !== ours.length || theirs.some((b, i) => b !== ours[i]))
              return false;
            kept.delete('profiles');
            continue;
          }
          // Another version is here: the next round merges onto it.
          const theirs = await this.readEntry({ k: conflict.k, v: conflict.v });
          if (
            !theirs ||
            this.isProfileDirectory(theirs) ||
            this.isKidTitleApprovals(theirs) ||
            this.isInvalidProfileDirectory(theirs)
          )
            return false;
          this.acknowledged.set(write.name, { seq: conflict.seq, row: theirs });
          this.unkept.set(write.name, this.generation);
        }
      }
    }
    return rows.size === 0 && kept.size === 0;
  }

  /**
   * The end of a move away from this library to `successor` (§12, v2 §1 step 3): deleted on den-edge, which retires
   * its id, so a device still holding its key gets `410 library_moved`. The `DELETE` names the head the move copied
   * through and the successor's tag; a den-edge that knows them refuses a write since (`409 head_changed`) and names
   * the tag in its `410`. Only a `200`, or den-edge naming this move's tag, is `deleted`; an answer that might have
   * come after the library was retired is never taken as a failure without asking den-edge where it stands (`MoveEnd`).
   */
  async endMoved(moving: Moving, successor: LibraryLog): Promise<MoveEnd> {
    const tag = await successorTag(successor.keys.id);
    const check = await this.standing();
    if (check === null) return 'failed';
    if ('moved' in check) return movedTo(check, tag);
    if (check.head !== moving.head || check.generation !== moving.generation) return 'changed';
    let res: Response | null = null;
    try {
      res = await this.send(`/lib/${this.keys.id}`, {
        method: 'DELETE',
        headers: {
          ...this.headers(),
          'x-den-generation': moving.generation ?? '0',
          'x-den-base': String(moving.head),
          'x-den-successor': tag,
        },
      });
    } catch {
      /* Whether it landed is read from den-edge below. */
    }
    if (res?.ok) return 'deleted';
    if (res?.status === 409) {
      const code = await errorCode(res);
      // Refused before anything changed: the copy goes again.
      if (code === 'head_changed' || code === 'generation_changed') return 'changed';
    }
    // Any other answer, or none, may have come after den-edge retired the library: what it says now decides.
    const after = await this.standing();
    if (after === null) return 'unknown';
    if ('moved' in after) return movedTo(after, tag);
    // Still here — but a DELETE held somewhere on the way could land later. Moving the head past `base` first means
    // it would be refused (`head_changed`), so the new library can go.
    return (await this.fence(moving.device)) ? 'failed' : 'unknown';
  }

  /**
   * A write that moves this library's head on — this device's `set:devices` entry stamped again — so that a key
   * reset's `DELETE` still on its way is refused. False when it couldn't be written.
   */
  async fence(device: string): Promise<boolean> {
    for (let round = 0; round < ROUNDS; round++) {
      const now = Date.now();
      const base: SettingsRow = this.settings('devices') ?? {
        kind: 'set',
        schema: 2,
        name: 'devices',
        values: {},
      };
      const row: SettingsRow = {
        ...base,
        values: {
          ...base.values,
          [`${device}.seen`]: { value: { int: now }, at: [now, 0, device] },
        },
      };
      if (await this.writeAt(row, this.seqOf('set:devices'))) return true;
    }
    return false;
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
  private keepLocally(row: Row, persist = true): Row {
    const name = rowName(row);
    const current = this.entries.get(name);
    const merged = current ? merge(current.row, row) : row;
    this.entries.set(name, { seq: 0, row: merged });
    this.acknowledged.set(name, { seq: 0, row: merged });
    this.dirty = true;
    if (persist) this.persist();
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
    wire: LibraryWire = WIRE,
  ): Promise<LibraryLog | null> {
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const keys = await deriveKeys(raw);
    const log = new LibraryLog(
      keys,
      fetchImpl,
      storage,
      vault && { vault, key: await libraryLocalKey(raw) },
      false,
      vault,
      wire,
    );
    await log.initializeRuntime();
    log.factStore = vault ? await LibraryFactStore.open(libraryKey, vault) : null;
    // Loads beside the first read, and is waited for outside the per-row tampering catches: a loader failure must
    // never skip valid rows.
    const policy = ensureSyncPolicy();
    void policy.catch(() => undefined);
    await log.convertSnapshot();
    const factManifest = await log.factStore?.manifest();
    if (factManifest?.complete) {
      await policy;
      if (await log.restoreFacts(factManifest.generation, factManifest.head)) {
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
    }
    // Registered once the first page names the generation (below): sent before it, the registration carries generation
    // 0 and den-edge refuses it for any library that exists.
    let credential = false;
    let since = 0;
    const partial = await log.kept<Snapshot>(PARTIAL);
    if (partial) {
      log.generation = partial.generation;
      log.head = since = partial.head;
      await inPolicySlices(partial.entries, ([name, seq, row]) => {
        if (!wellFormed(row)) return;
        log.acknowledged.set(name, { seq, row });
        log.entries.set(name, { seq, row });
      });
      log.restoreProfileDirectory(partial);
      log.restoreKidTitleApprovals(partial);
    }
    let firstPage = true;
    for (;;) {
      let res: Response;
      const askedAt = performance.now();
      try {
        res = await log.send(`/lib/${log.keys.id}/changes?since=${since}&limit=1000`, {
          headers: log.headers(),
        });
      } catch {
        return null;
      }
      await policy;
      if (firstPage) {
        firstPage = false;
        startupMark(
          'log first changes page',
          `status ${res.status} in ${Math.round(performance.now() - askedAt)}ms`,
        );
      }
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
      if (res.status === 426 && log.upgradeRequired !== null)
        throw new LibraryUpdateRequiredError(log.upgradeRequired);
      if (!res.ok) return null;
      let page: Page;
      try {
        page = (await res.json()) as Page;
      } catch {
        return null;
      }
      if (log.generation && page.generation && log.generation !== page.generation) {
        if (log.directoryCommitted) await log.adoptProfileDirectory();
        else if (!(await log.stageRecovery(page.generation))) return null;
        log.memberRegistered = false;
        // Registered under the generation it now reads: under the old one den-edge refuses it.
        log.generation = page.generation;
        await log.registerMember();
        log.head = since = 0;
        for (const entry of log.entries.values()) entry.seq = 0;
        log.resetProfileDirectory();
        log.kidApprovalEntries.clear();
        log.acknowledged.clear();
        continue;
      }
      log.generation = page.generation;
      log.readCurrentGeneration = true;
      if (!credential) {
        credential = true;
        // Register before exposing the proof to relayed requests.
        await log.registerMember();
        useLibraryCredential(keys);
      }
      const factEntries: LibraryFactEntry[] = [];
      let factProfileTopology = false;
      for (const entry of page.entries) {
        // Tampered with, sealed under another library's key, or newer than this build: not read as a row.
        const row = await log.readEntry(entry);
        if (!row) {
          factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
          continue;
        }
        if (log.isInvalidProfileDirectory(row)) {
          factProfileTopology = true;
          factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
          log.invalidateProfileDirectory(entry);
          continue;
        }
        if (log.isProfileDirectory(row)) {
          factProfileTopology = true;
          factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
          log.acceptProfileDirectory(entry, row);
          continue;
        }
        if (log.isKidTitleApprovals(row)) {
          factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
          log.acceptKidTitleApprovals(entry, row);
          continue;
        }
        factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row });
        const previous = log.entries.get(rowName(row));
        log.entries.set(rowName(row), {
          seq: entry.seq,
          row: previous ? merge(previous.row, row) : row,
        });
        log.acknowledged.set(rowName(row), { seq: entry.seq, row });
      }
      const pageHead = page.entries.at(-1)?.seq ?? page.head;
      const complete = !page.more || page.entries.length === 0;
      await log.keepFacts(page.generation, pageHead, factEntries, complete, factProfileTopology);
      log.head = pageHead;
      if (complete) {
        log.dirty = true;
        log.persist();
        log.forgetPartial();
        return log.restoreJournal();
      }
      // Do not ask for the next page until this one is durable. A TV may kill the Worker at any point; once the
      // following request starts, a restart must be able to resume at this page rather than decrypt it again.
      if (!(await log.keepPartial())) return null;
      since = page.entries.at(-1)?.seq ?? page.head;
    }
  }

  /** Every row, a v4 document shown as the title or season row it stands for (`projectDocument`). */
  rows(): Row[] {
    const version = this.entriesVersion;
    const now = Date.now();
    if (
      this.rowsCache?.version === version &&
      now >= this.rowsCache.at &&
      now < this.rowsCache.reconsiderAt
    )
      return this.rowsCache.rows;
    const rows = [...this.entries.values()].flatMap(({ row }) =>
      isDocument(row) ? projectDocument(row, now) : [row],
    );
    const { reconsiderAt } = this.currentSummary(now);
    this.rowsCache = { version, at: now, reconsiderAt, rows };
    return rows;
  }

  /** The v4 documents and settings exactly as this log holds them, for moving without a lossy projection. */
  storedRows(): Row[] {
    return [...this.entries.values()].map(({ row }) => row);
  }

  /** `rows`, staged across tasks so first projection cannot monopolize the main thread. */
  async rowsInSlices(options?: PolicySliceOptions): Promise<Row[] | null> {
    const version = this.entriesVersion;
    const now = Date.now();
    if (
      this.rowsCache?.version === version &&
      now >= this.rowsCache.at &&
      now < this.rowsCache.reconsiderAt
    )
      return this.rowsCache.rows;
    const source = [...this.entries.values()].map(({ row }) => row);
    if (options?.shouldContinue && !options.shouldContinue()) return null;
    const projected = await projectRowsInWorker(source, now);
    if (projected) {
      if (options?.shouldContinue && !options.shouldContinue()) return null;
      // The log is normally private until this finishes. If an unusual owner changed it meanwhile, retry the exact
      // current snapshot instead of publishing the stale structured clone the Worker finished. Time is part of that
      // snapshot too: a projection that crossed a future-stamp deadline must be repeated at the new policy instant.
      const completedAt = Date.now();
      if (
        version !== this.entriesVersion ||
        completedAt < projected.at ||
        completedAt >= projected.reconsiderAt
      )
        return this.rowsInSlices(options);
      this.newestCache = {
        version,
        at: projected.at,
        stamp: projected.stamp,
        reconsiderAt: projected.reconsiderAt,
      };
      this.rowsCache = {
        version,
        at: projected.at,
        reconsiderAt: projected.reconsiderAt,
        rows: projected.rows,
      };
      return projected.rows;
    }
    const rows: Row[] = [];
    let stamp = ZERO_STAMP;
    let reconsiderAt = Infinity;
    const completed = await inPolicySlices(
      this.entries.values(),
      ({ row }) => {
        rows.push(...(isDocument(row) ? projectDocument(row, now) : [row]));
        const summary = newestSummary(row, now);
        if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
        reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
      },
      options,
    );
    const completedAt = Date.now();
    if (
      completed &&
      version === this.entriesVersion &&
      completedAt >= now &&
      completedAt < reconsiderAt
    ) {
      this.newestCache = { version, at: now, stamp, reconsiderAt };
      this.rowsCache = { version, at: now, reconsiderAt, rows };
    }
    if (!completed) return null;
    if (version !== this.entriesVersion || completedAt < now || completedAt >= reconsiderAt)
      return this.rowsInSlices(options);
    return rows;
  }

  /** The log's head as last read (library v2 §2): what an assistant projection says it is as of (assistant v1 §15). */
  get logHead(): number {
    return this.head;
  }

  /** Moves on with every change to the rows held, a local edit's included: whether anything read from them may differ. */
  get rowsVersion(): number {
    return this.entriesVersion;
  }

  /** The individually retained authority that owns derived saved views, when storage supports it. */
  libraryFacts(): LibraryFactStore | null {
    return this.factStore;
  }

  /** Every v4 document as it is held, with the seq den-edge last gave it: what tracker delivery decides on (§9). */
  documents(): { seq: number; document: DocumentRow }[] {
    return [...this.entries.values()].flatMap(({ seq, row }) =>
      isDocument(row) ? [{ seq, document: row }] : [],
    );
  }

  /** The den-core-validated directory, when this library is already a profile-aware household. */
  profileDirectory(): ProfileDirectoryDocument | null {
    return this.profileDirectoryEntry?.document ?? null;
  }

  /**
   * Whether a `set:profiles` row has been seen, valid or not. An invalid authenticated replacement counts: the
   * single-library reset must never be the recovery path for a corrupt profile topology.
   */
  get profileTopologyPresent(): boolean {
    return this.profileDirectorySeq > 0;
  }

  /**
   * A browser that kept the household from before its split learns the committed wire minimum (its own, or from den-edge
   * answering 426) before it has read the household that holds the directory. No directory is then not evidence that
   * there isn't one: it is read once a page of the committed generation has been (`adoptProfileDirectory`).
   */
  get profileDirectoryPending(): boolean {
    return this.directoryCommitted && !this.readCurrentGeneration;
  }

  private document(name: string): DocumentRow | undefined {
    const row = this.entries.get(name)?.row;
    return row && isDocument(row) ? row : undefined;
  }

  /**
   * A stored row read as library v4 reads one (§4), keeping track of what can't be: an unreadable row by its `k`, to
   * be removed (`compact`); a newer framing or format, which stops this build writing. Null for a row not read.
   */
  private async readEntry(entry: {
    k: string;
    v: string;
  }): Promise<
    Row | ProfileDirectoryDocument | KidTitleApprovalsDocument | InvalidProfileDirectory | null
  > {
    const opened = await openEntry(this.keys, entry.k, entry.v);
    this.unreadable.delete(entry.k);
    this.newerFraming.delete(entry.k);
    if ('unreadable' in opened) {
      if (preV4Row(opened.json)) {
        this.preV4Backup = true;
        console.warn(`den: ${PRE_V4_BACKUP_ERROR}`);
        return null;
      }
      console.warn(`den: the library row ${entry.k} is unreadable (${opened.unreadable})`);
      this.unreadable.set(entry.k, opened.unreadable);
      return null;
    }
    if ('newerFraming' in opened) {
      this.newerFraming.add(entry.k);
      this.upgradeRequired ??= WIRE + 1;
      return null;
    }
    if ('unknown' in opened) {
      if (preV4Row(opened.unknown)) {
        this.preV4Backup = true;
        console.warn(`den: ${PRE_V4_BACKUP_ERROR}`);
      }
      return null;
    }
    if ('invalidProfileDirectory' in opened) return opened;
    if ('profileDirectory' in opened) return opened.profileDirectory;
    if ('kidTitleApprovals' in opened) return opened.kidTitleApprovals;
    if (preV4Row(opened.row)) {
      this.preV4Backup = true;
      console.warn(`den: ${PRE_V4_BACKUP_ERROR}`);
      return null;
    }
    this.noteFormat(opened.row);
    return believe(opened.row);
  }

  private isProfileDirectory(
    value: Row | ProfileDirectoryDocument | KidTitleApprovalsDocument | InvalidProfileDirectory,
  ): value is ProfileDirectoryDocument {
    return 'kind' in value && value.kind === 'profiles';
  }

  private isKidTitleApprovals(
    value: Row | ProfileDirectoryDocument | KidTitleApprovalsDocument | InvalidProfileDirectory,
  ): value is KidTitleApprovalsDocument {
    return 'kind' in value && value.kind === 'kid-title-approvals';
  }

  private isInvalidProfileDirectory(
    value: Row | ProfileDirectoryDocument | KidTitleApprovalsDocument | InvalidProfileDirectory,
  ): value is InvalidProfileDirectory {
    return 'invalidProfileDirectory' in value;
  }

  private acceptKidTitleApprovals(
    entry: { seq: number },
    document: KidTitleApprovalsDocument,
  ): boolean {
    const previous = this.kidApprovalEntries.get(document.kid);
    if (entry.seq <= (previous?.seq ?? 0)) return false;
    this.kidApprovalEntries.set(document.kid, { seq: entry.seq, document });
    this.entriesVersion++;
    return true;
  }

  private acceptProfileDirectory(
    entry: { seq: number },
    document: ProfileDirectoryDocument,
  ): boolean {
    if (entry.seq <= this.profileDirectorySeq) return false;
    this.profileDirectorySeq = entry.seq;
    this.profileDirectoryEntry = { seq: entry.seq, document };
    this.entriesVersion++;
    this.dirty = true;
    return true;
  }

  private invalidateProfileDirectory(entry: { seq: number }): boolean {
    if (entry.seq <= this.profileDirectorySeq) return false;
    this.profileDirectorySeq = entry.seq;
    this.profileDirectoryEntry = undefined;
    this.entriesVersion++;
    this.dirty = true;
    return true;
  }

  private resetProfileDirectory(): boolean {
    if (this.profileDirectorySeq === 0 && !this.profileDirectoryEntry) return false;
    this.profileDirectorySeq = 0;
    this.profileDirectoryEntry = undefined;
    this.entriesVersion++;
    this.dirty = true;
    return true;
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
  async refresh(waitSeconds = 0): Promise<boolean> {
    return (await this.pass(waitSeconds)).changed;
  }

  /** One `refresh` pass: whether it changed what this browser holds, and whether it read the log to its head. */
  private async pass(waitSeconds = 0): Promise<{ changed: boolean; reachedHead: boolean }> {
    // Nothing else writes a library kept only here but another tab, whose rows each save takes up (`takeKept`).
    if (this.offline) return { changed: false, reachedHead: false };
    const generationsBefore = this.generationChanges;
    // Null when den-edge couldn't be read (a page, or the rest of them); `unreported` keeps what the pages read did.
    // `missing` when den-edge holds no log for this library: nothing was read to a head.
    const run = this.writes.then(async (): Promise<'head' | 'missing' | null> => {
      try {
        for (;;) {
          const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
          const res = await this.send(
            `/lib/${this.keys.id}/changes?since=${this.head}&limit=1000${wait ? `&wait=${wait}` : ''}`,
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
            const lostDirectory = this.resetProfileDirectory();
            this.dirty = true;
            if (staged || lostDirectory) this.unreported = true;
            return 'missing'; // A first offline action must be able to create the log on reconnect: `replay` sends it.
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
            if (this.directoryCommitted) await this.adoptProfileDirectory();
            else if (!(await this.stageRecovery(page.generation))) return null;
            this.memberRegistered = false;
            // Registered under the generation it now reads: under the old one den-edge refuses it.
            this.generation = page.generation;
            this.writeGeneration = undefined;
            await this.registerMember();
            this.head = 0;
            for (const entry of this.entries.values()) entry.seq = 0;
            this.resetProfileDirectory();
            this.kidApprovalEntries.clear();
            this.acknowledged.clear();
            this.dirty = true;
            this.unreported = true;
            this.generationChanges++;
            continue; // Reread a restored store from zero; transport sequence is not a field timestamp.
          }
          this.generation = page.generation;
          // A retained wire-5 household starts with directory discovery pending until one current-generation page
          // has been read. Reaching that page resolves the profile view even when its rows and head are unchanged.
          if (this.profileDirectoryPending) this.unreported = true;
          this.readCurrentGeneration = true;
          this.writeGeneration = undefined;
          const factEntries: LibraryFactEntry[] = [];
          let factProfileTopology = false;
          for (const entry of page.entries) {
            // Unreadable rows are skipped individually, as on initial open.
            const row = await this.readEntry(entry);
            if (!row) {
              factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
              continue;
            }
            if (this.isInvalidProfileDirectory(row)) {
              factProfileTopology = true;
              factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
              if (this.invalidateProfileDirectory(entry)) this.unreported = true;
              continue;
            }
            if (this.isProfileDirectory(row)) {
              factProfileTopology = true;
              factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
              if (this.acceptProfileDirectory(entry, row)) this.unreported = true;
              continue;
            }
            if (this.isKidTitleApprovals(row)) {
              factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row: null });
              if (this.acceptKidTitleApprovals(entry, row)) this.unreported = true;
              continue;
            }
            const previous = this.entries.get(rowName(row));
            const merged = previous ? merge(previous.row, row) : row;
            // As den-edge holds it, like `acknowledged`: the next visit draws the work kept here over it again.
            factEntries.push({ k: entry.k, seq: entry.seq, value: entry.v, row });
            if (!previous || entry.seq > previous.seq) {
              this.entries.set(rowName(row), {
                seq: entry.seq,
                row: merged,
              });
              this.unreported = true;
            }
            // Compared with den-edge's own copy, not `entries`: this browser's write already carries its seq there.
            if (entry.seq > (this.acknowledged.get(rowName(row))?.seq ?? 0)) {
              this.acknowledged.set(rowName(row), { seq: entry.seq, row });
              this.dirty = true;
            }
          }
          const head = page.entries.at(-1)?.seq ?? page.head;
          await this.keepFacts(
            page.generation,
            head,
            factEntries,
            !page.more || page.entries.length === 0,
            factProfileTopology,
          );
          // The finished views' marker names the head: a pass that reads back only this browser's own writes changes no
          // row, and without this the marker stayed behind them.
          if (head !== this.head) this.dirty = true;
          this.head = head;
          if (!page.more || page.entries.length === 0) return 'head';
        }
      } catch {
        return null;
      }
    });
    this.writes = run.catch(() => null);
    const read = await run;
    if (read === null) return { changed: false, reachedHead: false };
    // A generation change in this pass is read from zero, but its write-back (`replay`, below) has yet to land: a
    // reader that must act on a current row waits for the next pass (recovery-code §7).
    const reachedHead = read === 'head' && this.generationChanges === generationsBefore;
    const changed = this.unreported;
    this.unreported = false;
    this.persist();
    // Rows that arrived may carry actions to project; with none, the projections already stand.
    if (changed) this.projectJournal();
    return { changed: (await this.replay()) || changed, reachedHead };
  }

  /**
   * `value`, kept in this browser under `name` for the next visit. Sealed under a key the library key derives, so it
   * is no more readable here than the log is on den-edge.
   */
  async keep(name: string, value: unknown): Promise<void> {
    if (!this.local) return;
    const bytes = await sealLibraryLocalValue(this.local.key, name, value);
    await this.local.vault.put(`${this.keys.id}:${name}`, bytes);
  }

  /** Migration state is security-critical and must never silently degrade to an in-memory credential. */
  async keepRequired(name: string, value: unknown, binding = ''): Promise<void> {
    if (!this.local) throw new Error('Encrypted library storage is unavailable');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: boundAAD(name, binding) },
      this.local.key,
      utf8.encode(JSON.stringify(value)),
    );
    const bytes = new Uint8Array(iv.length + sealed.byteLength);
    bytes.set(iv);
    bytes.set(new Uint8Array(sealed), iv.length);
    await this.local.vault.put(`${this.keys.id}:${name}`, bytes);
    if ((await this.keptRequired<unknown>(name, binding)).kind !== 'value')
      throw new Error('Encrypted library storage could not retain migration state');
  }

  /** Unlike ordinary cached `kept`, a corrupt migration value is distinct from a genuinely absent value. */
  async keptRequired<T>(
    name: string,
    binding = '',
  ): Promise<{ readonly kind: 'absent' } | { readonly kind: 'value'; readonly value: T }> {
    if (!this.local) throw new Error('Encrypted library storage is unavailable');
    const bytes = await this.local.vault.get(`${this.keys.id}:${name}`);
    if (bytes === undefined) return { kind: 'absent' };
    if (bytes.length < 13) throw new Error('Encrypted migration state is corrupt');
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(0, 12),
          additionalData: boundAAD(name, binding),
        },
        this.local.key,
        bytes.slice(12),
      );
      return { kind: 'value', value: JSON.parse(new TextDecoder().decode(plain)) as T };
    } catch {
      throw new Error('Encrypted migration state is corrupt');
    }
  }

  /** What `keep` kept under `name`; undefined when nothing was, or it doesn't open under this library's key. */
  async kept<T>(name: string, projectRows = false): Promise<T | undefined> {
    if (!this.local) return undefined;
    try {
      const bytes = await this.local.vault.get(`${this.keys.id}:${name}`);
      if (!bytes) return undefined;
      const opened = await openKeptInWorker<T>(
        this.local.key,
        name,
        bytes,
        name === SNAPSHOT,
        projectRows ? Date.now() : undefined,
      );
      if (opened !== undefined) return opened;
      return (await openLibraryLocalValue(this.local.key, name, bytes)) as T;
    } catch (error) {
      console.warn(`den: the kept ${name} could not be read`, error);
      return undefined;
    }
  }

  /**
   * Remove one exact Worker-owned value previously stored with `keep`. Migration credentials use this instead of
   * exposing the Vault (or its household-derived wrapping key) to a page-side adapter.
   */
  async discardKept(name: string): Promise<void> {
    if (!this.local) throw new Error('Encrypted library storage is unavailable');
    await this.local.vault.delete(`${this.keys.id}:${name}`);
  }

  /**
   * Keep what changed for the next visit; a failure only costs that visit a read of what changed since. Of a library on
   * den-edge, the rows its writes acknowledged go into the fact store (`keepAcknowledged`): a read of the log keeps
   * what it read itself, with its cursor (`keepFacts`). A library kept only here is saved whole by each tab that has
   * it open, so what another tab saved is merged in first (`takeKept`), under one lock per library where the browser
   * has `navigator.locks`.
   */
  private persist(): void {
    if (!this.dirty || !this.local) return;
    this.dirty = false;
    this.saving = this.saving
      .then(() =>
        this.offline
          ? exclusive(`den.library.${this.keys.id}`, async () => {
              await this.takeKept();
              const kept = this.snapshot();
              await (kept.entries.length || kept.profileDirectory
                ? this.keep(SNAPSHOT, kept)
                : this.local?.vault.remove(`${this.keys.id}:${SNAPSHOT}`));
            })
          : this.keepAcknowledged(),
      )
      .catch((error: unknown) => {
        this.dirty = true;
        console.warn('den: the library could not be kept for the next visit', error);
      });
  }

  /**
   * The rows acknowledged since the last keep (`unkept`), each as den-edge now holds it, read at their turn in
   * `saving`: a page `keepFacts` kept meanwhile is never overwritten by an older copy.
   */
  private async keepAcknowledged(): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    const names = [...this.unkept].flatMap(([name, at]) => (at === generation ? [name] : []));
    this.unkept.clear();
    try {
      if (this.factStore && names.length)
        await this.factStore.keepRows(
          generation,
          await Promise.all(
            names.map(async (name) => {
              const held = this.acknowledged.get(name);
              return {
                k: await rowKey(this.keys, name),
                seq: held?.seq ?? 0,
                value: '',
                row: held?.row ?? null,
              };
            }),
          ),
        );
    } catch (error) {
      for (const name of names) this.unkept.set(name, generation);
      throw error;
    }
  }

  /** Every row another tab kept of this library kept only here, merged with this tab's the way a write is merged. */
  private async takeKept(): Promise<void> {
    const saved = await this.kept<Snapshot>(SNAPSHOT);
    this.takeForm(saved);
    for (const [name, , row] of saved?.entries ?? []) {
      if (preV4Row(row)) {
        this.preV4Backup = true;
        continue;
      }
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
      entries: [...this.acknowledged].map(([name, { seq, row }]) => [name, seq, row]),
      rowsVersion: this.entriesVersion,
      ...(this.profileDirectorySeq > 0
        ? {
            profileDirectory: [
              this.profileDirectorySeq,
              this.profileDirectoryEntry?.document ?? null,
            ] as [number, ProfileDirectoryDocument | null],
          }
        : {}),
      ...(this.kidApprovalEntries.size
        ? {
            kidTitleApprovals: [...this.kidApprovalEntries].map(([kid, { seq, document }]) => [
              kid,
              seq,
              document,
            ]),
          }
        : {}),
      ...(this.offline && this.wireMin > 2 ? { wireMin: this.wireMin } : {}),
    };
  }

  /** Open the library from the fact store, this browser's one copy of it, without asking den-edge. */
  private async restoreFacts(generation: string, head: number): Promise<boolean> {
    if (!this.factStore) return false;
    try {
      this.generation = generation;
      this.head = head;
      this.memberRegistered = (await this.kept<string>(MEMBER)) === generation;
      let documents = false;
      for await (const { key, document } of this.factStore.documents(generation)) {
        noteLibraryHydrate();
        let value:
          | Row
          | ProfileDirectoryDocument
          | KidTitleApprovalsDocument
          | InvalidProfileDirectory
          | null = document.row;
        if (!value && document.value) value = await this.readEntry({ k: key, v: document.value });
        if (!value) continue;
        const entry = { seq: document.seq };
        if (this.isInvalidProfileDirectory(value)) {
          this.invalidateProfileDirectory(entry);
          continue;
        }
        if (this.isProfileDirectory(value)) {
          this.acceptProfileDirectory(entry, value);
          continue;
        }
        if (this.isKidTitleApprovals(value)) {
          this.acceptKidTitleApprovals(entry, value);
          continue;
        }
        if (!wellFormed(value)) return false;
        if (preV4Row(value)) {
          this.preV4Backup = true;
          continue;
        }
        this.noteFormat(value);
        documents ||= isDocument(value);
        const name = rowName(value);
        this.entries.set(name, { seq: document.seq, row: value });
        this.acknowledged.set(name, { seq: document.seq, row: value });
      }
      if (documents && this.wireMin < WIRE) this.wireMin = WIRE;
      return true;
    } catch (error) {
      console.warn('den: individual library authority could not be opened', error);
      this.entries.clear();
      this.acknowledged.clear();
      this.resetProfileDirectory();
      this.kidApprovalEntries.clear();
      this.head = 0;
      this.generation = undefined;
      this.memberRegistered = false;
      return false;
    }
  }

  /**
   * A log of `names` alone, read from the fact store, for one edit of those documents rather than an open of the whole
   * library: each row it writes is read here first, and it stamps after every row the store holds (its manifest's
   * `newest`). Null wherever that is not enough, and the whole log is opened instead: no complete store, a profile
   * directory, kept work, a library not known to be v4 or not yet registered here, a stamp still ahead of this clock,
   * or a row of an earlier or newer format. It never reads the rest of the library or keeps the finished-view marker.
   */
  static async openNarrow(
    libraryKey: string,
    names: readonly string[],
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    vault: Vault | null = libraryVault,
    wire: LibraryWire = WIRE,
  ): Promise<LibraryLog | null> {
    if (!vault) return null;
    const raw = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
    const keys = await deriveKeys(raw);
    const log = new LibraryLog(
      keys,
      fetchImpl,
      typeof localStorage === 'undefined' ? undefined : localStorage,
      { vault, key: await libraryLocalKey(raw) },
      false,
      vault,
      wire,
    );
    await log.initializeRuntime();
    if (log.wireMin < WIRE || log.pending.size || log.readOnly) return null;
    const store = await LibraryFactStore.open(libraryKey, vault);
    const manifest = await store?.manifest();
    if (!store || !manifest?.complete || manifest.profileTopology || !manifest.newest) return null;
    const { stamp, reconsiderAt } = manifest.newest;
    if (reconsiderAt !== null && Date.now() >= reconsiderAt) return null;
    if ((await log.kept<string>(MEMBER)) !== manifest.generation) return null;
    await ensureSyncPolicy();
    for (const name of names) {
      const k = await rowKey(keys, name);
      const stored = await store.document(manifest.generation, k);
      if (!stored) continue;
      const value =
        stored.row ?? (stored.value ? await log.readEntry({ k, v: stored.value }) : null);
      if (
        !value ||
        log.isProfileDirectory(value) ||
        log.isKidTitleApprovals(value) ||
        log.isInvalidProfileDirectory(value)
      )
        return null;
      const row = value;
      if (!wellFormed(row) || !isDocument(row) || row.format > 4) return null;
      log.entries.set(name, { seq: stored.seq, row });
      log.acknowledged.set(name, { seq: stored.seq, row });
    }
    log.factStore = store;
    log.generation = manifest.generation;
    log.head = manifest.head;
    log.memberRegistered = true;
    log.fromCache = true;
    log.narrowNewest = stamp;
    useLibraryCredential(keys);
    return log;
  }

  /**
   * A library an earlier build kept whole (`SNAPSHOT_V4`, or `SNAPSHOT` before v4) moves into the fact store, once:
   * the store starts over as that copy, one complete generation at its head, and the copy goes once the store's cursor
   * says so. A copy holding the profile directory or a Kid's approvals cannot move: it kept them opened, where the
   * store keeps den-edge's sealed rows. Then, and if the move fails, the store is emptied too, and this open reads
   * den-edge from the start.
   */
  private async convertSnapshot(): Promise<void> {
    const local = this.local;
    if (!local) return;
    const saved = (await this.kept<Snapshot>(SNAPSHOT_V4)) ?? (await this.kept<Snapshot>(SNAPSHOT));
    // A copy with no generation is no copy of den-edge's: it is a library kept only here (`openLocal`), never removed.
    if (!saved?.generation) return;
    const store = this.factStore;
    try {
      const generation = saved.generation;
      if (!store) return;
      await store.clear();
      if (saved.profileDirectory || saved.kidTitleApprovals?.length) return;
      const rows = saved.entries.filter(([, , row]) => {
        if (!wellFormed(row)) return false;
        if (preV4Row(row)) {
          this.preV4Backup = true;
          return false;
        }
        return true;
      });
      const batchSize = 64;
      for (let offset = 0; offset === 0 || offset < rows.length; offset += batchSize) {
        const slice = rows.slice(offset, offset + batchSize);
        const last = offset + batchSize >= rows.length;
        const entries = await Promise.all(
          slice.map(async ([name, seq, row]) => ({
            k: await rowKey(this.keys, name),
            seq,
            value: '',
            row,
          })),
        );
        // Until the last batch the cursor stays at 0: a move cut off resumes as a first read, never above a row.
        await store.commitBatch(generation, last ? saved.head : 0, entries, last, {
          retainEpisodeProjection: true,
        });
      }
      const manifest = await store.manifest();
      if (!manifest?.complete || manifest.generation !== generation || manifest.head !== saved.head)
        throw new Error('the moved copy does not read back at its head');
    } catch (error) {
      console.warn('den: the library kept whole could not be moved into the fact store', error);
      await store?.clear().catch(() => undefined);
    } finally {
      await Promise.all(
        [SNAPSHOT, SNAPSHOT_V4].map((name) => local.vault.delete(`${this.keys.id}:${name}`)),
      ).catch((error: unknown) =>
        console.warn('den: the library kept whole could not be removed', error),
      );
    }
  }

  /**
   * Keep one fetched page in bounded atomic batches, in turn with `persist`'s; failure only costs the next visit a
   * read of what changed since the store's cursor.
   */
  private keepFacts(
    generation: string | undefined,
    head: number,
    entries: readonly LibraryFactEntry[],
    complete: boolean,
    profileTopology = false,
  ): Promise<void> {
    this.saving = this.saving.then(() =>
      this.commitFacts(generation, head, entries, complete, profileTopology),
    );
    return this.saving;
  }

  private async commitFacts(
    generation: string | undefined,
    head: number,
    entries: readonly LibraryFactEntry[],
    complete: boolean,
    profileTopology: boolean,
  ): Promise<void> {
    if (!this.factStore || !generation) return;
    try {
      const batchSize = 64;
      if (!entries.length) {
        await this.factStore.commitBatch(generation, head, [], complete, { profileTopology });
        return;
      }
      for (let offset = 0; offset < entries.length; offset += batchSize) {
        const batch = entries.slice(offset, offset + batchSize);
        const last = offset + batch.length === entries.length;
        await this.factStore.commitBatch(
          generation,
          last ? head : batch.at(-1)!.seq,
          batch,
          complete && last,
          { profileTopology, retainEpisodeProjection: true },
        );
      }
    } catch (error) {
      console.warn('den: incremental library facts could not be kept', error);
      this.factStore = null;
    }
  }

  private restoreProfileDirectory(snapshot: Snapshot | undefined): void {
    if (!snapshot?.profileDirectory) return;
    try {
      const [seq, document] = snapshot.profileDirectory;
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      this.profileDirectorySeq = seq;
      this.profileDirectoryEntry = document
        ? { seq, document: validateStoredProfileDirectory(document) }
        : undefined;
    } catch {
      // A damaged local cache is not a directory. The encrypted household row remains authoritative.
      this.profileDirectorySeq = 0;
      this.profileDirectoryEntry = undefined;
    }
  }

  private restoreKidTitleApprovals(snapshot: Snapshot | undefined): void {
    const directory = this.profileDirectoryEntry?.document;
    if (!directory) return;
    for (const candidate of snapshot?.kidTitleApprovals ?? []) {
      try {
        const [kid, seq, stored] = candidate;
        if (!Number.isSafeInteger(seq) || seq < 0 || stored.kid !== kid) continue;
        const document = validateKidTitleApprovals(stored, directory);
        this.kidApprovalEntries.set(kid, { seq, document });
      } catch {
        // Damaged or stale cached control state approves nothing; den-edge remains authoritative.
      }
    }
  }

  /** The pages a first read has read so far (`PARTIAL`); a failure only costs the next visit those pages. */
  private async keepPartial(): Promise<boolean> {
    if (!this.local) return true;
    const snapshot = this.snapshot();
    let kept = true;
    this.saving = this.saving
      .then(() => this.keep(PARTIAL, snapshot))
      .catch((error: unknown) => {
        kept = false;
        console.warn('den: the partial library import could not be kept', error);
      });
    await this.saving;
    return kept;
  }

  private forgetPartial(): void {
    const local = this.local;
    if (!local) return;
    this.saving = this.saving
      .then(() => local.vault.remove(`${this.keys.id}:${PARTIAL}`))
      .catch(() => undefined);
  }

  title(ref: { type: string; id: number }): TitleRow | undefined {
    return titleRow((name) => this.entries.get(name)?.row, ref);
  }

  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined {
    return episodeRow((name) => this.entries.get(name)?.row, ref, season, episode);
  }

  /** A group of settings: the TV's `prefs`, the user's API `keys`. */
  settings(name: string): SettingsRow | undefined {
    const row = this.entries.get(`set:${name}`)?.row;
    return row?.kind === 'set' ? row : undefined;
  }

  /** The settings document last authenticated from den-edge, excluding this browser's durable unsent projection. */
  acknowledgedSettings(name: string): SettingsRow | undefined {
    const row = this.acknowledged.get(`set:${name}`)?.row;
    return row?.kind === 'set' ? row : undefined;
  }

  /** The newest stamp read, so this browser's next edit is stamped after everything it has seen. */
  newestStamp(now = Date.now()): Stamp {
    return this.currentSummary(now).stamp;
  }

  /** Stamp summary paired with the instant at which future document stamps must be reconsidered. */
  currentSummary(now = Date.now()): { stamp: Stamp; reconsiderAt: number; at: number } {
    const cached = this.newestCache;
    if (
      cached &&
      cached.version === this.entriesVersion &&
      now >= cached.at &&
      now < cached.reconsiderAt
    )
      return { stamp: cached.stamp, reconsiderAt: cached.reconsiderAt, at: cached.at };
    let latest = this.narrowNewest ?? ZERO_STAMP;
    let reconsiderAt = Infinity;
    for (const { row } of this.entries.values()) {
      const summary = newestSummary(row, now);
      if (compareStamps(summary.stamp, latest) > 0) latest = summary.stamp;
      reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
    }
    this.newestCache = { version: this.entriesVersion, at: now, stamp: latest, reconsiderAt };
    return { stamp: latest, reconsiderAt, at: now };
  }

  /**
   * Write a row, based on the sequence last seen for it. When another device wrote it first, their row comes back:
   * ours is merged on top of it and written again. Resolves to the row as stored, or null when it couldn't be saved
   * — `moved` says when that is because the library moved to a new key.
   */
  async write(local: Row, outcome?: Outcome, durable = true): Promise<Row | null> {
    await ensureDeferredSyncPolicy();
    await this.followKeptForm();
    if (this.readOnly) return null;
    if (local.kind !== 'set') {
      if (local.kind !== 'rec' && local.kind !== 'ep') return null;
      if (this.offline) {
        const before = this.before(local);
        for (const document of applyOps(opsFor(before, local), (name) => this.document(name)))
          this.keepLocally(document, false);
        this.persist();
        await this.saving;
        return local;
      }
      return this.writeEdit(this.before(local), local, outcome, durable);
    }
    let kept: string | undefined;
    if (durable && !this.offline && this.runtimeAvailable) {
      kept = this.pendingPrefix + 'rows:' + crypto.randomUUID();
      if (!(await this.keepPending(kept, JSON.stringify({ rows: [await seal(this.keys, local)] }))))
        return null;
    }
    const result = outcome ?? { refused: false };
    const run = this.writes.then(() => this.writeSerial(local, result));
    this.writes = run.catch(() => null);
    const saved = await run;
    if (!saved && result.refused && this.refusal === 'profile_scoped') {
      // A profile library's row: no later send to the household takes it, so it is neither kept nor drawn.
      if (kept) await this.discard(kept);
      return null;
    }
    if (saved) {
      // A return visit opens the acknowledged copy before it reaches den-edge. Keep the applied row there before
      // dropping its recovery copy, or an immediate reload briefly restores the older row and an offline reload loses
      // the edit altogether.
      this.persist();
      await this.saving;
      if (kept) await this.discard(kept);
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
    if (!(await this.writeOps(opsFor(before, after), outcome, durable, undefined, true)))
      return null;
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
   *
   * `answerFirst`, for one edit made by hand: once it is kept it answers, drawn, and is sent after. The round trip to
   * den-edge is all of the wait, and the edit is no less safe for it — a send that does not get through is sent
   * again, as work kept from before is. What the send comes to is told to `onDeferred`, and a refusal for good takes
   * the edit back out.
   */
  private async writeOps(
    ops: Op[],
    outcome: Outcome = { refused: false },
    durable = true,
    key?: string,
    answerFirst = false,
    riders: SettingsRow[] = [],
  ): Promise<boolean> {
    if (!ops.length && !riders.length) return true;
    // A rider (`withRider`) goes with the first edit made by hand while it waits, never with kept work sent again.
    if (answerFirst && !key && ops.length && this.rider) {
      riders = [...riders, this.rider];
      this.rider = null;
    }
    let kept = key;
    if (!kept && durable && this.runtimeAvailable) {
      kept = this.pendingPrefix + 'ops:' + crypto.randomUUID();
      const work = {
        ops: await this.sealKept(ops),
        ...(riders.length
          ? { riders: await Promise.all(riders.map((row) => seal(this.keys, row))) }
          : {}),
      };
      if (!(await this.keepPending(kept, JSON.stringify(work)))) return false;
      if (answerFirst) {
        this.projectOps(ops);
        for (const row of riders) this.project(row);
        this.flushing.add(kept);
        void this.deliverOps(ops, outcome, kept, undefined, true, riders)
          .then((result) => this.settleDeferred(ops, outcome, result))
          .catch((error: unknown) =>
            console.error('den: a library write could not be settled', error),
          );
        return true;
      }
    }
    const result = await this.deliverOps(ops, outcome, kept, key, false, riders);
    // Kept: saved, for a fresh edit; still waiting, for kept work sent again.
    return result === 'sent' || (result === 'kept' && !key);
  }

  /**
   * Send `ops` and settle the work kept for them: `sent` and gone from this browser, `refused` for good, or `kept`
   * because den-edge was out of reach (`lost` when there was nowhere to keep it). `drawn`: already shown.
   */
  private async deliverOps(
    ops: Op[],
    outcome: Outcome,
    kept: string | undefined,
    key: string | undefined,
    drawn: boolean,
    riders: SettingsRow[] = [],
  ): Promise<'sent' | 'refused' | 'kept' | 'lost'> {
    if (kept) this.flushing.add(kept);
    const run = this.writes.then(() => this.sendOps(ops, outcome, riders));
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
        await this.discard(kept);
        this.rejected.delete(kept);
      }
      return 'sent';
    }
    if (outcome.refused) {
      // A fresh edit refused for good is not kept to be refused again; one kept from before waits `RECHECK_MS`, unless
      // it belongs to a profile library, which no wait changes.
      if (key && this.refusal !== 'profile_scoped') this.rejected.set(key, Date.now());
      else if (key) await this.discard(key);
      else if (kept) await this.discard(kept);
      return 'refused';
    }
    if (!kept) return 'lost';
    if (!drawn) this.projectOps(ops);
    return 'kept';
  }

  /**
   * An edit answered before it was sent has been sent, or kept, or refused for good: the last takes what was drawn of
   * it back to what den-edge holds, and draws the work still kept over that, so a row is never left showing a write
   * that is nowhere.
   */
  private async settleDeferred(
    ops: Op[],
    outcome: Outcome,
    result: 'sent' | 'refused' | 'kept' | 'lost',
  ): Promise<void> {
    if (result === 'refused') {
      for (const name of touched(ops)) {
        const held = this.acknowledged.get(name);
        if (held) this.entries.set(name, held);
        else this.entries.delete(name);
      }
      this.projected++;
      await this.projectKept();
      console.error(
        `den: den-edge refused a library write (${this.refusal ?? 'unknown'}); it was not kept`,
      );
    }
    this.onDeferred?.({
      outcome: result === 'sent' || result === 'refused' ? result : 'kept',
      changed: result === 'refused' || !!outcome.merged,
    });
  }

  /**
   * `ops` sent as den-core writes them, compare-and-set, derived from den-edge's own version of each document — not
   * from what this browser draws, which already shows kept writes. A conflict is read and the writes derived again
   * (§8).
   */
  private async sendOps(ops: Op[], outcome: Outcome, riders: SettingsRow[] = []): Promise<boolean> {
    const stored = (name: string) => {
      const row = this.acknowledged.get(name)?.row;
      return row && isDocument(row) ? row : undefined;
    };
    // Settings rows that go in the same batch as these writes (`withRider`): merged over den-edge's version of each,
    // and on a conflict merged again and sent again with the writes, until each has landed.
    let waiting = riders;
    for (let round = 0; round < ROUNDS; round++) {
      // A document of a newer format is never written: the write waits for this build to be updated (§4).
      if (touched(ops).some((name) => this.newerDocuments.has(name))) return false;
      const documents = applyOps(ops, stored);
      if (!documents.length && !waiting.length) return true;
      if (this.profileAware) {
        // An edit is sent whole or not at all: part of it in the household would be part of it in the wrong library.
        const scoped = this.householdRows([...documents, ...waiting]);
        if (scoped.length !== documents.length + waiting.length) {
          this.refusal = 'profile_scoped';
          outcome.refused = true;
          return false;
        }
        waiting = scoped.slice(documents.length) as SettingsRow[];
      }
      const writes: { name: string; document: Row; base: number; k: string; v: string }[] = [];
      for (const rider of waiting) {
        const name = rowName(rider);
        const held = this.acknowledged.get(name);
        const row = held ? merge(held.row, rider) : rider;
        writes.push({ name, document: row, base: held?.seq ?? 0, ...(await seal(this.keys, row)) });
      }
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
        waiting = waiting.filter((rider) => rowName(rider) !== write.name);
      }
      if (!batch.conflicts.length) {
        await this.registerMember();
        return true;
      }
      outcome.merged = true;
      for (const conflict of batch.conflicts) {
        const write = writes.find(({ k }) => k === conflict.k);
        if (!write) continue;
        if (conflict.omitted) return false;
        if (conflict.v === null) {
          this.entries.delete(write.name);
          this.acknowledged.delete(write.name);
          this.unkept.set(write.name, this.generation);
          continue;
        }
        const theirs = await this.readEntry({ k: conflict.k, v: conflict.v });
        if (
          !theirs ||
          this.isProfileDirectory(theirs) ||
          this.isKidTitleApprovals(theirs) ||
          this.isInvalidProfileDirectory(theirs)
        )
          return false;
        this.entries.set(write.name, { seq: conflict.seq, row: theirs });
        this.acknowledged.set(write.name, { seq: conflict.seq, row: theirs });
        this.unkept.set(write.name, this.generation);
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
  async writeAt(given: DocumentRow | SettingsRow, base: number): Promise<boolean> {
    await ensureDeferredSyncPolicy();
    if (this.readOnly || this.offline) return false;
    const row = this.householdRows([given])[0] as DocumentRow | SettingsRow | undefined;
    if (!row) return false;
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
      if (
        conflict &&
        theirs &&
        !this.isProfileDirectory(theirs) &&
        !this.isKidTitleApprovals(theirs) &&
        !this.isInvalidProfileDirectory(theirs)
      ) {
        this.entries.set(name, { seq: conflict.seq, row: theirs });
        this.acknowledged.set(name, { seq: conflict.seq, row: theirs });
        this.unkept.set(name, this.generation);
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
      const scoped = this.householdRows([target])[0];
      if (!scoped) {
        // Refused for good: kept, it would be refused again on every replay.
        if (outcome) outcome.refused = true;
        this.refusal = 'profile_scoped';
        return null;
      }
      target = scoped;
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
        this.unkept.set(name, this.generation);
        continue;
      }
      const theirs = believe(await open(this.keys, k, conflict.v));
      this.entries.set(name, { seq: conflict.seq, row: theirs });
      target = merge(theirs, target);
      // den-edge already holds what this write would make: writing it again only moves its sequence on, and another
      // browser doing the same answers with a conflict of its own, round after round.
      if (canonical(target) === canonical(theirs)) {
        this.acknowledge(name, conflict.seq, theirs);
        return theirs;
      }
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
    if (res.status === 429) {
      this.throttledUntil = Date.now() + retryAfterMs(res, 60_000);
      console.warn('den: den-edge asked for fewer library writes; the write is kept and will wait');
      return code;
    }
    if (res.status === 409 && code === 'migration_in_progress') {
      // Applied nothing and says nothing else. Not a refusal of the write itself: it stays kept, and waits.
      this.migrationLockedAt = Date.now();
      console.warn(
        'den: a profile migration holds this household; the write is kept and will wait',
      );
      return code;
    }
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
  private async send(
    path: string,
    init: RequestInit = {},
    observeHousehold = true,
  ): Promise<Response> {
    const controller = new AbortController();
    const timedOut = () => new DOMException('den-edge stopped answering', 'TimeoutError');
    const deadline = setTimeout(() => controller.abort(timedOut()), REQUEST_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(path, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(deadline);
    }
    // Candidate profile libraries remain wire 4. Their headers must never change the household log's wire state.
    if (observeHousehold) await this.observeProtocol(res);
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
      'x-den-wire': String(this.instanceWire),
      'x-den-generation': this.writeGeneration ?? this.generation ?? '0',
    };
  }

  private async observeProtocol(res: Response): Promise<void> {
    const minimum = Number(res.headers.get('x-den-wire-min'));
    if (!Number.isInteger(minimum) || minimum < 2 || minimum <= this.wireMin) return;
    this.wireMin = minimum;
    if (minimum > this.instanceWire) this.upgradeRequired = minimum;
    // The in-memory monotonic fence already stands for this visit; persistence is an optimization for the next.
    await this.putMeta('wireMin', String(minimum));
  }

  /** Register this browser's membership, once at a time: a cached open starts it while `refresh` may ask too. */
  private registerMember(): Promise<void> {
    if (this.memberRegistered || this.offline) return Promise.resolve();
    return (this.registering ??= this.putMember().finally(() => (this.registering = undefined)));
  }

  private async putMember(): Promise<void> {
    const put = (generation?: string) =>
      this.send(`/lib/${this.keys.id}/member`, {
        method: 'PUT',
        headers: {
          ...this.headers(),
          ...(generation ? { 'x-den-generation': generation } : {}),
          'x-den-library-member': `${this.keys.id}:${this.keys.member}`,
        },
      });
    try {
      let registered = this.writeGeneration ?? this.generation;
      let res = await put();
      // Registered under a generation this browser has not read yet (a cached open, or a change since): once more
      // under the one den-edge names. Only the registration takes it; reads and writes still find the change.
      const current = res.headers.get('x-den-generation');
      if (
        res.status === 409 &&
        (await errorCode(res)) === 'generation_changed' &&
        current &&
        current !== registered
      ) {
        registered = current;
        res = await put(current);
      }
      if (res.ok) {
        this.memberRegistered = true;
        // Remembered for the next visit, which opens without registering again; a failure only costs it that.
        if (registered)
          await this.keep(MEMBER, registered).catch((error: unknown) =>
            console.warn("den: this browser's membership could not be remembered", error),
          );
      } else
        console.warn(
          `den: den-edge did not register this browser's membership (${res.status} ${(await errorCode(res)) ?? ''})`,
        );
    } catch (error) {
      // Sync and playback remain usable; a later write/open retries registration.
      console.warn("den: this browser's membership could not be registered", error);
    }
  }

  /** Persist one bulk intent atomically in the browser before any request. Network chunks are resumable. */
  async writeActions(journals: SettingsRow[]): Promise<boolean> {
    await ensureDeferredSyncPolicy();
    if (!journals.length) return true;
    if (journals.some((row) => !trackerEvent(row))) return false;
    if (this.readOnly) return false;
    if (this.offline) {
      await this.followKeptForm();
      const ops = journals.flatMap((row) => {
        const event = trackerEvent(row)!;
        return opsFor(event.before, event.after);
      });
      for (const document of applyOps(ops, (name) => this.document(name)))
        this.keepLocally(document, false);
      this.persist();
      await this.saving;
      return true;
    }
    return this.writeOps(
      journals.flatMap((row) => {
        const event = trackerEvent(row)!;
        return opsFor(event.before, event.after);
      }),
      undefined,
      true,
      undefined,
      true,
    );
  }

  /**
   * A profile-aware household (profiles-v1 §2): wire minimum 5, or a `profiles` directory. It takes no profile-scoped
   * row, and `set:prefs` and `set:keys` only as their household half (`householdScoped`).
   */
  private get profileAware(): boolean {
    return this.wireMin >= 5 || this.profileDirectorySeq > 0;
  }

  /**
   * A generation change that committed the household's profile directory (profiles-v1 §8.2): den-edge now answers at
   * wire minimum 5, and what this browser holds was read before any `profiles` directory. Evaluated before the new
   * log is read, so the held directory is still the old household's.
   */
  private get directoryCommitted(): boolean {
    return this.wireMin >= 5 && this.profileDirectorySeq === 0;
  }

  /** `rows` as a profile-aware household takes them (`householdScoped`), with what was held back named once. */
  private householdRows(rows: Row[]): Row[] {
    if (!this.profileAware) return rows;
    const kept: Row[] = [];
    const refused: string[] = [];
    for (const row of rows) {
      const scoped = householdScoped(row);
      if (scoped) kept.push(scoped);
      else refused.push(rowName(row));
    }
    if (refused.length)
      console.error(
        `den: ${refused.length} rows belong to a profile library and were not written to the household: ${refused.join(', ')}`,
      );
    return kept;
  }

  /**
   * Adopt a committed profile directory (profiles-v1 §8.2) instead of restoring into it: everything held from the old
   * household — rows, the kept copies of the log, and work kept to send — is discarded, and the new log is read from
   * 0. Writing any of it back would put the Owner's rows (titles, trackers, delivery state, the Owner half of
   * preferences and keys) into the household, which every profile reads. Kept edits are not routed to a profile
   * library from here: this log has none, so they are dropped and named.
   */
  private async adoptProfileDirectory(): Promise<void> {
    console.warn(
      `den: the household committed profiles; ${this.entries.size} rows held from before it are dropped, not written back`,
    );
    this.entries.clear();
    this.acknowledged.clear();
    this.recoveryRows = undefined;
    const local = this.local;
    if (local)
      this.saving = this.saving
        .then(() =>
          Promise.all([
            ...[SNAPSHOT, SNAPSHOT_V4, PARTIAL].map((name) =>
              local.vault.delete(`${this.keys.id}:${name}`),
            ),
            this.factStore?.clear(),
          ]),
        )
        .then(() => undefined)
        .catch((error: unknown) =>
          console.error(
            'den: the kept copy of the household from before its split could not be removed',
            error,
          ),
        );
    await this.refreshPending();
    const opened = new Map((await this.keptWork()).map((work) => [work.key, work]));
    for (const key of [...this.pending.keys()]) {
      const work = opened.get(key);
      const names = !work
        ? 'unreadable'
        : work.kind === 'ops'
          ? [...touched(work.ops ?? []), ...(work.riders ?? []).map(rowName)].join(', ')
          : work.rows.map(rowName).join(', ');
      console.error(
        `den: ${work?.kind ?? 'kept'} work kept for the household from before its split is dropped (${names})`,
      );
      await this.discard(key);
    }
  }

  private async stageRecovery(generation?: string): Promise<boolean> {
    const rows = [...this.entries.values()]
      .filter((entry) => entry.seq > 0)
      .map((entry) => entry.row);
    if (!rows.length) return true;
    try {
      if (this.runtimeAvailable) {
        const key = this.pendingPrefix + 'recovery:' + crypto.randomUUID();
        if (
          !(await this.keepPending(
            key,
            JSON.stringify({
              restore: await Promise.all(rows.map((row) => seal(this.keys, row))),
              // Written back only into this generation: another change first, and the copy is stale (`replay`).
              ...(generation ? { generation } : {}),
            }),
          ))
        )
          return false;
      }
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
    this.migrationLockedAt = 0;
    this.throttledUntil = 0;
    this.entries.set(name, { seq, row });
    this.acknowledged.set(name, { seq, row });
    this.unkept.set(name, this.generation);
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
          const merged = rows.slice(offset, offset + 32).map((local) => {
            const previous = this.entries.get(rowName(local));
            return previous ? merge(previous.row, local) : local;
          });
          const due = this.householdRows(merged).flatMap((row) => {
            const name = rowName(row),
              previous = this.entries.get(name);
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
      if (key.startsWith(this.pendingPrefix)) await this.discard(key);
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

  /** A settings row waiting to go in the same batch as the next edit made by hand (`withRider`). */
  private rider: SettingsRow | null = null;

  /**
   * Run `work`, sending `row` in the same `/lib` batch as the first edit it makes — and kept with it, so a send
   * that does not get through sends both again (assistant v1 §6 *Performing*: a request's applied entry and its
   * effect). False when `work` made no edit for it to ride with; the caller then writes `row` itself.
   */
  async withRider(row: SettingsRow, work: () => Promise<unknown>): Promise<boolean> {
    if (this.wireMin < WIRE || this.offline) {
      await work();
      return false;
    }
    this.rider = row;
    try {
      await work();
      return this.rider === null;
    } finally {
      this.rider = null;
    }
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
    if (this.offline) return this.write(event.after);
    return this.writeEdit(event.before, event.after, undefined, fresh);
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
    await this.refreshPending();
    const kept: KeptWork[] = [];
    for (const [key, encoded] of this.pending) {
      try {
        const pending = JSON.parse(encoded) as {
          k: string;
          v: string;
          bulk?: { k: string; v: string }[];
          restore?: { k: string; v: string }[];
          rows?: { k: string; v: string }[];
          ops?: string;
          riders?: { k: string; v: string }[];
          generation?: string;
        };
        if (pending.ops !== undefined) {
          const riders = await Promise.all(
            (pending.riders ?? []).map(({ k, v }) => open(this.keys, k, v)),
          );
          kept.push({
            key,
            rows: [],
            kind: 'ops',
            ops: await this.openKept(pending.ops),
            riders: riders.filter((row): row is SettingsRow => row?.kind === 'set'),
          });
          continue;
        }
        const sealed = pending.restore ?? pending.bulk ?? pending.rows ?? [pending];
        const rows = await Promise.all(sealed.map(({ k, v }) => open(this.keys, k, v)));
        kept.push({
          key,
          rows,
          kind: pending.restore ? 'restore' : pending.bulk ? 'bulk' : pending.rows ? 'rows' : 'one',
          ...(pending.restore && typeof pending.generation === 'string'
            ? { generation: pending.generation }
            : {}),
        });
      } catch {
        /* Unreadable: `replay` keeps it, and it has nothing to show. */
      }
    }
    return kept;
  }

  /** What the work kept in this browser will do once sent, shown now: projected, and nothing sent. */
  private async projectKept(): Promise<void> {
    const kept = await this.keptWork();
    if (kept.length) await ensureDeferredSyncPolicy();
    for (const work of kept) this.projectWork(work);
  }

  private projectWork(work: KeptWork): void {
    let converted: { restore: Row[]; ops: Op[] };
    try {
      converted = this.v4Work(work);
    } catch (error) {
      console.warn('den: kept library work was refused', error);
      return;
    }
    for (const row of converted.restore) this.project(row);
    this.projectOps(converted.ops);
    for (const row of work.riders ?? []) this.project(row);
  }

  /** Kept v4 documents, settings and ops. Pre-v4 work makes the restored backup read-only. */
  private v4Work(work: KeptWork): { restore: Row[]; ops: Op[] } {
    if (work.kind === 'ops') return { restore: [], ops: work.ops ?? [] };
    if (work.rows.some(preV4Row)) {
      this.preV4Backup = true;
      throw new Error(PRE_V4_BACKUP_ERROR);
    }
    return {
      restore: work.rows.filter((row) => isDocument(row) || row.kind === 'set'),
      ops: [],
    };
  }

  get pendingActions(): number {
    return this.pending.size;
  }

  /** Kept work not being sent now: waiting for den-edge, as against a send under way that is expected to land. */
  get queuedActions(): number {
    let queued = 0;
    for (const key of this.pending.keys()) if (!this.flushing.has(key)) queued++;
    return queued;
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
    // A migration holds the household (`migrationLockedAt`): kept work waits a minute between probes, where the
    // 30-second refresh would otherwise send every piece of it again each time.
    if (this.migrationLockedAt > 0 && Date.now() - this.migrationLockedAt < MIGRATION_RECHECK_MS)
      return this.projectKeptChanged(projected);
    // den-edge's write budget for this library is spent: kept work goes again once the `Retry-After` has passed.
    if (Date.now() < this.throttledUntil) return this.projectKeptChanged(projected);
    // Tried again: refused once more, it waits another `RECHECK_MS`.
    this.refused = false;
    const waiting = this.pendingActions;
    let delivered = false;
    const kept = (await this.keptWork()).sort(
      (a, b) => Number(a.kind === 'restore') - Number(b.kind === 'restore'),
    );
    if (kept.length) await ensureDeferredSyncPolicy();
    for (const work of kept) {
      const { key, kind } = work;
      // Sent by a send that ended since it was read.
      if (this.flushing.has(key) || !this.pending.has(key)) continue;
      if (Date.now() - (this.rejected.get(key) ?? 0) < RECHECK_MS) {
        this.projectWork(work);
        continue;
      }
      if (
        kind === 'restore' &&
        work.generation !== undefined &&
        work.generation !== this.generation
      ) {
        console.warn(
          'den: a recovery staged for an earlier generation of the library is stale; it is dropped',
        );
        await this.discard(key);
        continue;
      }
      // Every tab's Worker replays the same kept recovery: one sends it, and the others find it gone.
      const release = kind === 'restore' ? await this.holdRestore() : undefined;
      if (release) {
        await this.refreshPending();
        if (!this.pending.has(key)) {
          release();
          continue;
        }
      }
      this.flushing.add(key);
      try {
        const { restore, ops } = this.v4Work(work);
        const riders = work.riders ?? [];
        for (const row of [...restore, ...riders]) this.project(row);
        if (
          (ops.length || riders.length) &&
          !(await this.writeOps(ops, undefined, false, key, false, riders))
        )
          continue;
        if (!restore.length) await this.discard(key);
        else if ((await this.flushRows(key, [restore])) && kind === 'restore')
          this.recoveryRows = undefined;
      } catch (error) {
        // Keep unsent work; never acknowledge or delete it.
        console.warn(`den: kept ${kind} work could not be sent; it stays kept`, error);
      } finally {
        this.flushing.delete(key);
        release?.();
      }
    }
    if (
      !this.runtimeAvailable &&
      this.recoveryRows &&
      Date.now() - (this.rejected.get(this.pendingPrefix + 'recovery') ?? 0) >= RECHECK_MS
    ) {
      const rows = this.recoveryRows;
      const groups = [this.v4Work({ key: '', rows, kind: 'restore' }).restore];
      if (await this.flushRows(this.pendingPrefix + 'recovery', groups)) {
        delivered = true;
        this.recoveryRows = undefined;
      }
    }
    return delivered || this.pendingActions < waiting || this.projected !== projected;
  }

  /**
   * This library's recovery lock, held across every tab of this browser (`navigator.locks`) until the returned release
   * is called; with no `navigator.locks`, held at once.
   */
  private holdRestore(): Promise<() => void> {
    return new Promise((held) => {
      exclusive(
        `den.library.${this.keys.id}.restore`,
        () => new Promise<void>((release) => held(release)),
      ).catch((error: unknown) => {
        // Sent without it, as where the browser has no locks: never left waiting for a lock that will not come.
        console.error('den: the library recovery lock failed', error);
        held(() => {});
      });
    });
  }

  /** Kept work not sent now is still drawn; true when that changed a row since `projected`. */
  private async projectKeptChanged(projected: number): Promise<boolean> {
    await this.projectKept();
    return this.projected !== projected;
  }
}

/** den-edge would not start a library: its status, `error` code and how long it asked to be left (`Retry-After`). */
export class LibraryStartRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly retryAfterMs: number,
  ) {
    super(`den-edge did not start the library (${status} ${code ?? ''})`);
  }
}

/** The keys of a profile library from its canonical base64 key. */
async function libraryKeys(key: string): Promise<LibraryKeys> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Profile library key is not canonical');
  }
  if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== key) {
    raw.fill(0);
    throw new Error('Profile library key is not canonical');
  }
  try {
    return await deriveKeys(raw);
  } finally {
    raw.fill(0);
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

/** `value` as JSON with every object's keys in order, so two equal rows read the same whatever built them. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** `work` under the lock `name` in every tab of this browser; with no `navigator.locks`, just `work`. */
export { exclusive } from './exclusive';

/** One row per name, with duplicate settings or documents merged before a batch reaches den-edge. */
function coalesce(rows: Row[]): Row[] {
  const byName = new Map<string, Row>();
  for (const row of rows) {
    const name = rowName(row);
    const held = byName.get(name);
    byName.set(name, held ? merge(held, row) : row);
  }
  return [...byName.values()];
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
  return theirs;
}
