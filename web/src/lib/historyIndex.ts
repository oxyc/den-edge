import { WATCHED } from './actions';
import { compareHistoryTitleKeys } from './history';
import { titleKey } from './library';
import { forEachProjectedEpisode, projectDocument } from './libraryV4';
import type {
  HistoryCursor,
  HistoryFacets,
  HistoryFilter,
  HistoryItem,
  HistoryPage,
  MediaType,
  TitleRef,
} from './libraryServiceProtocol';
import type { DocumentRow, TitleRow } from './wire';

/** Changing projection or ordering semantics must invalidate every cursor. */
export const HISTORY_INDEX_POLICY = 2;
export const HISTORY_INDEX_SCHEMA = 1;

const DEFAULT_LIMIT = 48;
const MAX_LIMIT = 96;
const UNKNOWN_YEAR = 'unknown';

export interface HistoryIndexSource {
  generation: string | null;
  /** Monotonic in-memory document revision. */
  version: number;
  /** Exact authority/fact-manifest identity; unlike a row count it cannot alias concurrent snapshots. */
  revision: string;
  /** First instant at which future-stamped source documents may project differently. */
  reconsiderAt: number | null;
}

export interface HistoryIndexSnapshot {
  schema: typeof HISTORY_INDEX_SCHEMA;
  policy: typeof HISTORY_INDEX_POLICY;
  source: HistoryIndexSource;
  builtAt: number;
  /** Canonical sorted entries only; filter buckets are cheap to reconstruct and are never duplicated on disk. */
  items: HistoryItem[];
}

/**
 * The History-only result of projecting one authority document. Initial imports keep these small values just until
 * their first checkpoint is committed, so Continue and History can consume the same den-core projection without
 * retaining the document or its full episode-row graph.
 */
export type HistoryDocumentProjection =
  | { kind: 'title'; title: TitleRow }
  | {
      kind: 'season';
      title: DocumentRow['title'];
      season: number;
      /** Interleaved episode number and watched timestamp, avoiding one retained object per watched episode. */
      watched: number[];
    };

export const historySeasonProjection = (
  document: DocumentRow,
  watched: number[],
): HistoryDocumentProjection => ({
  kind: 'season',
  title: document.title,
  season: document.season ?? 0,
  watched,
});

/** The same title summary as `historyItemFromDocuments`, from already-projected per-document values. */
export const historyItemFromProjections = (
  projections: readonly HistoryDocumentProjection[],
): HistoryItem | undefined => {
  if (!projections.length) return undefined;
  const ref =
    projections[0]!.kind === 'title' ? projections[0]!.title.title : projections[0]!.title;
  const key = titleKey(ref);
  let title: TitleRow | undefined;
  for (const projection of projections)
    if (projection.kind === 'title' && titleKey(projection.title.title) === key)
      title = projection.title;

  let episodes = 0;
  let latest: { season: number; episode: number; at: number } | undefined;
  let latestWatchedAt: number | undefined;
  const reset = title?.episodesReset;
  for (const projection of projections) {
    if (projection.kind !== 'season' || titleKey(projection.title) !== key) continue;
    for (let index = 0; index < projection.watched.length; index += 2) {
      const episode = projection.watched[index]!;
      const at = projection.watched[index + 1]!;
      if (reset && at <= reset[0]) continue;
      latestWatchedAt = Math.max(latestWatchedAt ?? -Infinity, at);
      if (projection.season <= 0) continue;
      episodes++;
      if (!latest || at > latest.at) latest = { season: projection.season, episode, at };
    }
  }

  const seenAt =
    title?.status.value === 'watched' ? Math.max(title.watchedAt ?? 0, title.status.at[0], 0) : -1;
  const watchedAt = Math.max(
    seenAt,
    latestWatchedAt === undefined ? -1 : Math.max(latestWatchedAt, 0),
  );
  if (watchedAt < 0 || (title?.deleted.value && title.deleted.at[0] >= watchedAt)) return undefined;
  return {
    title: { type: ref.type, id: ref.id },
    watchedAt,
    ...(latest ? { episode: { season: latest.season, episode: latest.episode } } : {}),
    episodes,
  };
};

export const currentHistoryTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;

const yearOf = (item: HistoryItem, timeZone: string): string => {
  if (item.watchedAt <= 0) return UNKNOWN_YEAR;
  try {
    return new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format(item.watchedAt);
  } catch {
    return String(new Date(item.watchedAt).getFullYear());
  }
};

export const historyFilterKey = (filter: HistoryFilter): string =>
  `${filter.type ?? 'all'}:${filter.year ?? 'all'}`;

export const compareHistoryItems = (left: HistoryItem, right: HistoryItem): number =>
  (left.watchedAt === right.watchedAt ? 0 : left.watchedAt > right.watchedAt ? -1 : 1) ||
  compareHistoryTitleKeys(titleKey(left.title), titleKey(right.title));

export const historyCursorOf = (
  revision: string,
  filter: HistoryFilter,
  item: HistoryItem,
): HistoryCursor =>
  `${revision}\n${historyFilterKey(filter)}\n${item.watchedAt}\n${titleKey(item.title)}`;

export const historyCursorBoundary = (
  revision: string,
  filter: HistoryFilter,
  cursor: HistoryCursor,
): { watchedAt: number; titleKey: string } | null => {
  const [heldRevision, heldFilter, rawAt, key, extra] = cursor.split('\n');
  const watchedAt = Number(rawAt);
  return extra === undefined &&
    heldRevision === revision &&
    heldFilter === historyFilterKey(filter) &&
    Number.isFinite(watchedAt) &&
    !!key
    ? { watchedAt, titleKey: key }
    : null;
};

const cursorPosition = (
  items: readonly HistoryItem[],
  revision: string,
  filter: HistoryFilter,
  cursor?: HistoryCursor,
): number | null => {
  if (!cursor) return 0;
  const boundary = historyCursorBoundary(revision, filter, cursor);
  if (!boundary) return null;
  const { watchedAt: at, titleKey: key } = boundary;
  // First item strictly after the keyset boundary. This remains correct for equal timestamps and undated imports.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = items[middle]!;
    const after = item.watchedAt < at || (item.watchedAt === at && titleKey(item.title) > key);
    if (after) high = middle;
    else low = middle + 1;
  }
  return low;
};

const insert = (items: HistoryItem[], item: HistoryItem): void => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareHistoryItems(items[middle]!, item) <= 0) low = middle + 1;
    else high = middle;
  }
  items.splice(low, 0, item);
};

const remove = (items: HistoryItem[], key: string): void => {
  const found = items.findIndex((item) => titleKey(item.title) === key);
  if (found >= 0) items.splice(found, 1);
};

export const historyItemFromDocuments = (
  documents: readonly DocumentRow[],
  now: number,
): HistoryItem | undefined => {
  if (!documents.length) return undefined;
  const ref = documents[0]!.title;
  const key = titleKey(ref);
  let title = undefined as
    Extract<ReturnType<typeof projectDocument>[number], { kind: 'rec' }> | undefined;
  for (const document of documents) {
    if (titleKey(document.title) !== key) continue;
    if (document.kind === 'title') {
      const [projected] = projectDocument(document, now);
      if (projected?.kind === 'rec') title = projected;
    }
  }

  let episodes = 0;
  let latest: { season: number; episode: number; at: number } | undefined;
  let latestWatchedAt: number | undefined;
  const reset = title?.episodesReset;
  for (const document of documents) {
    if (document.kind !== 'season' || titleKey(document.title) !== key) continue;
    forEachProjectedEpisode(
      document,
      (episode) => {
        if (episode.progress.value < WATCHED || (reset && episode.progress.at[0] <= reset[0]))
          return;
        latestWatchedAt = Math.max(latestWatchedAt ?? -Infinity, episode.progress.at[0]);
        if (episode.season <= 0) return;
        episodes++;
        const at = episode.progress.at[0];
        if (!latest || at > latest.at)
          latest = { season: episode.season, episode: episode.episode, at };
      },
      now,
    );
  }

  // `watchedAt` is the first watch, so a later status stamp dates a re-watch; imported unknown dates remain zero.
  const seenAt =
    title?.status.value === 'watched' ? Math.max(title.watchedAt ?? 0, title.status.at[0], 0) : -1;
  const watchedAt = Math.max(
    seenAt,
    latestWatchedAt === undefined ? -1 : Math.max(latestWatchedAt, 0),
  );
  if (watchedAt < 0 || (title?.deleted.value && title.deleted.at[0] >= watchedAt)) return undefined;
  return {
    title: { type: ref.type, id: ref.id },
    watchedAt,
    ...(latest ? { episode: { season: latest.season, episode: latest.episode } } : {}),
    episodes,
  };
};

/**
 * Worker-owned derived index. Authoritative encrypted v4 documents remain the only source of truth; this object is
 * disposable and can always be rebuilt. Its revision binds every page/detail request to one exact source snapshot.
 */
export class MaterializedHistoryIndex {
  readonly #byTitle = new Map<string, HistoryItem>();
  readonly #all: HistoryItem[] = [];
  readonly #byType: Record<MediaType, HistoryItem[]> = { movie: [], tv: [] };
  readonly #byYear = new Map<string, HistoryItem[]>();
  readonly #byTypeYear: Record<MediaType, Map<string, HistoryItem[]>> = {
    movie: new Map(),
    tv: new Map(),
  };
  readonly source: HistoryIndexSource;
  readonly builtAt: number;
  readonly timeZone: string;
  #revision: string;

  constructor(
    source: HistoryIndexSource,
    documents: readonly DocumentRow[],
    readonly now: number = Date.now(),
    timeZone = currentHistoryTimeZone(),
  ) {
    this.source = { ...source };
    this.builtAt = now;
    this.timeZone = timeZone;
    this.#revision = MaterializedHistoryIndex.revision(source, timeZone);
    const grouped = new Map<string, DocumentRow[]>();
    for (const document of documents) {
      if (document.kind !== 'title' && document.kind !== 'season') continue;
      const key = titleKey(document.title);
      const held = grouped.get(key);
      if (held) held.push(document);
      else grouped.set(key, [document]);
    }
    const items: HistoryItem[] = [];
    for (const held of grouped.values()) {
      const entry = historyItemFromDocuments(held, now);
      if (entry) items.push(entry);
    }
    items.sort(compareHistoryItems);
    for (const item of items) this.#append(item);
  }

  /** Build from an already projected stream (used by narrow in-memory/embedding logs without document lookup). */
  static fromItems(
    source: HistoryIndexSource,
    items: readonly HistoryItem[],
    now: number = Date.now(),
    timeZone = currentHistoryTimeZone(),
  ): MaterializedHistoryIndex {
    const index = new MaterializedHistoryIndex(source, [], now, timeZone);
    const sorted = items
      .map((item) => ({
        ...item,
        title: { ...item.title },
        ...(item.episode ? { episode: { ...item.episode } } : {}),
      }))
      .sort(compareHistoryItems);
    for (const item of sorted) index.#append(item);
    return index;
  }

  static revision(source: HistoryIndexSource, timeZone: string): string {
    return `history-${HISTORY_INDEX_SCHEMA}.${HISTORY_INDEX_POLICY}:${encodeURIComponent(source.generation ?? 'local')}:${source.version}:${encodeURIComponent(source.revision)}:${encodeURIComponent(timeZone)}:${source.reconsiderAt ?? 'none'}`;
  }

  static restore(snapshot: HistoryIndexSnapshot): MaterializedHistoryIndex | null {
    if (
      snapshot.schema !== HISTORY_INDEX_SCHEMA ||
      snapshot.policy !== HISTORY_INDEX_POLICY ||
      !validSource(snapshot.source) ||
      !Number.isFinite(snapshot.builtAt) ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.length > 100_000 ||
      snapshot.items.some((item) => !validItem(item))
    )
      return null;
    const identities = new Set(snapshot.items.map((item) => titleKey(item.title)));
    if (identities.size !== snapshot.items.length) return null;
    return MaterializedHistoryIndex.fromItems(snapshot.source, snapshot.items, snapshot.builtAt);
  }

  get revision(): string {
    return this.#revision;
  }

  episodeCount(title: TitleRef): number {
    return this.#byTitle.get(titleKey(title))?.episodes ?? 0;
  }

  snapshot(): HistoryIndexSnapshot {
    return {
      schema: HISTORY_INDEX_SCHEMA,
      policy: HISTORY_INDEX_POLICY,
      source: { ...this.source },
      builtAt: this.builtAt,
      items: this.#all.map((item) => ({
        ...item,
        title: { ...item.title },
        ...(item.episode ? { episode: { ...item.episode } } : {}),
      })),
    };
  }

  /** Replace only one title after a foreground edit, without re-projecting or sorting the rest of the library. */
  update(
    title: TitleRef,
    documents: readonly DocumentRow[],
    source: HistoryIndexSource,
    now: number = Date.now(),
  ): void {
    const key = titleKey(title);
    const previous = this.#byTitle.get(key);
    if (previous) this.#remove(previous);
    const next = historyItemFromDocuments(documents, now);
    if (next) this.#add(next);
    Object.assign(this.source, source);
    this.#revision = MaterializedHistoryIndex.revision(this.source, this.timeZone);
  }

  hasSource(source: HistoryIndexSource, timeZone = currentHistoryTimeZone()): boolean {
    return (
      this.source.generation === source.generation &&
      this.source.version === source.version &&
      this.source.revision === source.revision &&
      this.timeZone === timeZone &&
      this.source.reconsiderAt === source.reconsiderAt
    );
  }

  page(
    filter: HistoryFilter = {},
    cursor?: HistoryCursor,
    limit = DEFAULT_LIMIT,
  ): HistoryPage | null {
    const items = this.#items(filter);
    const start = cursorPosition(items, this.#revision, filter, cursor);
    if (start === null) return null;
    const count = Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT));
    const page = items.slice(start, start + count);
    return {
      revision: this.#revision,
      filter,
      total: items.length,
      facets: this.#facets(),
      items: page,
      ...(start + page.length < items.length && page.length
        ? { nextCursor: historyCursorOf(this.#revision, filter, page.at(-1)!) }
        : {}),
    };
  }

  #items(filter: HistoryFilter): readonly HistoryItem[] {
    if (filter.type && filter.year) return this.#byTypeYear[filter.type].get(filter.year) ?? [];
    if (filter.type) return this.#byType[filter.type];
    if (filter.year) return this.#byYear.get(filter.year) ?? [];
    return this.#all;
  }

  #facets(): HistoryFacets {
    const years = [...this.#byYear]
      .map(([year, items]) => ({
        year,
        all: items.length,
        movie: this.#byTypeYear.movie.get(year)?.length ?? 0,
        tv: this.#byTypeYear.tv.get(year)?.length ?? 0,
      }))
      .sort((left, right) => {
        if (left.year === UNKNOWN_YEAR) return 1;
        if (right.year === UNKNOWN_YEAR) return -1;
        return Number(right.year) - Number(left.year);
      });
    return {
      all: this.#all.length,
      movie: this.#byType.movie.length,
      tv: this.#byType.tv.length,
      years,
    };
  }

  #add(item: HistoryItem): void {
    const key = titleKey(item.title);
    this.#byTitle.set(key, item);
    insert(this.#all, item);
    insert(this.#byType[item.title.type], item);
    const year = yearOf(item, this.timeZone);
    const years = this.#byYear.get(year) ?? [];
    if (!this.#byYear.has(year)) this.#byYear.set(year, years);
    insert(years, item);
    const typeYears = this.#byTypeYear[item.title.type];
    const typed = typeYears.get(year) ?? [];
    if (!typeYears.has(year)) typeYears.set(year, typed);
    insert(typed, item);
  }

  /** Hydrate a globally canonical stream without repeated array insertion and copying. */
  #append(item: HistoryItem): void {
    const key = titleKey(item.title);
    this.#byTitle.set(key, item);
    this.#all.push(item);
    this.#byType[item.title.type].push(item);
    const year = yearOf(item, this.timeZone);
    const years = this.#byYear.get(year) ?? [];
    if (!this.#byYear.has(year)) this.#byYear.set(year, years);
    years.push(item);
    const typeYears = this.#byTypeYear[item.title.type];
    const typed = typeYears.get(year) ?? [];
    if (!typeYears.has(year)) typeYears.set(year, typed);
    typed.push(item);
  }

  #remove(item: HistoryItem): void {
    const key = titleKey(item.title);
    this.#byTitle.delete(key);
    remove(this.#all, key);
    remove(this.#byType[item.title.type], key);
    const year = yearOf(item, this.timeZone);
    const years = this.#byYear.get(year);
    if (years) {
      remove(years, key);
      if (!years.length) this.#byYear.delete(year);
    }
    const typeYears = this.#byTypeYear[item.title.type];
    const typed = typeYears.get(year);
    if (typed) {
      remove(typed, key);
      if (!typed.length) typeYears.delete(year);
    }
  }
}

const validSource = (source: HistoryIndexSource): boolean =>
  (source.generation === null || typeof source.generation === 'string') &&
  Number.isSafeInteger(source.version) &&
  source.version >= 0 &&
  typeof source.revision === 'string' &&
  source.revision.length > 0 &&
  (source.reconsiderAt === null || Number.isFinite(source.reconsiderAt));

const validItem = (item: HistoryItem): boolean =>
  !!item &&
  (item.title?.type === 'movie' || item.title?.type === 'tv') &&
  Number.isSafeInteger(item.title.id) &&
  item.title.id > 0 &&
  Number.isFinite(item.watchedAt) &&
  item.watchedAt >= 0 &&
  Number.isSafeInteger(item.episodes) &&
  item.episodes >= 0 &&
  (!item.episode ||
    (item.title.type === 'tv' &&
      Number.isSafeInteger(item.episode.season) &&
      Number.isSafeInteger(item.episode.episode)));
