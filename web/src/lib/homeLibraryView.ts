// A proof of the library data Home can consume without receiving the full projection graph. This deliberately
// stops before display metadata and Continue Watching: names arrive from TMDB later, and exact TV continuation
// depends on season shapes owned by the page's LibrarySession rather than the initial library Worker.

import { standings, titleKey, type Library, type Standing } from './library';
import type { Row, TitleRow } from './wire';

type Reaction = NonNullable<TitleRow['reaction']['value']>;

export interface HomeLibraryView {
  /** Every active library title; Home uses this to keep discovery and billboard candidates novel. */
  owned: string[];
  /** The subset hidden when Hide Watched is enabled. */
  watched: string[];
  /** Watchlist shelf membership, newest addition first, before late title naming. */
  watchlist: string[];
  /** Poster-corner state, including episode-only in-progress series. */
  standings: Array<[key: string, standing: Standing]>;
  /** Explicit taste only; null reactions are equivalent to an absent entry for Home. */
  reactions: Array<[key: string, reaction: Reaction]>;
  /** Atlas recommendation inputs: stable ref, weight, and recency. */
  weighted: Array<[key: string, weight: number, at: number]>;
  /** The two latest positive/watched and watchlisted titles used to form personal shelves. */
  seeds: {
    watched: string[];
    watchlisted: string[];
  };
}

export interface HomeLibraryViewProof {
  view: HomeLibraryView;
  digest: { hash: string; bytes: number };
}

export interface CurrentHomeLibraryInputs {
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

/** Select the fixed, render-facing Home inputs available at the Worker's initial fold. */
export function selectHomeLibraryView(library: Library, rows: Row[]): HomeLibraryView {
  const titles = activeTitleRows(rows);
  const reactions = new Map<string, TitleRow['reaction']['value']>();
  for (const row of titles) reactions.set(titleKey(row.title), row.reaction.value);
  const seeds = selectedSeeds(titles);
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
    reactions: [...reactions].flatMap(([key, reaction]) =>
      reaction === null ? [] : [[key, reaction] as [string, Reaction]],
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
  };
}

/** Normalize the values Home currently derives on the page thread for comparison with the Worker proof. */
export function homeLibraryViewFromCurrent(inputs: CurrentHomeLibraryInputs): HomeLibraryView {
  return {
    owned: [...new Set(inputs.titleRows.map((row) => titleKey(row.title)))],
    watched: [...inputs.watched],
    watchlist: inputs.watchlist,
    standings: [...inputs.standings],
    reactions: [...inputs.reactions].flatMap(([key, reaction]) =>
      reaction === null ? [] : [[key, reaction] as [string, Reaction]],
    ),
    weighted: inputs.weighted.map(({ ref, weight, at }) => [titleKey(ref), weight, at]),
    seeds: {
      watched: inputs.selected.watched.map((row) => titleKey(row.title)),
      watchlisted: inputs.selected.watchlisted.map((row) => titleKey(row.title)),
    },
  };
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
