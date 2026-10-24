// The fixed library data Home consumes without receiving the full projection graph. Display metadata arrives from
// TMDB later. Continue Watching keeps only the policy inputs that can still be affected by those late TV shapes.

import { deviceName, readDownloads, type Download } from './downloadRows';
import {
  compactContinueLibrary,
  standings,
  titleKey,
  type ContinueProjector,
  type Library,
  type Standing,
} from './library';
import type { LibrarySelectionValue } from './libraryServiceProtocol';
import type { Row, SettingsRow, TitleRow } from './wire';

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

export interface HomeLibraryViewProof {
  view: HomeLibraryView;
  digest: { hash: string; bytes: number };
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

const unique = (keys: string[]) => [...new Set(keys)];

/** Select the fixed, render-facing Home inputs available at the Worker's initial fold. */
export function selectHomeLibraryViewFromFold(
  library: Library,
  titles: TitleRow[],
  downloads: Download[] = [],
): HomeLibraryView {
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
  /** When each series was last watched, so Continue Watching asks for the layouts it shows first, newest first. */
  const watchedAt = new Map<string, number>();
  for (const mark of library.marks)
    if (mark.type === 'tv')
      watchedAt.set(titleKey(mark), Math.max(watchedAt.get(titleKey(mark)) ?? 0, mark.updatedAt));
  return {
    owned: [...new Set(titles.map((row) => titleKey(row.title)))],
    watched: library.records
      .filter((record) => !record.deleted && record.status === 'watched')
      .map((record) => titleKey(record.title)),
    watchlist: library.records
      .filter((record) => !record.deleted && record.status === 'watchlist')
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((record) => titleKey(record.title)),
    // In key order: `standings` keeps the order marks were made in, which an episode mark moves without changing one
    // title's standing, and a saved recommendations piece that says the same is not written again.
    standings: [...standings(library)].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
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
    requiredShapeRefs: shelfRefs
      .filter((key) => key.startsWith('tv:') && shaped.has(key))
      .sort((left, right) => (watchedAt.get(right) ?? 0) - (watchedAt.get(left) ?? 0)),
    continueLibrary: compactContinueLibrary(library),
    downloads,
  };
}

/**
 * Continue Watching's items as `projector` decides them, each naming the device it was last watched on from the
 * library's `devices` row: the one projection of them the whole log and the fact store both answer with.
 */
export function continueItems(
  projector: ContinueProjector,
  library: Library,
  devices: SettingsRow | undefined,
): Extract<LibrarySelectionValue, { kind: 'continue' }>['items'] {
  return projector
    .project(library)
    .map(({ ref, fraction, episode, seconds, at, liveEpisode, liveFraction, by }) => {
      const device = by && deviceName(devices, by)?.slice(0, 256);
      return {
        title: { type: ref.type, id: ref.id },
        fraction,
        ...(episode ? { episode } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(at !== undefined ? { updatedAt: at } : {}),
        ...(liveEpisode ? { liveEpisode } : {}),
        ...(liveFraction !== undefined ? { liveFraction } : {}),
        ...(device ? { device } : {}),
      };
    });
}

export function selectHomeLibraryView(library: Library, rows: Row[]): HomeLibraryView {
  return selectHomeLibraryViewFromFold(library, activeTitleRows(rows), readDownloads(rows));
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
