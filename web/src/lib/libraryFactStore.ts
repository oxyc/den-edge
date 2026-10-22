import { compactContinueLibrary, selectHomeLibraryViewFromFold } from './homeLibraryView';
import { applyLog, emptyLibrary, type Library, type LibraryRecord, type Mark } from './library';
import {
  libraryLocalMaterials,
  openLibraryLocalValue,
  sealLibraryLocalValue,
} from './libraryLocalValue';
import { noteLibraryFactCommit } from './libraryStartupMetrics';
import { projectDocument } from './libraryV4';
import type { Vault, VaultChange } from './localVault';
import {
  isDocument,
  mergeDocument,
  mergeEpisode,
  mergeSettings,
  mergeTitle,
  mergeV3,
  newestSummary,
  type Row,
  type SettingsRow,
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
  complete: boolean;
  profileTopology: boolean;
  /**
   * A newest-first import under way: every row from `floor` up to `head` is kept, and it resumes below `floor`.
   * Absent for an oldest-first import, which resumes after `head`.
   */
  floor?: number;
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

function projected(row: Row): Row[] {
  return isDocument(row) && row.kind !== 'delivery' ? projectDocument(row) : [row];
}

function facts(
  row: Row | null,
): Partial<Record<LibraryFactCapability, TitleFact | ContinueFact | SettingsFact>> {
  if (!row) return {};
  const rows = projected(row);
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
  const library = applyLog(emptyLibrary(), rows);
  const folded = compactContinueLibrary(library);
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
      reconsiderAt: newestSummary(row, Date.now()).reconsiderAt ?? null,
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
    typeof held.complete === 'boolean' &&
    typeof held.profileTopology === 'boolean' &&
    (held.floor === undefined || (Number.isSafeInteger(held.floor) && held.floor >= 0))
  );
};

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
  if (previous.kind === 'wat' && replacement.kind === 'wat') return mergeV3(previous, replacement);
  if (previous.kind === 'snt' && replacement.kind === 'snt') return mergeV3(previous, replacement);
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
    const bytes = await this.vault.get(`${this.libraryId}:${manifestName}`);
    if (!bytes) return null;
    try {
      const opened = await openLibraryLocalValue(this.key, manifestName, bytes);
      if (!validManifest(opened)) return null;
      this.profileTopology = opened.profileTopology;
      this.generation = opened.generation;
      return opened;
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
    options: { readonly profileTopology?: boolean; readonly floor?: number } = {},
  ): Promise<void> {
    if (!this.vault.commit) throw new Error('Atomic library storage is unavailable');
    if (this.generation !== generation) {
      if (this.generation) this.staleGenerations.add(this.generation);
      this.generation = generation;
      this.profileTopology = false;
    }
    const changes = await this.changes(generation, entries);
    this.profileTopology ||= options.profileTopology === true;
    const manifest: LibraryFactManifest = {
      schema: LIBRARY_FACT_SCHEMA,
      generation,
      head,
      complete,
      profileTopology: this.profileTopology,
      ...(options.floor !== undefined && !complete ? { floor: options.floor } : {}),
    };
    changes.push({
      kind: 'put',
      key: `${this.libraryId}:${manifestName}`,
      value: await sealLibraryLocalValue(this.key, manifestName, manifest),
    });
    await this.vault.commit(changes);
    noteLibraryFactCommit(entries.length);
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
    await this.vault.commit(await this.changes(generation, entries));
    noteLibraryFactCommit(entries.length);
  }

  /** Forget every generation and the cursor: the next open reads den-edge from the start. */
  async clear(): Promise<void> {
    await this.vault.remove(`${this.libraryId}:${ROOT}:`);
    this.generation = undefined;
    this.profileTopology = false;
    this.staleGenerations.clear();
  }

  /** Each entry's document and facts, sealed. */
  private async changes(
    generation: string,
    entries: readonly LibraryFactEntry[],
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
      const selected = facts(entry.row);
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
