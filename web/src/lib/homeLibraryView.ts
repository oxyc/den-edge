// The fixed library data Home consumes without receiving the full projection graph. Display metadata arrives from
// TMDB later. Continue Watching keeps only the policy inputs that can still be affected by those late TV shapes.

import { WATCHED } from './actions';
import { readDownloads, type Download } from './downloadRows';
import {
  ContinueProjector,
  nameContinueCandidates,
  standings,
  titleKey,
  type ContinueCandidate,
  type ContinueEntry,
  type Library,
  type Shape,
  type Standing,
} from './library';
import { readPrivateAddresses } from './privateAddresses';
import { readPlugins, readPrefs, type ServicePick } from './prefs';
import { tmdbKeyOf } from './tmdb';
import type { Row, SettingsRow, Stamp, TitleRow } from './wire';

export interface HomeLibraryView {
  /** Every active library title; Home uses this to keep discovery and billboard candidates novel. */
  owned: string[];
  /** The subset hidden when Hide Watched is enabled. */
  watched: string[];
  /** Watchlist shelf membership, newest addition first, before late title naming. */
  watchlist: string[];
  /** Poster-corner state, including episode-only in-progress series. */
  standings: Array<[key: string, standing: Standing]>;
  /** Atlas recommendation inputs: stable ref, weight, and recency. */
  weighted: Array<[key: string, weight: number, at: number]>;
  /** The two latest positive/watched and watchlisted titles used to form personal shelves. */
  seeds: {
    watched: string[];
    watchlisted: string[];
  };
  /** Every ref the initial shelves own while TV layouts are being named, in the existing priority order. */
  shelfRefs: string[];
  /** TV layouts whose arrival can change exact Continue membership. */
  requiredShapeRefs: string[];
  /** Exact Continue policy input with episode history reduced to at most two marks per series. */
  continueLibrary: Library;
  /** Download rows Home may draw, without asking the log to project every library document again. */
  downloads: Download[];
}

export interface ActiveHomeSettings {
  tmdbKey: string;
  plugins: string[];
  remux: string | null;
  prefs: {
    excludedGenres: number[];
    excludedLanguages: string[];
    hideAnime: boolean;
    hideWatched: boolean;
    minReleaseYear?: number;
    services: ServicePick[];
    servicesConfigured: boolean;
  };
}

/** The only first reply for the fast path. The decrypted snapshot and policy fold stay behind `handle`. */
export interface ActiveHomePayload {
  handle: number;
  view: Omit<HomeLibraryView, 'continueLibrary'> & { continue: ActiveHomeContinueCandidate[] };
  settings: ActiveHomeSettings;
  stamp: Stamp;
  reconsiderAt: number;
  at: number;
}

/** A compact policy answer plus any display already carried by the library's playback rows. */
export interface ActiveHomeContinueCandidate extends ContinueCandidate {
  title?: ContinueEntry['title'];
}

export interface ActiveHomeShapeReply {
  handle: number;
  continue: ActiveHomeContinueCandidate[];
}

export interface ActiveHomeHydrationChunk<THeader = Record<string, unknown>, TEntry = unknown> {
  handle: number;
  /** Snapshot fields other than `entries`, present on the first chunk only. */
  header?: THeader;
  entries: TEntry[];
  next: number;
  done: boolean;
}

export interface HomeLibraryViewProof {
  view: HomeLibraryView;
  digest: { hash: string; bytes: number };
}

export interface CurrentHomeLibraryInputs {
  library: Library;
  rows: Row[];
  titleRows: TitleRow[];
  reactions: ReadonlyMap<string, TitleRow['reaction']['value']>;
  selected: { watched: TitleRow[]; watchlisted: TitleRow[] };
  watched: ReadonlySet<string>;
  watchlist: string[];
  standings: ReadonlyMap<string, Standing>;
  weighted: Array<{
    ref: { type: 'movie' | 'tv'; id: number };
    weight: number;
    at: number;
  }>;
}

function settingsRows(rows: Row[]): Map<string, SettingsRow> {
  return new Map(rows.flatMap((row) => (row.kind === 'set' ? [[row.name, row] as const] : [])));
}

export function selectActiveHomeSettings(rows: Row[]): ActiveHomeSettings {
  const settings = settingsRows(rows);
  const prefs = readPrefs(settings.get('prefs'));
  return {
    tmdbKey: tmdbKeyOf(settings.get('keys')),
    plugins: readPlugins(settings.get('plugins')),
    remux: readPrivateAddresses(settings.get('addresses')).remux ?? null,
    prefs: {
      excludedGenres: [...prefs.excludedGenres],
      excludedLanguages: [...prefs.excludedLanguages],
      hideAnime: prefs.hideAnime,
      hideWatched: prefs.hideWatched,
      ...(prefs.minReleaseYear !== undefined ? { minReleaseYear: prefs.minReleaseYear } : {}),
      services: prefs.services,
      servicesConfigured: prefs.servicesConfigured,
    },
  };
}

function activeTitleRows(rows: Row[]): TitleRow[] {
  return rows.filter((row): row is TitleRow => row.kind === 'rec' && !row.deleted.value);
}

function selectedSeeds(rows: TitleRow[]) {
  const recency = (row: TitleRow) => Math.max(row.watchedAt ?? 0, row.reaction.at[0], row.addedAt);
  const compare = (a: TitleRow, b: TitleRow) =>
    recency(b) - recency(a) || titleKey(a.title).localeCompare(titleKey(b.title));
  const watched: TitleRow[] = [];
  const watchlisted: TitleRow[] = [];
  const offer = (selected: TitleRow[], row: TitleRow) => {
    const at = selected.findIndex((held) => compare(row, held) < 0);
    if (at < 0) {
      if (selected.length < 2) selected.push(row);
      return;
    }
    selected.splice(at, 0, row);
    if (selected.length > 2) selected.pop();
  };
  for (const row of rows) {
    if (
      row.status.value === 'watched' ||
      row.reaction.value === 'like' ||
      row.reaction.value === 'love'
    )
      offer(watched, row);
    if (row.status.value === 'watchlist') offer(watchlisted, row);
  }
  return { watched, watchlisted };
}

function weightOf(status: string, reaction: TitleRow['reaction']['value'] | undefined): number {
  if (reaction === 'dislike') return -1.5;
  const seen =
    status === 'watched' || status === 'inProgress' ? 1 : status === 'watchlist' ? 0.6 : 0;
  return seen + (reaction === 'love' ? 1 : reaction === 'like' ? 0.5 : 0);
}

const markKey = (mark: { type: string; id: number; season: number; episode: number }) =>
  `${mark.type}:${mark.id}:${mark.season}:${mark.episode}`;

const ahead = (a: { season: number; episode: number }, b: { season: number; episode: number }) =>
  a.season > b.season || (a.season === b.season && a.episode > b.episode);

/** The smallest ordinary `Library` on which the existing Continue projector makes the same decisions. */
export function compactContinueLibrary(library: Library): Library {
  const latest = new Map<string, Library['marks'][number]>();
  const finished = new Map<string, Library['marks'][number]>();
  const seriesOrder: string[] = [];
  for (const mark of library.marks) {
    if (mark.type !== 'tv') continue;
    const key = titleKey(mark);
    if (!latest.has(key)) seriesOrder.push(key);
    const held = latest.get(key);
    if (!held || mark.updatedAt > held.updatedAt) latest.set(key, mark);
    if (mark.fraction >= WATCHED) {
      const front = finished.get(key);
      if (!front || ahead(mark, front)) finished.set(key, mark);
    }
  }

  const furthestFlags = new Map<
    string,
    NonNullable<Library['flags']> extends Map<string, infer V> ? V : never
  >();
  const flagOrder: string[] = [];
  for (const flag of library.flags?.values() ?? []) {
    if (flag.type !== 'tv') continue;
    const key = titleKey(flag);
    if (!furthestFlags.has(key)) flagOrder.push(key);
    const front = furthestFlags.get(key);
    if (!front || ahead(flag, front)) furthestFlags.set(key, flag);
  }

  const activeSeries = new Set([...seriesOrder, ...flagOrder]);
  const records = library.records.filter((record) => {
    if (record.deleted) return false;
    const key = titleKey(record.title);
    if (record.title.type === 'movie') return record.status === 'inProgress';
    return (
      record.title.type === 'tv' &&
      activeSeries.has(key) &&
      (record.status === 'watched' || furthestFlags.has(key))
    );
  });
  const marks = seriesOrder.flatMap((key) => {
    const newest = latest.get(key)!;
    const front = finished.get(key);
    return front && markKey(front) !== markKey(newest) ? [newest, front] : [newest];
  });
  const flags = new Map(
    flagOrder.map((key) => {
      const flag = furthestFlags.get(key)!;
      return [markKey(flag), flag] as const;
    }),
  );
  const live = new Set([
    ...records.map((record) => titleKey(record.title)),
    ...seriesOrder,
    ...flagOrder,
  ]);
  return {
    records,
    marks,
    flags,
    shapes: new Map(),
    dismissed: new Map([...library.dismissed].filter(([key]) => live.has(key))),
  };
}

const unique = (keys: string[]) => [...new Set(keys)];

/** Select the fixed, render-facing Home inputs available at the Worker's initial fold. */
export function selectHomeLibraryView(library: Library, rows: Row[]): HomeLibraryView {
  const titles = activeTitleRows(rows);
  const reactions = new Map<string, TitleRow['reaction']['value']>();
  for (const row of titles) reactions.set(titleKey(row.title), row.reaction.value);
  const seeds = selectedSeeds(titles);
  const seedKeys = [...seeds.watched, ...seeds.watchlisted].map((row) => titleKey(row.title));
  const shelfRefs = unique([
    ...seedKeys,
    ...library.records
      .filter(
        (record) =>
          !record.deleted && (record.status === 'watchlist' || record.status === 'inProgress'),
      )
      .map((record) => titleKey(record.title)),
    ...library.marks.flatMap((mark) =>
      mark.type === 'movie' || mark.type === 'tv' ? [titleKey(mark)] : [],
    ),
  ]);
  const shaped = new Set([
    ...library.marks.flatMap((mark) => (mark.type === 'tv' ? [titleKey(mark)] : [])),
    ...[...(library.flags?.values() ?? [])].flatMap((flag) =>
      flag.type === 'tv' ? [titleKey(flag)] : [],
    ),
  ]);
  return {
    owned: [...new Set(titles.map((row) => titleKey(row.title)))],
    watched: library.records
      .filter((record) => !record.deleted && record.status === 'watched')
      .map((record) => titleKey(record.title)),
    watchlist: library.records
      .filter((record) => !record.deleted && record.status === 'watchlist')
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((record) => titleKey(record.title)),
    standings: [...standings(library)],
    weighted: library.records.flatMap((record) => {
      if (record.deleted) return [];
      const key = titleKey(record.title);
      const weight = weightOf(record.status, reactions.get(key));
      return weight === 0
        ? []
        : [[key, weight, Math.max(record.progressAt, record.addedAt)] as [string, number, number]];
    }),
    seeds: {
      watched: seeds.watched.map((row) => titleKey(row.title)),
      watchlisted: seeds.watchlisted.map((row) => titleKey(row.title)),
    },
    shelfRefs,
    requiredShapeRefs: shelfRefs.filter((key) => key.startsWith('tv:') && shaped.has(key)),
    continueLibrary: compactContinueLibrary(library),
    downloads: readDownloads(rows),
  };
}

/** Normalize the values Home currently derives on the page thread for comparison with the Worker proof. */
export function homeLibraryViewFromCurrent(inputs: CurrentHomeLibraryInputs): HomeLibraryView {
  const selected = selectHomeLibraryView(inputs.library, inputs.rows);
  return {
    owned: [...new Set(inputs.titleRows.map((row) => titleKey(row.title)))],
    watched: [...inputs.watched],
    watchlist: inputs.watchlist,
    standings: [...inputs.standings],
    weighted: inputs.weighted.map(({ ref, weight, at }) => [titleKey(ref), weight, at]),
    seeds: {
      watched: inputs.selected.watched.map((row) => titleKey(row.title)),
      watchlisted: inputs.selected.watchlisted.map((row) => titleKey(row.title)),
    },
    shelfRefs: selected.shelfRefs,
    requiredShapeRefs: selected.requiredShapeRefs,
    continueLibrary: selected.continueLibrary,
    downloads: selected.downloads,
  };
}

/** Convert the internal compact policy input into the clone-safe first-paint contract. */
export function activeHomeView(view: HomeLibraryView): ActiveHomePayload['view'] {
  const { continueLibrary, ...fixed } = view;
  const candidates = new ContinueProjector().project(continueLibrary);
  return {
    ...fixed,
    continue: withExistingContinueTitles(candidates, continueLibrary),
  };
}

function withExistingContinueTitles(
  candidates: ContinueCandidate[],
  library: Library,
): ActiveHomeContinueCandidate[] {
  const named = new Map(
    nameContinueCandidates(candidates, library).map((entry) => [
      titleKey(entry.title),
      entry.title,
    ]),
  );
  return candidates.map((candidate) => ({
    ...candidate,
    ...(named.get(titleKey(candidate.ref)) ? { title: named.get(titleKey(candidate.ref)) } : {}),
  }));
}

/** Re-run only Continue policy after the page names the required TV layouts. */
export function continueWithShapes(
  view: HomeLibraryView,
  shapes: ReadonlyArray<readonly [string, Shape]>,
): ActiveHomeContinueCandidate[] {
  const library = { ...view.continueLibrary, shapes: new Map(shapes) };
  return withExistingContinueTitles(new ContinueProjector().project(library), library);
}

/** A small synchronous fingerprint for development parity checks, not a persistence or security boundary. */
export function digestHomeLibraryView(view: HomeLibraryView): HomeLibraryViewProof['digest'] {
  const json = JSON.stringify(view);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    bytes: new TextEncoder().encode(json).byteLength,
  };
}

export function proveHomeLibraryView(library: Library, rows: Row[]): HomeLibraryViewProof {
  const view = selectHomeLibraryView(library, rows);
  return { view, digest: digestHomeLibraryView(view) };
}
