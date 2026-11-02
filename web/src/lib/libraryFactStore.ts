import { compactContinueLibrary, selectHomeLibraryViewFromFold } from './homeLibraryView';
import {
  applyLog,
  ContinueSummaries,
  emptyLibrary,
  type Library,
  type LibraryRecord,
  type Mark,
} from './library';
import {
  libraryLocalMaterials,
  openLibraryLocalValue,
  sealLibraryLocalValue,
} from './libraryLocalValue';
import { noteLibraryFactCommit } from './libraryStartupMetrics';
import {
  COMPACT_HISTORY_CHECKPOINT_SCHEMA,
  historyCheckpointMatches,
  historyCheckpointSource,
  restoreHistoryCheckpoint,
  type CompactHistoryCheckpoint,
} from './compactHistoryCheckpoint';
import {
  HISTORY_INDEX_POLICY,
  HISTORY_INDEX_SCHEMA,
  MaterializedHistoryIndex,
  compareHistoryItems,
  currentHistoryTimeZone,
  historyItemFromProjections,
  historyItemFromDocuments,
  historySeasonProjection,
  type HistoryDocumentProjection,
} from './historyIndex';
import { WATCHED } from './actions';
import { forEachProjectedEpisode, projectDocument } from './libraryV4';
import type { Vault, VaultChange } from './localVault';
import {
  compareStamps,
  isDocument,
  mergeDocument,
  mergeEpisode,
  mergeSettings,
  mergeTitle,
  newestSummary,
  type DocumentRow,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
} from './wire';

export const LIBRARY_FACT_SCHEMA = 1;
const ROOT = 'library-facts.v1';
/** Documents a read of an earlier build's per-document records takes a transaction (`recordDocuments`). */
const DOCUMENT_PAGE = 512;
const FACT_PAGE = 256;
/**
 * The documents' layout: one sealed snapshot of a generation's documents and a journal of sealed batches since. A
 * manifest without it names one record per document, which is read once to convert it (`convert`).
 */
const SNAPSHOT_LAYOUT = 2;
/** Journal batches past which a commit folds them into the snapshot (`compact`). */
const JOURNAL_LIMIT = 32;

export type LibraryFactCapability =
  'watchlist' | 'continue' | 'recommendations' | 'settings' | 'runtime' | 'devices';

interface StoredLibrary {
  records: LibraryRecord[];
  marks: Mark[];
  flags: Array<[string, { type: string; id: number; season: number; episode: number }]>;
  dismissed: Array<[string, number]>;
}

interface TitleFact {
  schema: typeof LIBRARY_FACT_SCHEMA;
  title: TitleRow;
  library: StoredLibrary;
}

interface ContinueFact {
  schema: typeof LIBRARY_FACT_SCHEMA;
  library: StoredLibrary;
  reconsiderAt: number | null;
}

interface SettingsFact {
  schema: typeof LIBRARY_FACT_SCHEMA;
  row: SettingsRow;
}

export interface LibraryFactManifest {
  schema: typeof LIBRARY_FACT_SCHEMA;
  generation: string;
  head: number;
  /** The greatest server row sequence retained for this generation, including writes kept beside `head`. */
  rowsVersion?: number;
  /**
   * Unique identity of this exact committed fact snapshot. It prevents concurrent writers that began from the same
   * manifest from producing the same cache identity. Absent in manifests written before it was introduced.
   */
  revision?: string;
  complete: boolean;
  profileTopology: boolean;
  /**
   * A newest-first import under way: every row from `floor` up to `head` is kept, and it resumes below `floor`.
   * Absent for an oldest-first import, which resumes after `head`.
   */
  floor?: number;
  /**
   * The newest stamp in every row kept, as `LibraryLog.newestStamp` reads it, and when a future stamp among them first
   * becomes believable: so an edit made without reading the whole library is still stamped after all of it. Absent
   * in a manifest an earlier build kept.
   */
  newest?: { stamp: Stamp; reconsiderAt: number | null };
  /** `SNAPSHOT_LAYOUT` when the documents are a snapshot and journal; absent for one record per document. */
  layout?: typeof SNAPSHOT_LAYOUT;
}

export interface LibraryFactEntry {
  readonly k: string;
  readonly seq: number;
  /** The authenticated row, or null for an unreadable/newer row whose previous facts must be retracted. */
  readonly row: Row | null;
  /** The server ciphertext. It remains the individually retained authority and is sealed once more locally. */
  readonly value: string;
}

export interface StoredLibraryDocument {
  schema: typeof LIBRARY_FACT_SCHEMA;
  seq: number;
  value: string;
  row: Row | null;
}

const generationPart = (generation: string) => encodeURIComponent(generation);
const manifestName = `${ROOT}:manifest`;
const historyName = `${ROOT}:history`;
/**
 * A commit that changes some titles' History writes their entries as one delta beside the checkpoint, not the whole
 * library's checkpoint again; past `HISTORY_DELTA_LIMIT` deltas the next commit writes the checkpoint whole.
 */
const historyDeltaPrefix = `${ROOT}:history-delta:`;
const HISTORY_DELTA_LIMIT = 32;

interface HistoryDelta {
  schema: typeof COMPACT_HISTORY_CHECKPOINT_SCHEMA;
  /** The revision of the History it changes: the checkpoint's, or the delta's before it. */
  from: string;
  source: CompactHistoryCheckpoint['snapshot']['source'];
  builtAt: number;
  /** Each changed title's entry, or null where it has none now. */
  items: Array<[title: string, item: CompactHistoryCheckpoint['snapshot']['items'][number] | null]>;
  /** Each changed title's document keys, or null where it has none now. */
  documents: Array<[title: string, keys: string[] | null]>;
}

const validDelta = (value: unknown): value is HistoryDelta =>
  !!value &&
  typeof value === 'object' &&
  (value as HistoryDelta).schema === COMPACT_HISTORY_CHECKPOINT_SCHEMA &&
  typeof (value as HistoryDelta).from === 'string' &&
  !!(value as HistoryDelta).source &&
  Number.isFinite((value as HistoryDelta).builtAt) &&
  Array.isArray((value as HistoryDelta).items) &&
  Array.isArray((value as HistoryDelta).documents);
const namespace = (generation: string) => `${ROOT}:${generationPart(generation)}`;
const recordPrefix = (generation: string) => `${namespace(generation)}:document:`;
/**
 * The snapshot and its journal share one prefix, so one read sees both as a single transaction did: read apart, a fold
 * by another writer between them leaves the reader the snapshot before the fold and none of the journal it took in.
 */
const keptPrefix = (generation: string) => `${namespace(generation)}:kept:`;
const snapshotName = (generation: string) => `${keptPrefix(generation)}snapshot`;
const journalPrefix = (generation: string) => `${keptPrefix(generation)}journal:`;

/**
 * One document as the snapshot and journal hold it: its key, sequence and row. The server ciphertext is kept only for
 * a row this build cannot read, which is the one thing that reads it again (`LibraryLog.restoreFacts`).
 */
type HeldDocument = [key: string, seq: number, row: Row | null, value?: string];

interface DocumentBatch {
  schema: typeof LIBRARY_FACT_SCHEMA;
  documents: HeldDocument[];
}

const heldDocument = (key: string, document: { seq: number; row: Row | null; value: string }) =>
  (document.row
    ? [key, document.seq, document.row]
    : [key, document.seq, null, document.value]) as HeldDocument;

const storedDocument = ([, seq, row, value]: HeldDocument): StoredLibraryDocument => ({
  schema: LIBRARY_FACT_SCHEMA,
  seq,
  value: value ?? '',
  row,
});

const validBatch = (value: unknown): value is DocumentBatch =>
  !!value &&
  typeof value === 'object' &&
  (value as DocumentBatch).schema === LIBRARY_FACT_SCHEMA &&
  Array.isArray((value as DocumentBatch).documents) &&
  (value as DocumentBatch).documents.every(
    (held) =>
      Array.isArray(held) &&
      typeof held[0] === 'string' &&
      Number.isSafeInteger(held[1]) &&
      (held[2] === null || (typeof held[2] === 'object' && !Array.isArray(held[2]))) &&
      (held[3] === undefined || typeof held[3] === 'string'),
  );

/** The same document: the snapshot drops the server ciphertext of a row it holds (`HeldDocument`). */
const sameDocument = (left: StoredLibraryDocument, right: StoredLibraryDocument | undefined) =>
  !!right &&
  left.seq === right.seq &&
  JSON.stringify(left.row) === JSON.stringify(right.row) &&
  (left.row !== null || left.value === right.value);

/** Journal names sort in the order they were written, so a later batch's document replaces an earlier one's. */
const journalName = (generation: string) =>
  `${journalPrefix(generation)}${Date.now().toString().padStart(15, '0')}:${[
    ...crypto.getRandomValues(new Uint8Array(6)),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;

const byKey = <T>(entries: Array<[string, T]>) =>
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
const factPrefix = (generation: string, capability: LibraryFactCapability) =>
  `${namespace(generation)}:fact:${capability}:`;
const factName = (generation: string, capability: LibraryFactCapability, key: string) =>
  `${factPrefix(generation, capability)}${key}`;

const storedLibrary = (library: Library): StoredLibrary => ({
  records: library.records,
  marks: library.marks,
  flags: [...(library.flags ?? new Map())],
  dismissed: [...library.dismissed],
});

const openStoredLibrary = (library: StoredLibrary): Library => ({
  records: library.records,
  marks: library.marks,
  flags: new Map(library.flags),
  dismissed: new Map(library.dismissed),
  shapes: new Map(),
});

function projected(row: Row, now: number): Row[] {
  return isDocument(row) && row.kind !== 'delivery' ? projectDocument(row, now) : [row];
}

function continueAndHistoryOfSeason(
  season: DocumentRow,
  now: number,
): { library: Library; history: HistoryDocumentProjection } {
  const summaries = new ContinueSummaries();
  const watched: number[] = [];
  forEachProjectedEpisode(
    season,
    (episode) => {
      summaries.addEpisode(episode);
      if (episode.progress.value >= WATCHED) watched.push(episode.episode, episode.progress.at[0]);
    },
    now,
  );
  return { library: summaries.compact(), history: historySeasonProjection(season, watched) };
}

function facts(row: Row | null): {
  selected: Partial<Record<LibraryFactCapability, TitleFact | ContinueFact | SettingsFact>>;
  history: HistoryDocumentProjection | null;
  reconsiderAt: number | null;
} {
  if (!row) return { selected: {}, history: null, reconsiderAt: null };
  const now = Date.now();
  const reconsiderAt = newestSummary(row, now).reconsiderAt ?? null;
  // A season document is only ever Continue's input, so its episodes are folded one at a time instead of held.
  const season = isDocument(row) && row.kind === 'season' ? row : null;
  const rows = season ? [] : projected(row, now);
  const library = applyLog(emptyLibrary(), rows);
  const seasonFacts = season ? continueAndHistoryOfSeason(season, now) : null;
  const folded = seasonFacts?.library ?? compactContinueLibrary(library);
  const projectedTitle = rows.find((candidate): candidate is TitleRow => candidate.kind === 'rec');
  const history =
    seasonFacts?.history ??
    (projectedTitle && isDocument(row) && row.kind === 'title'
      ? { kind: 'title', title: projectedTitle }
      : null);
  const selected: Partial<Record<LibraryFactCapability, TitleFact | ContinueFact | SettingsFact>> =
    {};
  for (const setting of rows.filter(
    (candidate): candidate is SettingsRow => candidate.kind === 'set',
  )) {
    const fact = { schema: LIBRARY_FACT_SCHEMA, row: setting } as const;
    if (
      setting.name === 'prefs' ||
      setting.name === 'assistant-grants' ||
      setting.name === 'assistant-read'
    )
      selected.settings = fact;
    if (setting.name === 'plugins' || setting.name === 'addresses') selected.runtime = fact;
    if (setting.name === 'devices') selected.devices = fact;
  }
  const title = projectedTitle;
  if (title) {
    const fact = { schema: LIBRARY_FACT_SCHEMA, title, library: storedLibrary(library) } as const;
    if (!title.deleted.value && title.status.value === 'watchlist') selected.watchlist = fact;
    selected.recommendations = fact;
  }
  if (
    folded.records.length ||
    folded.marks.length ||
    (folded.flags?.size ?? 0) ||
    folded.dismissed.size
  )
    selected.continue = {
      schema: LIBRARY_FACT_SCHEMA,
      library: storedLibrary(folded),
      reconsiderAt,
    };
  return { selected, history, reconsiderAt };
}

interface ImportedHistoryProjection {
  projection: HistoryDocumentProjection | null;
  reconsiderAt: number | null;
}

const validManifest = (value: unknown): value is LibraryFactManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Partial<LibraryFactManifest>;
  return (
    held.schema === LIBRARY_FACT_SCHEMA &&
    typeof held.generation === 'string' &&
    held.generation.length > 0 &&
    Number.isSafeInteger(held.head) &&
    held.head! >= 0 &&
    (held.rowsVersion === undefined ||
      (Number.isSafeInteger(held.rowsVersion) && held.rowsVersion >= held.head!)) &&
    (held.revision === undefined ||
      (typeof held.revision === 'string' &&
        held.revision.length > 0 &&
        held.revision.length <= 128)) &&
    typeof held.complete === 'boolean' &&
    typeof held.profileTopology === 'boolean' &&
    (held.floor === undefined || (Number.isSafeInteger(held.floor) && held.floor >= 0)) &&
    (held.newest === undefined || validNewest(held.newest)) &&
    (held.layout === undefined || held.layout === SNAPSHOT_LAYOUT)
  );
};

const validNewest = (value: unknown): value is LibraryFactManifest['newest'] => {
  const held = value as LibraryFactManifest['newest'];
  return (
    !!held &&
    Array.isArray(held.stamp) &&
    held.stamp.length === 3 &&
    Number.isFinite(held.stamp[0]) &&
    Number.isFinite(held.stamp[1]) &&
    typeof held.stamp[2] === 'string' &&
    (held.reconsiderAt === null || Number.isFinite(held.reconsiderAt))
  );
};

/**
 * `newest` with `entries`' rows added. Kept in the same commit as the rows; two commits racing can leave it a stamp
 * low, which only orders this browser's next edit among other titles, never against the document it writes.
 */
function withNewest(
  newest: LibraryFactManifest['newest'] | undefined,
  entries: readonly LibraryFactEntry[],
  now = Date.now(),
): NonNullable<LibraryFactManifest['newest']> {
  let stamp: Stamp = newest?.stamp ?? [0, 0, ''];
  let reconsiderAt = newest?.reconsiderAt ?? Infinity;
  for (const { row } of entries) {
    if (!row) continue;
    const summary = newestSummary(row, now);
    if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
    reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
  }
  return { stamp, reconsiderAt: Number.isFinite(reconsiderAt) ? reconsiderAt : null };
}

/** This transaction's durable identity, compatible with manifests that predate it. */
function nextIdentity(
  held: LibraryFactManifest | null,
  generation: string,
  head: number,
  entries: readonly LibraryFactEntry[],
): Pick<LibraryFactManifest, 'revision' | 'rowsVersion'> {
  const previous = held?.generation === generation ? (held.rowsVersion ?? held.head) : 0;
  let rowsVersion = Math.max(head, previous);
  for (const { seq } of entries) rowsVersion = Math.max(rowsVersion, seq);
  return {
    rowsVersion,
    revision: [...crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(''),
  };
}

export function mergeFactRows(previous: Row | null, replacement: Row | null): Row | null {
  if (!previous || !replacement) return replacement;
  if (isDocument(previous) && isDocument(replacement)) {
    if (previous.format > 4 || replacement.format > 4)
      return replacement.format > previous.format ? replacement : previous;
    return mergeDocument(previous, replacement);
  }
  if (previous.kind === 'rec' && replacement.kind === 'rec')
    return mergeTitle(previous, replacement);
  if (previous.kind === 'ep' && replacement.kind === 'ep')
    return mergeEpisode(previous, replacement);
  if (previous.kind === 'set' && replacement.kind === 'set')
    return mergeSettings(previous, replacement);
  return replacement;
}

/**
 * This browser's one copy of a library on den-edge: its documents sealed as one snapshot and a journal of the batches
 * kept since, beside the capability facts selected from each document. Every batch publishes its rows and cursor in one IndexedDB transaction; a Vault without that
 * contract keeps no copy, and every visit reads den-edge.
 */
export class LibraryFactStore {
  private profileTopology = false;
  private generation?: string;
  private readonly staleGenerations = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private historyCache?: {
    identity: string;
    value: {
      checkpoint: CompactHistoryCheckpoint;
      index: MaterializedHistoryIndex;
      deltas: string[];
    };
  };
  /** Complete only while this instance performs an uninterrupted first import; never authoritative or persisted. */
  private historyImport?: {
    generation: string;
    documents: Map<string, ImportedHistoryProjection>;
  };
  /**
   * The documents of `generation` as of manifest `revision`: the snapshot with its journal replayed. A commit by this
   * instance adds to it; a manifest another writer moved on reads them again.
   */
  private held?: {
    generation: string;
    revision: string | undefined;
    documents: Map<string, StoredLibraryDocument>;
    journals: number;
  };
  /** The fold under way (`kept`), so a commit while it runs starts no second one. */
  private folding?: Promise<void>;
  private constructor(
    readonly libraryId: string,
    private readonly key: CryptoKey,
    private readonly vault: Vault,
  ) {}

  static async open(libraryKey: string, vault: Vault): Promise<LibraryFactStore | null> {
    if (!vault.commit || !vault.page) return null;
    const local = await libraryLocalMaterials(libraryKey);
    return local ? new LibraryFactStore(local.libraryId, local.key, vault) : null;
  }

  async manifest(): Promise<LibraryFactManifest | null> {
    const opened = await this.readManifest();
    if (!opened) return null;
    this.profileTopology = opened.profileTopology;
    this.generation = opened.generation;
    return opened;
  }

  /** The one canonical, timezone-neutral History checkpoint atomically paired with `manifest`. */
  async history(manifest: LibraryFactManifest): Promise<MaterializedHistoryIndex | null> {
    if (!manifest.complete) return null;
    const opened = await this.readHistoryCheckpoint(manifest);
    if (!opened) return null;
    if (opened.index.timeZone !== currentHistoryTimeZone()) {
      const restored = MaterializedHistoryIndex.restore(opened.checkpoint.snapshot);
      if (!restored) return null;
      opened.index = restored;
    }
    if (opened.index.source.reconsiderAt !== null && Date.now() >= opened.index.source.reconsiderAt)
      return null;
    return opened.index;
  }

  /** Exact document membership for bounded visible-title detail queries. */
  async historyDocumentsFor(
    manifest: LibraryFactManifest,
    title: { type: 'tv'; id: number },
  ): Promise<StoredLibraryDocument[] | null> {
    const opened = await this.readHistoryCheckpoint(manifest);
    if (!opened) return null;
    const keys = new Map(opened.checkpoint.documents).get(`${title.type}:${title.id}`);
    if (!keys) return [];
    const documents = await Promise.all(keys.map((key) => this.document(manifest.generation, key)));
    return documents.every((document) => document !== null)
      ? (documents as StoredLibraryDocument[])
      : null;
  }

  /** Tell an owner of derived local state whenever this store's authoritative rows move. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private async readManifest(): Promise<LibraryFactManifest | null> {
    const bytes = await this.vault.get(`${this.libraryId}:${manifestName}`);
    if (!bytes) return null;
    try {
      const opened = await openLibraryLocalValue(this.key, manifestName, bytes);
      return validManifest(opened) ? opened : null;
    } catch {
      return null;
    }
  }

  async document(generation: string, key: string): Promise<StoredLibraryDocument | null> {
    return (await this.heldDocuments(generation)).get(key) ?? null;
  }

  /** Every document of `generation`, in key order. */
  async *documents(
    generation: string,
  ): AsyncGenerator<{ key: string; document: StoredLibraryDocument }> {
    for (const [key, document] of byKey([...(await this.heldDocuments(generation))]))
      yield { key, document };
  }

  /** The documents of `generation` as its manifest names them now, converting a store an earlier build wrote first. */
  private async heldDocuments(generation: string): Promise<Map<string, StoredLibraryDocument>> {
    const manifest = await this.readManifest();
    const current = manifest?.generation === generation ? manifest : null;
    if (
      current?.revision !== undefined &&
      this.held?.generation === generation &&
      this.held.revision === current.revision
    )
      return this.held.documents;
    if (current && current.layout !== SNAPSHOT_LAYOUT) return this.convert(current);
    const documents = new Map<string, StoredLibraryDocument>();
    const { snapshot, journals } = await this.readKept(generation);
    for (const held of snapshot?.batch.documents ?? [])
      documents.set(held[0], storedDocument(held));
    for (const { batch } of journals)
      for (const held of batch.documents) documents.set(held[0], storedDocument(held));
    this.held = { generation, revision: current?.revision, documents, journals: journals.length };
    return documents;
  }

  private async readBatch(name: string, bytes?: Uint8Array): Promise<DocumentBatch | null> {
    const held = bytes ?? (await this.vault.get(`${this.libraryId}:${name}`));
    if (!held) return null;
    const opened = await openLibraryLocalValue(this.key, name, held).catch(() => null);
    if (!validBatch(opened)) throw new Error('Individual library authority is corrupt');
    return opened;
  }

  /** The snapshot of `generation`, as stored and opened, and its journal oldest batch first, from one read. */
  private async readKept(generation: string): Promise<{
    snapshot?: { bytes: Uint8Array; batch: DocumentBatch };
    journals: Array<{ key: string; batch: DocumentBatch }>;
  }> {
    const snapshotKey = `${this.libraryId}:${snapshotName(generation)}`;
    const held = byKey(await this.vault.entries(`${this.libraryId}:${keptPrefix(generation)}`));
    const open = (key: string, bytes: Uint8Array) =>
      this.readBatch(key.slice(this.libraryId.length + 1), bytes) as Promise<DocumentBatch>;
    const snapshot = held.find(([key]) => key === snapshotKey);
    const [batch, journals] = await Promise.all([
      snapshot && open(...snapshot),
      Promise.all(
        held
          .filter(([key]) => key !== snapshotKey)
          .map(async ([key, bytes]) => ({ key, batch: await open(key, bytes) })),
      ),
    ]);
    return { ...(snapshot && batch ? { snapshot: { bytes: snapshot[1], batch } } : {}), journals };
  }

  /**
   * A store an earlier build wrote, one record per document, made one snapshot: read whole, sealed once, read back and
   * compared document by document, and only then named by the manifest and the old records removed. Until all of that
   * holds, the old records stay and are what is read; a write is refused rather than kept beside them.
   */
  private async convert(
    manifest: LibraryFactManifest,
  ): Promise<Map<string, StoredLibraryDocument>> {
    const { generation } = manifest;
    const old = new Map<string, StoredLibraryDocument>();
    for await (const { key, document } of this.recordDocuments(generation)) old.set(key, document);
    // Read as it is until a later open converts it; a write before then is refused (`writable`).
    this.held = { generation, revision: manifest.revision, documents: old, journals: 0 };
    try {
      const name = snapshotName(generation);
      const batch: DocumentBatch = {
        schema: LIBRARY_FACT_SCHEMA,
        documents: [...old].map(([key, document]) => heldDocument(key, document)),
      };
      await this.vault.put(
        `${this.libraryId}:${name}`,
        await sealLibraryLocalValue(this.key, name, batch),
      );
      const read = new Map(
        ((await this.readBatch(name))?.documents ?? []).map((held) => [
          held[0],
          storedDocument(held),
        ]),
      );
      if (
        read.size !== old.size ||
        [...old].some(([key, held]) => !sameDocument(held, read.get(key)))
      )
        throw new Error('the snapshot does not read back as the documents it was made from');
      const manifestKey = `${this.libraryId}:${manifestName}`;
      const expected = await this.vault.get(manifestKey);
      const opened = expected
        ? await openLibraryLocalValue(this.key, manifestName, expected).catch(() => null)
        : null;
      // Another writer moved the manifest on meanwhile: convert on a later read, from what it wrote.
      if (!validManifest(opened) || opened.revision !== manifest.revision) return old;
      const flipped = await this.commitIf(manifestKey, expected, [
        {
          kind: 'put',
          key: manifestKey,
          value: await sealLibraryLocalValue(this.key, manifestName, {
            ...manifest,
            layout: SNAPSHOT_LAYOUT,
          }),
        },
      ]);
      if (!flipped) return old;
      await this.vault.remove(`${this.libraryId}:${recordPrefix(generation)}`);
      this.held = { generation, revision: manifest.revision, documents: read, journals: 0 };
      return read;
    } catch (error) {
      console.warn(
        'den: the library kept here could not be made one snapshot; it is read as it is',
        error,
      );
      return old;
    }
  }

  /** `changes` in one transaction when `key` still holds `expected`; a vault without the comparison commits them. */
  private async commitIf(
    key: string,
    expected: Uint8Array | undefined,
    changes: VaultChange[],
  ): Promise<boolean> {
    if (this.vault.compareAndCommit) return this.vault.compareAndCommit(key, expected, changes);
    await this.vault.commit!(changes);
    return true;
  }

  /** The journal folded into the snapshot, unless another writer replaced the snapshot first. */
  private async compact(generation: string): Promise<void> {
    const name = snapshotName(generation);
    const key = `${this.libraryId}:${name}`;
    const { snapshot, journals } = await this.readKept(generation);
    const expected = snapshot?.bytes;
    const documents = new Map<string, HeldDocument>();
    for (const held of snapshot?.batch.documents ?? []) documents.set(held[0], held);
    for (const { batch } of journals)
      for (const held of batch.documents) documents.set(held[0], held);
    const sealed = await sealLibraryLocalValue(this.key, name, {
      schema: LIBRARY_FACT_SCHEMA,
      documents: [...documents.values()],
    } satisfies DocumentBatch);
    const folded = await this.commitIf(key, expected, [
      { kind: 'put', key, value: sealed },
      ...journals.map(({ key: journal }) => ({ kind: 'delete' as const, key: journal })),
    ]);
    // Batches committed while the fold ran stay in the journal, and in the count.
    if (folded && this.held?.generation === generation)
      this.held.journals = Math.max(0, this.held.journals - journals.length);
  }

  /** An earlier build's per-document records, read only to convert them (`convert`). */
  private async *recordDocuments(
    generation: string,
  ): AsyncGenerator<{ key: string; document: StoredLibraryDocument }> {
    if (!this.vault.page) return;
    const namePrefix = recordPrefix(generation);
    const prefix = `${this.libraryId}:${namePrefix}`;
    let after: string | undefined;
    for (;;) {
      const page = await this.vault.page(prefix, after, DOCUMENT_PAGE);
      if (!page.length) return;
      // A page's documents are opened at once: WebCrypto runs them off the thread, as many at a time as it can.
      yield* await Promise.all(
        page.map(async ([storedKey, bytes]) => {
          const name = storedKey.slice(this.libraryId.length + 1);
          try {
            const opened = (await openLibraryLocalValue(
              this.key,
              name,
              bytes,
            )) as StoredLibraryDocument;
            if (opened?.schema !== LIBRARY_FACT_SCHEMA || !Number.isSafeInteger(opened.seq))
              throw new Error('invalid document');
            return { key: name.slice(namePrefix.length), document: opened };
          } catch {
            throw new Error('Individual library authority is corrupt');
          }
        }),
      );
      if (page.length < DOCUMENT_PAGE) return;
      after = page.at(-1)![0];
    }
  }

  async commitBatch(
    generation: string,
    head: number,
    entries: readonly LibraryFactEntry[],
    complete: boolean,
    options: {
      readonly profileTopology?: boolean;
      readonly floor?: number;
    } = {},
  ): Promise<void> {
    if (!this.vault.commit) throw new Error('Atomic library storage is unavailable');
    if (this.generation !== generation) {
      if (this.generation) this.staleGenerations.add(this.generation);
      this.generation = generation;
      this.profileTopology = false;
    }
    const held = await this.writable(generation);
    if (held?.generation === generation) this.profileTopology ||= held.profileTopology;
    this.profileTopology ||= options.profileTopology === true;
    const floor = options.floor !== undefined && !complete ? options.floor : undefined;
    if (
      !entries.length &&
      held?.generation === generation &&
      held.head === head &&
      held.complete === complete &&
      held.profileTopology === this.profileTopology &&
      held.floor === floor &&
      (!complete || (await this.history(held)) !== null)
    )
      return;
    const derived = await this.changes(generation, entries);
    const retainedHistory =
      held?.generation === generation &&
      !held.complete &&
      this.historyImport?.generation === generation
        ? this.historyImport.documents
        : !held || held.generation !== generation
          ? new Map<string, ImportedHistoryProjection>()
          : null;
    // Only the completing transaction needs a combined snapshot before it commits. Incomplete batches append to the
    // retained map after their commit succeeds, avoiding a growing Map copy for every 64-document batch.
    const importedHistory =
      complete && retainedHistory ? new Map(retainedHistory) : retainedHistory;
    if (complete && importedHistory)
      for (const entry of entries)
        importedHistory.set(
          entry.k,
          derived.history.get(entry.k) ?? { projection: null, reconsiderAt: null },
        );
    const manifest: LibraryFactManifest = {
      schema: LIBRARY_FACT_SCHEMA,
      generation,
      head,
      ...nextIdentity(held, generation, head, entries),
      complete,
      profileTopology: this.profileTopology,
      ...(floor !== undefined ? { floor } : {}),
      newest: withNewest(held?.generation === generation ? held.newest : undefined, entries),
      layout: SNAPSHOT_LAYOUT,
    };
    derived.changes.push(
      ...(await this.historyCheckpointChange(held, manifest, entries, importedHistory)),
    );
    derived.changes.push({
      kind: 'put',
      key: `${this.libraryId}:${manifestName}`,
      value: await sealLibraryLocalValue(this.key, manifestName, manifest),
    });
    await this.vault.commit(derived.changes);
    this.kept(generation, held, manifest.revision, entries, complete);
    if (complete) this.historyImport = undefined;
    else if (retainedHistory) {
      for (const entry of entries)
        retainedHistory.set(
          entry.k,
          derived.history.get(entry.k) ?? { projection: null, reconsiderAt: null },
        );
      this.historyImport = { generation, documents: retainedHistory };
    } else this.historyImport = undefined;
    this.historyCache = undefined;
    noteLibraryFactCommit(entries.length);
    this.changed();
    if (complete)
      for (const stale of [...this.staleGenerations]) {
        try {
          await this.vault.remove(`${this.libraryId}:${namespace(stale)}:`);
          this.staleGenerations.delete(stale);
        } catch {
          // The active manifest already names the complete replacement. Old generations are harmless sealed garbage.
        }
      }
  }

  /**
   * Rows den-edge acknowledged outside a read of its log (this browser's own writes), kept without moving the cursor:
   * the read that reaches them keeps them again with it. Nothing is kept for a generation this store does not hold.
   */
  async keepRows(generation: string, entries: readonly LibraryFactEntry[]): Promise<void> {
    if (!this.vault.commit) throw new Error('Atomic library storage is unavailable');
    if (this.generation !== generation || !entries.length) return;
    const held = await this.writable(generation);
    const derived = await this.changes(generation, entries);
    // The cursor stays; the newest stamp takes these rows in, so a narrow edit is stamped after them too.
    let revision = held?.revision;
    if (held?.generation === generation) {
      const manifest: LibraryFactManifest = {
        ...held,
        ...nextIdentity(held, generation, held.head, entries),
        newest: withNewest(held.newest, entries),
      };
      revision = manifest.revision;
      derived.changes.push(...(await this.historyCheckpointChange(held, manifest, entries)));
      derived.changes.push({
        kind: 'put',
        key: `${this.libraryId}:${manifestName}`,
        value: await sealLibraryLocalValue(this.key, manifestName, manifest),
      });
    }
    await this.vault.commit(derived.changes);
    this.kept(generation, held, revision, entries, held?.complete === true);
    this.historyCache = undefined;
    this.historyImport = undefined;
    noteLibraryFactCommit(entries.length);
    this.changed();
  }

  /** Forget every generation and the cursor: the next open reads den-edge from the start. */
  async clear(): Promise<void> {
    await this.vault.remove(`${this.libraryId}:${ROOT}:`);
    this.generation = undefined;
    this.profileTopology = false;
    this.staleGenerations.clear();
    this.historyCache = undefined;
    this.historyImport = undefined;
    this.held = undefined;
    this.changed();
  }

  /**
   * The manifest a commit to `generation` builds on, once its documents are in the snapshot layout: converted first if
   * an earlier build wrote them, refused if they could not be. A new generation starts its documents empty.
   */
  private async writable(generation: string): Promise<LibraryFactManifest | null> {
    let held = await this.readManifest();
    if (held?.generation === generation && held.layout !== SNAPSHOT_LAYOUT) {
      await this.heldDocuments(generation);
      held = await this.readManifest();
      if (held?.generation === generation && held.layout !== SNAPSHOT_LAYOUT)
        throw new Error(
          'The library kept here is in an earlier layout that could not be converted',
        );
    }
    if (held?.generation !== generation && this.held?.generation !== generation)
      this.held = { generation, revision: undefined, documents: new Map(), journals: 0 };
    return held;
  }

  /**
   * `entries` kept by a commit from manifest `held` to `revision`: added to the documents held, or those dropped when
   * another writer had moved the manifest on before it. Past `JOURNAL_LIMIT` batches of a complete library the journal
   * is folded, behind the commit rather than inside it: an open reading den-edge waits on each page's commit before it
   * asks for the next, and a fold reseals the whole library. An incomplete one is still being read whole, and is folded
   * once that read has completed it.
   */
  private kept(
    generation: string,
    held: LibraryFactManifest | null,
    revision: string | undefined,
    entries: readonly LibraryFactEntry[],
    complete: boolean,
  ): void {
    if (this.held?.generation !== generation) return;
    if (this.held.revision !== (held?.generation === generation ? held.revision : undefined)) {
      this.held = undefined;
      return;
    }
    for (const entry of entries)
      this.held.documents.set(entry.k, storedDocument(heldDocument(entry.k, entry)));
    this.held.revision = revision;
    if (entries.length) this.held.journals++;
    if (!complete || this.held.journals < JOURNAL_LIMIT || this.folding) return;
    this.folding = this.compact(generation)
      .catch((error: unknown) =>
        console.warn('den: the library journal could not be folded; it is read as it is', error),
      )
      .finally(() => (this.folding = undefined));
  }

  /** Release disposable one-pass import state when its owner gives up before reaching a complete manifest. */
  discardIncompleteHistoryDerivation(): void {
    this.historyImport = undefined;
  }

  /** The entries' documents as one sealed journal batch, and each entry's facts, sealed. */
  private async changes(
    generation: string,
    entries: readonly LibraryFactEntry[],
  ): Promise<{
    changes: VaultChange[];
    history: Map<string, ImportedHistoryProjection>;
  }> {
    // Every value of the batch is sealed at once: WebCrypto runs them off the thread, as many at a time as it can.
    const pending: Array<Promise<VaultChange>> = [];
    const history = new Map<string, ImportedHistoryProjection>();
    for (const entry of entries) {
      const derived = facts(entry.row);
      const selected = derived.selected;
      history.set(entry.k, {
        projection: derived.history,
        reconsiderAt: derived.reconsiderAt,
      });
      for (const capability of [
        'watchlist',
        'continue',
        'recommendations',
        'settings',
        'runtime',
        'devices',
      ] as const) {
        const name = factName(generation, capability, entry.k);
        const key = `${this.libraryId}:${name}`;
        const value = selected[capability];
        pending.push(
          value
            ? sealLibraryLocalValue(this.key, name, value).then((sealed) => ({
                kind: 'put',
                key,
                value: sealed,
              }))
            : Promise.resolve({ kind: 'delete', key }),
        );
      }
    }
    if (entries.length) {
      const journal = journalName(generation);
      pending.push(
        sealLibraryLocalValue(this.key, journal, {
          schema: LIBRARY_FACT_SCHEMA,
          documents: entries.map((entry) => heldDocument(entry.k, entry)),
        } satisfies DocumentBatch).then((value) => ({
          kind: 'put',
          key: `${this.libraryId}:${journal}`,
          value,
        })),
      );
    }
    return { changes: await Promise.all(pending), history };
  }

  /** The History deltas kept beside the checkpoint, oldest first. */
  private async historyDeltas(): Promise<Array<[key: string, bytes: Uint8Array]>> {
    return (await this.vault.entries(`${this.libraryId}:${historyDeltaPrefix}`)).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
  }

  private async readHistoryCheckpoint(manifest: LibraryFactManifest): Promise<{
    checkpoint: CompactHistoryCheckpoint;
    index: MaterializedHistoryIndex;
    deltas: string[];
  } | null> {
    const identity = `${manifest.generation}\n${manifest.head}\n${manifest.rowsVersion ?? manifest.head}\n${manifest.revision ?? ''}`;
    if (this.historyCache?.identity === identity) return this.historyCache.value;
    const bytes = await this.vault.get(`${this.libraryId}:${historyName}`);
    if (!bytes) return null;
    try {
      const base = (await openLibraryLocalValue(
        this.key,
        historyName,
        bytes,
      )) as CompactHistoryCheckpoint;
      const deltas = await this.historyDeltas();
      let checkpoint = base;
      if (deltas.length) {
        if (
          !base?.snapshot ||
          !Array.isArray(base.snapshot.items) ||
          !Array.isArray(base.documents)
        )
          return null;
        const items = new Map(
          base.snapshot.items.map((item) => [`${item.title.type}:${item.title.id}`, item]),
        );
        const documents = new Map(base.documents);
        let { source, builtAt } = base.snapshot;
        for (const [key, held] of deltas) {
          const delta = await openLibraryLocalValue(
            this.key,
            key.slice(this.libraryId.length + 1),
            held,
          );
          // Each delta extends the revision before it; one that does not is not History, and it is built again.
          if (!validDelta(delta) || delta.from !== source.revision) return null;
          for (const [title, item] of delta.items)
            if (item) items.set(title, item);
            else items.delete(title);
          for (const [title, keys] of delta.documents)
            if (keys) documents.set(title, keys);
            else documents.delete(title);
          ({ source, builtAt } = delta);
        }
        checkpoint = {
          ...base,
          snapshot: {
            ...base.snapshot,
            source,
            builtAt,
            items: [...items.values()].sort(compareHistoryItems),
          },
          documents: [...documents].sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        };
      }
      const restored = restoreHistoryCheckpoint(checkpoint, manifest);
      const value = restored && { ...restored, deltas: deltas.map(([key]) => key) };
      if (value) this.historyCache = { identity, value };
      return value;
    } catch {
      return null;
    }
  }

  /** Prepare the checkpoint before the transaction; its put/delete lands atomically with documents and manifest. */
  private async historyCheckpointChange(
    held: LibraryFactManifest | null,
    manifest: LibraryFactManifest,
    entries: readonly LibraryFactEntry[],
    importedHistory: Map<string, ImportedHistoryProjection> | null = null,
  ): Promise<VaultChange[]> {
    const key = `${this.libraryId}:${historyName}`;
    const dropDeltas = async (): Promise<VaultChange[]> =>
      (await this.historyDeltas()).map(([delta]) => ({ kind: 'delete', key: delta }));
    if (!manifest.complete) return [{ kind: 'delete', key }, ...(await dropDeltas())];

    const openedPrior =
      held?.complete && held.generation === manifest.generation
        ? await this.readHistoryCheckpoint(held)
        : null;
    const prior =
      openedPrior &&
      openedPrior.index.source.reconsiderAt !== null &&
      Date.now() >= openedPrior.index.source.reconsiderAt
        ? null
        : openedPrior;
    const incoming = new Map(entries.map((entry) => [entry.k, entry.row]));
    const documents = new Map<string, Set<string>>();
    // On the first complete import, retain the documents already opened by the one required membership scan. Reading
    // and decrypting every document again title-by-title made profile adoption pay two full-library passes before its
    // startup deadline. Incremental updates still read only the affected titles below.
    const importedRows = prior ? null : new Map<string, DocumentRow[]>();
    const importedProjections =
      !prior && importedHistory ? new Map<string, HistoryDocumentProjection[]>() : null;
    const affected = new Set<string>();
    let reconsiderAt = prior?.index.source.reconsiderAt ?? Infinity;
    const titleOf = (row: Row | null | undefined): string | null =>
      row && isDocument(row) && (row.kind === 'title' || row.kind === 'season')
        ? `${row.title.type}:${row.title.id}`
        : null;

    if (prior) {
      for (const [title, keys] of prior.checkpoint.documents) documents.set(title, new Set(keys));
      for (const entry of entries) {
        const previous = await this.document(manifest.generation, entry.k);
        const before = titleOf(previous?.row);
        const after = titleOf(entry.row);
        if (before) {
          documents.get(before)?.delete(entry.k);
          affected.add(before);
        }
        if (after) {
          const keys = documents.get(after) ?? new Set<string>();
          keys.add(entry.k);
          documents.set(after, keys);
          affected.add(after);
        }
        if (entry.row) {
          const deadline = newestSummary(entry.row, Date.now()).reconsiderAt;
          if (deadline != null) reconsiderAt = Math.min(reconsiderAt, deadline);
        }
      }
    } else {
      // The final import batch builds once. Earlier incomplete batches deliberately had no checkpoint to rewrite.
      if (importedProjections) {
        // Match the old scan's order: committed document keys first, then replacements in this final batch.
        const ordered = [
          ...[...importedHistory!].filter(([documentKey]) => !incoming.has(documentKey)).sort(),
          ...entries.flatMap((entry) => {
            const held = importedHistory!.get(entry.k);
            return held ? ([[entry.k, held]] as Array<[string, ImportedHistoryProjection]>) : [];
          }),
        ];
        for (const [documentKey, held] of ordered) {
          const projection = held.projection;
          if (!projection) continue;
          const ref = projection.kind === 'title' ? projection.title.title : projection.title;
          const title = `${ref.type}:${ref.id}`;
          const keys = documents.get(title) ?? new Set<string>();
          keys.add(documentKey);
          documents.set(title, keys);
          const projections = importedProjections.get(title) ?? [];
          projections.push(projection);
          importedProjections.set(title, projections);
          if (held.reconsiderAt != null) reconsiderAt = Math.min(reconsiderAt, held.reconsiderAt);
        }
      } else {
        for await (const { key: documentKey, document } of this.documents(manifest.generation)) {
          if (incoming.has(documentKey)) continue;
          const title = titleOf(document.row);
          if (!title) continue;
          const keys = documents.get(title) ?? new Set<string>();
          keys.add(documentKey);
          documents.set(title, keys);
          const rows = importedRows!.get(title) ?? [];
          if (document.row && isDocument(document.row)) rows.push(document.row);
          importedRows!.set(title, rows);
          const deadline = document.row
            ? newestSummary(document.row, Date.now()).reconsiderAt
            : null;
          if (deadline != null) reconsiderAt = Math.min(reconsiderAt, deadline);
        }
        for (const entry of entries) {
          const title = titleOf(entry.row);
          if (!title) continue;
          const keys = documents.get(title) ?? new Set<string>();
          keys.add(entry.k);
          documents.set(title, keys);
          const rows = importedRows!.get(title) ?? [];
          if (entry.row && isDocument(entry.row)) rows.push(entry.row);
          importedRows!.set(title, rows);
          const deadline = entry.row ? newestSummary(entry.row, Date.now()).reconsiderAt : null;
          if (deadline != null) reconsiderAt = Math.min(reconsiderAt, deadline);
        }
      }
      for (const title of documents.keys()) affected.add(title);
    }

    for (const [title, keys] of documents) if (!keys.size) documents.delete(title);
    const items = new Map(
      (prior?.checkpoint.snapshot.items ?? []).map((item) => [
        `${item.title.type}:${item.title.id}`,
        item,
      ]),
    );
    const now = Date.now();
    for (const title of affected) {
      const rows = importedRows?.get(title) ?? [];
      if (!importedRows) {
        for (const documentKey of documents.get(title) ?? []) {
          const row = incoming.has(documentKey)
            ? incoming.get(documentKey)
            : (await this.document(manifest.generation, documentKey))?.row;
          if (row && isDocument(row) && (row.kind === 'title' || row.kind === 'season'))
            rows.push(row);
        }
      }
      const item = importedProjections
        ? historyItemFromProjections(importedProjections.get(title) ?? [])
        : historyItemFromDocuments(rows, now);
      if (item) items.set(title, item);
      else items.delete(title);
    }
    const checkpoint: CompactHistoryCheckpoint = {
      schema: COMPACT_HISTORY_CHECKPOINT_SCHEMA,
      snapshot: {
        schema: HISTORY_INDEX_SCHEMA,
        policy: HISTORY_INDEX_POLICY,
        source: historyCheckpointSource(
          manifest,
          Number.isFinite(reconsiderAt) ? reconsiderAt : null,
        ),
        builtAt: now,
        items: [...items.values()].sort(compareHistoryItems),
      },
      documents: [...documents]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([title, keys]) => [title, [...keys].sort()]),
    };
    if (!historyCheckpointMatches(checkpoint, manifest))
      throw new Error('History checkpoint source does not match its fact manifest');
    if (prior && prior.deltas.length < HISTORY_DELTA_LIMIT) {
      const name = `${historyDeltaPrefix}${Date.now().toString().padStart(15, '0')}:${[
        ...crypto.getRandomValues(new Uint8Array(6)),
      ]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')}`;
      const changed = [...affected].sort();
      const delta: HistoryDelta = {
        schema: COMPACT_HISTORY_CHECKPOINT_SCHEMA,
        from: prior.checkpoint.snapshot.source.revision,
        source: checkpoint.snapshot.source,
        builtAt: checkpoint.snapshot.builtAt,
        items: changed.map((title) => [title, items.get(title) ?? null]),
        documents: changed.map((title) => [
          title,
          documents.has(title) ? [...documents.get(title)!].sort() : null,
        ]),
      };
      return [
        {
          kind: 'put',
          key: `${this.libraryId}:${name}`,
          value: await sealLibraryLocalValue(this.key, name, delta),
        },
      ];
    }
    return [
      { kind: 'put', key, value: await sealLibraryLocalValue(this.key, historyName, checkpoint) },
      ...(prior
        ? prior.deltas.map((delta): VaultChange => ({ kind: 'delete', key: delta }))
        : await dropDeltas()),
    ];
  }

  async *read<T extends TitleFact | ContinueFact | SettingsFact>(
    generation: string,
    capability: LibraryFactCapability,
  ): AsyncGenerator<T> {
    if (!this.vault.page) return;
    const namePrefix = factPrefix(generation, capability);
    const prefix = `${this.libraryId}:${namePrefix}`;
    let after: string | undefined;
    for (;;) {
      const page = await this.vault.page(prefix, after, FACT_PAGE);
      if (!page.length) return;
      for (const [storedKey, bytes] of page) {
        const name = storedKey.slice(this.libraryId.length + 1);
        try {
          const opened = (await openLibraryLocalValue(this.key, name, bytes)) as T;
          if (opened?.schema === LIBRARY_FACT_SCHEMA) yield opened;
        } catch {
          // A corrupt disposable fact makes the fact set unusable; callers compare the yielded count with authority.
          throw new Error('Library capability facts are corrupt');
        }
      }
      if (page.length < FACT_PAGE) return;
      after = page.at(-1)![0];
    }
  }

  async settings(
    generation: string,
    capability: 'settings' | 'runtime' | 'devices',
  ): Promise<SettingsRow[]> {
    const rows: SettingsRow[] = [];
    for await (const fact of this.read<SettingsFact>(generation, capability)) rows.push(fact.row);
    return rows;
  }

  /** Reduce only the requested Home inputs. Exact watched-history episodes are never read here. */
  async home(
    generation: string,
    capabilities: readonly LibraryFactCapability[],
  ): Promise<{
    view: ReturnType<typeof selectHomeLibraryViewFromFold>;
    reconsiderAt: number | null;
  }> {
    const needsTitles =
      capabilities.includes('watchlist') || capabilities.includes('recommendations');
    const titleCapability: LibraryFactCapability = capabilities.includes('recommendations')
      ? 'recommendations'
      : 'watchlist';
    const titles: TitleRow[] = [];
    const combined = emptyLibrary();
    if (needsTitles)
      for await (const fact of this.read<TitleFact>(generation, titleCapability)) {
        titles.push(fact.title);
        const part = openStoredLibrary(fact.library);
        combined.records.push(...part.records);
      }
    let reconsiderAt = Infinity;
    if (capabilities.includes('continue'))
      for await (const fact of this.read<ContinueFact>(generation, 'continue')) {
        const part = openStoredLibrary(fact.library);
        if (!needsTitles) combined.records.push(...part.records);
        combined.marks.push(...part.marks);
        for (const [name, flag] of part.flags ?? []) combined.flags!.set(name, flag);
        for (const [name, at] of part.dismissed) combined.dismissed.set(name, at);
        if (fact.reconsiderAt !== null) reconsiderAt = Math.min(reconsiderAt, fact.reconsiderAt);
      }
    const home = selectHomeLibraryViewFromFold(combined, titles);
    if (!capabilities.includes('continue')) {
      home.continueLibrary = emptyLibrary();
      home.requiredShapeRefs = [];
    }
    return { view: home, reconsiderAt: Number.isFinite(reconsiderAt) ? reconsiderAt : null };
  }
}
