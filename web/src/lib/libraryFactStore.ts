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
  historyItemFromDocuments,
} from './historyIndex';
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
/** Documents a read takes a transaction: an open of the whole library reads every one of them. */
const DOCUMENT_PAGE = 512;
const FACT_PAGE = 256;

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
const namespace = (generation: string) => `${ROOT}:${generationPart(generation)}`;
const documentName = (generation: string, key: string) =>
  `${namespace(generation)}:document:${key}`;
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

function continueOfSeason(season: DocumentRow, now: number): Library {
  const summaries = new ContinueSummaries();
  forEachProjectedEpisode(season, (episode) => summaries.addEpisode(episode), now);
  return summaries.compact();
}

function facts(
  row: Row | null,
  retainEpisodeProjection = false,
): Partial<Record<LibraryFactCapability, TitleFact | ContinueFact | SettingsFact>> {
  if (!row) return {};
  const now = Date.now();
  // A season document is only ever Continue's input, so its episodes are folded one at a time instead of held.
  const season = isDocument(row) && row.kind === 'season' && !retainEpisodeProjection ? row : null;
  const rows = season ? [] : projected(row, now);
  const library = applyLog(emptyLibrary(), rows);
  const folded = season ? continueOfSeason(season, now) : compactContinueLibrary(library);
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
  const title = rows.find((candidate): candidate is TitleRow => candidate.kind === 'rec');
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
      reconsiderAt: newestSummary(row, now).reconsiderAt ?? null,
    };
  return selected;
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
    (held.newest === undefined || validNewest(held.newest))
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
 * This browser's one copy of a library on den-edge: each document individually encrypted, beside the capability facts
 * selected from it. Every batch publishes its rows and cursor in one IndexedDB transaction; a Vault without that
 * contract keeps no copy, and every visit reads den-edge.
 */
export class LibraryFactStore {
  private profileTopology = false;
  private generation?: string;
  private readonly staleGenerations = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private historyCache?: {
    identity: string;
    value: { checkpoint: CompactHistoryCheckpoint; index: MaterializedHistoryIndex };
  };
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
    const name = documentName(generation, key);
    const bytes = await this.vault.get(`${this.libraryId}:${name}`);
    if (!bytes) return null;
    try {
      const opened = (await openLibraryLocalValue(this.key, name, bytes)) as StoredLibraryDocument;
      return opened?.schema === LIBRARY_FACT_SCHEMA && Number.isSafeInteger(opened.seq)
        ? opened
        : null;
    } catch {
      return null;
    }
  }

  async *documents(
    generation: string,
  ): AsyncGenerator<{ key: string; document: StoredLibraryDocument }> {
    if (!this.vault.page) return;
    const namePrefix = `${namespace(generation)}:document:`;
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
      /** Populate projectDocument's row cache when this caller will immediately need the full episode projection. */
      readonly retainEpisodeProjection?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.vault.commit) throw new Error('Atomic library storage is unavailable');
    if (this.generation !== generation) {
      if (this.generation) this.staleGenerations.add(this.generation);
      this.generation = generation;
      this.profileTopology = false;
    }
    const held = await this.readManifest();
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
    const changes = await this.changes(generation, entries, options.retainEpisodeProjection);
    const manifest: LibraryFactManifest = {
      schema: LIBRARY_FACT_SCHEMA,
      generation,
      head,
      ...nextIdentity(held, generation, head, entries),
      complete,
      profileTopology: this.profileTopology,
      ...(floor !== undefined ? { floor } : {}),
      newest: withNewest(held?.generation === generation ? held.newest : undefined, entries),
    };
    changes.push(await this.historyCheckpointChange(held, manifest, entries));
    changes.push({
      kind: 'put',
      key: `${this.libraryId}:${manifestName}`,
      value: await sealLibraryLocalValue(this.key, manifestName, manifest),
    });
    await this.vault.commit(changes);
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
    const changes = await this.changes(generation, entries, true);
    // The cursor stays; the newest stamp takes these rows in, so a narrow edit is stamped after them too.
    const held = await this.readManifest();
    if (held?.generation === generation) {
      const manifest: LibraryFactManifest = {
        ...held,
        ...nextIdentity(held, generation, held.head, entries),
        newest: withNewest(held.newest, entries),
      };
      changes.push(await this.historyCheckpointChange(held, manifest, entries));
      changes.push({
        kind: 'put',
        key: `${this.libraryId}:${manifestName}`,
        value: await sealLibraryLocalValue(this.key, manifestName, manifest),
      });
    }
    await this.vault.commit(changes);
    this.historyCache = undefined;
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
    this.changed();
  }

  /** Each entry's document and facts, sealed. */
  private async changes(
    generation: string,
    entries: readonly LibraryFactEntry[],
    retainEpisodeProjection = false,
  ): Promise<VaultChange[]> {
    // Every value of the batch is sealed at once: WebCrypto runs them off the thread, as many at a time as it can.
    const pending: Array<Promise<VaultChange>> = [];
    for (const entry of entries) {
      const document = documentName(generation, entry.k);
      pending.push(
        sealLibraryLocalValue(this.key, document, {
          schema: LIBRARY_FACT_SCHEMA,
          seq: entry.seq,
          value: entry.value,
          row: entry.row,
        }).then((value) => ({ kind: 'put', key: `${this.libraryId}:${document}`, value })),
      );
      const selected = facts(entry.row, retainEpisodeProjection);
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
    return Promise.all(pending);
  }

  private async readHistoryCheckpoint(manifest: LibraryFactManifest): Promise<{
    checkpoint: CompactHistoryCheckpoint;
    index: MaterializedHistoryIndex;
  } | null> {
    const identity = `${manifest.generation}\n${manifest.head}\n${manifest.rowsVersion ?? manifest.head}\n${manifest.revision ?? ''}`;
    if (this.historyCache?.identity === identity) return this.historyCache.value;
    const bytes = await this.vault.get(`${this.libraryId}:${historyName}`);
    if (!bytes) return null;
    try {
      const value = restoreHistoryCheckpoint(
        await openLibraryLocalValue(this.key, historyName, bytes),
        manifest,
      );
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
  ): Promise<VaultChange> {
    const key = `${this.libraryId}:${historyName}`;
    if (!manifest.complete) return { kind: 'delete', key };

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
      for await (const { key: documentKey, document } of this.documents(manifest.generation)) {
        if (incoming.has(documentKey)) continue;
        const title = titleOf(document.row);
        if (!title) continue;
        const keys = documents.get(title) ?? new Set<string>();
        keys.add(documentKey);
        documents.set(title, keys);
        const deadline = document.row ? newestSummary(document.row, Date.now()).reconsiderAt : null;
        if (deadline != null) reconsiderAt = Math.min(reconsiderAt, deadline);
      }
      for (const entry of entries) {
        const title = titleOf(entry.row);
        if (!title) continue;
        const keys = documents.get(title) ?? new Set<string>();
        keys.add(entry.k);
        documents.set(title, keys);
        const deadline = entry.row ? newestSummary(entry.row, Date.now()).reconsiderAt : null;
        if (deadline != null) reconsiderAt = Math.min(reconsiderAt, deadline);
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
      const rows: DocumentRow[] = [];
      for (const documentKey of documents.get(title) ?? []) {
        const row = incoming.has(documentKey)
          ? incoming.get(documentKey)
          : (await this.document(manifest.generation, documentKey))?.row;
        if (row && isDocument(row) && (row.kind === 'title' || row.kind === 'season'))
          rows.push(row);
      }
      const item = historyItemFromDocuments(rows, now);
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
    return {
      kind: 'put',
      key,
      value: await sealLibraryLocalValue(this.key, historyName, checkpoint),
    };
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
