// "Download my history" (oxyc/den#164): the library's watch history as files other trackers can import, built in the
// browser from the decrypted v4 documents (den-spec wire/library-v4.md), since nothing else can read them. A title's
// status, reaction and every viewing are den-core's derivation (`title_state`, `film_state_v4`,
// `episode_state_v4`), so the export shows the plays Den itself shows: an un-watched viewing or one before a reset
// is not history any more.

import { titleKey, type Title } from './library';
import { syncPolicy } from './syncCore';
import type { DocumentRow, Stamped } from './wire';

type Status = 'none' | 'watchlist' | 'inProgress' | 'watched';
type Reaction = 'seen' | 'dislike' | 'like' | 'love';

/** One viewing. `watchedAt` is null when the library knows it was watched but not when. */
export interface ExportedPlay {
  watchedAt: string | null;
  /** A viewing after the first of the same film or episode. */
  rewatch: boolean;
  /** `den` for a viewing Den recorded; `import` for one a tracker or an import brought in. */
  source: 'den' | 'import';
}

export interface ExportedEpisode {
  season: number;
  episode: number;
  plays: ExportedPlay[];
}

export interface ExportedTitle {
  type: 'movie' | 'tv';
  tmdbId: number;
  imdbId: string | null;
  title: string | null;
  year: number | null;
  status: Status;
  watchlist: boolean;
  reaction: Reaction | null;
  /** The reaction on a 1–10 scale, as Den sends it to Simkl and Trakt: love 10, like 7, dislike 2. */
  rating: number | null;
  addedAt: string | null;
  /** A film's viewings. */
  plays?: ExportedPlay[];
  /** A series' viewed episodes, by season and episode. */
  episodes?: ExportedEpisode[];
}

export interface HistoryExport {
  format: 'den-history';
  version: 1;
  exportedAt: string;
  titles: ExportedTitle[];
}

const RATINGS: Partial<Record<Reaction, number>> = { love: 10, like: 7, dislike: 2 };

/** An episode key library v4 derives from (§3): canonical decimal, 0–99999. */
const EPISODE_KEY = /^(0|[1-9]\d{0,4})$/;

interface WatchState {
  watched: boolean;
  plays: [number, number][];
  watched_at: number | null;
}

const iso = (ms: number | null | undefined) => (ms && ms > 0 ? new Date(ms).toISOString() : null);

/** The visible plays, oldest first; a watch the library has no play for is one undated (or `watched_at`) viewing. */
function playsOf(state: WatchState): ExportedPlay[] {
  const plays = [...state.plays].sort(([ka, a], [kb, b]) => a - b || ka - kb);
  if (!plays.length)
    return state.watched
      ? [{ watchedAt: iso(state.watched_at), rewatch: false, source: 'import' }]
      : [];
  return plays.map(([key, at], index) => ({
    watchedAt: iso(at),
    rewatch: index > 0,
    source: key < 0 ? 'import' : 'den',
  }));
}

/**
 * The export of `documents` (a library's v4 documents, as `LibraryLog.documents` holds them), named from `names` (TMDB
 * titles by `type:id`; a title not in it is exported by its ids alone). A title removed from the library is left out,
 * and so is one that holds nothing: no status, no reaction, no viewing.
 */
export function buildHistoryExport(
  documents: readonly DocumentRow[],
  names: ReadonlyMap<string, Title>,
  now = Date.now(),
): HistoryExport {
  const titleDocs = new Map<string, DocumentRow>();
  const seasonDocs = new Map<string, DocumentRow[]>();
  for (const document of documents) {
    const key = titleKey(document.title);
    if (document.kind === 'title') titleDocs.set(key, document);
    else if (document.kind === 'season' && document.title.type === 'tv')
      seasonDocs.set(key, [...(seasonDocs.get(key) ?? []), document]);
  }

  const titles: ExportedTitle[] = [];
  for (const key of new Set([...titleDocs.keys(), ...seasonDocs.keys()])) {
    const document = titleDocs.get(key);
    const ref = document?.title ?? seasonDocs.get(key)![0]!.title;
    const state = document
      ? syncPolicy<{
          status: Stamped<Status> | null;
          reaction: Stamped<Reaction | null> | null;
          deleted: Stamped<boolean> | null;
          addedAt: number | null;
        }>({ op: 'title_state', title: document, now })
      : null;
    if (state?.deleted?.value) continue;

    let plays: ExportedPlay[] | undefined;
    let episodes: ExportedEpisode[] | undefined;
    if (ref.type === 'movie' && document) {
      plays = playsOf(syncPolicy<WatchState>({ op: 'film_state_v4', title: document, now }));
    } else if (ref.type === 'tv') {
      episodes = [];
      const seasons = [...(seasonDocs.get(key) ?? [])].sort(
        (a, b) => (a.season ?? 0) - (b.season ?? 0),
      );
      for (const season of seasons) {
        const keys = Object.keys((season.episodes as Record<string, unknown> | undefined) ?? {})
          .filter((episode) => EPISODE_KEY.test(episode))
          .sort((a, b) => Number(a) - Number(b));
        for (const episode of keys) {
          const watched = playsOf(
            syncPolicy<WatchState>({
              op: 'episode_state_v4',
              ...(document ? { title: document } : {}),
              season,
              episode,
              now,
            }),
          );
          if (watched.length)
            episodes.push({ season: season.season ?? 0, episode: Number(episode), plays: watched });
        }
      }
    }

    const status = state?.status?.value ?? 'none';
    const reaction = state?.reaction?.value ?? null;
    if (status === 'none' && !reaction && !plays?.length && !episodes?.length) continue;
    const name = names.get(key);
    titles.push({
      type: ref.type,
      tmdbId: ref.id,
      imdbId: name?.imdbId ?? null,
      title: name?.title || null,
      year: name?.year ?? null,
      status,
      watchlist: status === 'watchlist',
      reaction,
      rating: (reaction && RATINGS[reaction]) ?? null,
      addedAt: iso(state?.addedAt),
      ...(plays ? { plays } : {}),
      ...(episodes ? { episodes } : {}),
    });
  }
  titles.sort((a, b) => (a.type === b.type ? a.tmdbId - b.tmdbId : a.type < b.type ? -1 : 1));
  return { format: 'den-history', version: 1, exportedAt: new Date(now).toISOString(), titles };
}

/**
 * The CSV's columns. `kind` says what a line is: `watch`, one viewing; else a title with no viewing, by its status
 * (`watchlist`, `in_progress`, `watched`) or, with none, `rating` for a title that holds only a reaction.
 */
export const CSV_COLUMNS = [
  'kind',
  'type',
  'tmdb_id',
  'imdb_id',
  'title',
  'year',
  'season',
  'episode',
  'watched_at',
  'rewatch',
  'source',
  'status',
  'watchlist',
  'reaction',
  'rating',
] as const;

const cell = (value: string | number | boolean | null) => {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const KINDS: Record<Status, string> = {
  none: 'rating',
  watchlist: 'watchlist',
  inProgress: 'in_progress',
  watched: 'watched',
};

/**
 * The export as CSV (RFC 4180), the library as a record: one `watch` line per viewing — a film's, or an episode's with
 * its season and episode — newest first and the undated last; then one line for each title with no viewing (`kind`
 * from its status, or `rating`), with `watched_at` empty.
 */
export function historyCsv(history: HistoryExport): string {
  const watches: Line[] = [];
  const others: Line[] = [];
  for (const title of history.titles) {
    const cells = (
      kind: string,
      play: ExportedPlay | null,
      season: number | null,
      episode: number | null,
    ) => [
      kind,
      title.type,
      title.tmdbId,
      title.imdbId,
      title.title,
      title.year,
      season,
      episode,
      play?.watchedAt ?? null,
      play?.rewatch ?? null,
      play?.source ?? null,
      title.status,
      title.watchlist,
      title.reaction,
      title.rating,
    ];
    const before = watches.length;
    for (const play of title.plays ?? [])
      watches.push({ at: play.watchedAt, cells: cells('watch', play, null, null) });
    for (const watched of title.episodes ?? [])
      for (const play of watched.plays)
        watches.push({
          at: play.watchedAt,
          cells: cells('watch', play, watched.season, watched.episode),
        });
    if (watches.length === before)
      others.push({ at: null, cells: cells(KINDS[title.status], null, null, null) });
  }
  return csv(CSV_COLUMNS, watches, others);
}

interface Line {
  at: string | null;
  cells: (string | number | boolean | null)[];
}

/** `lines` under `columns`, newest first and the undated last, then `after` as it is. */
function csv(columns: readonly string[], lines: Line[], after: Line[] = []): string {
  // ISO strings sort as their instants; a stable sort keeps a title's and a season's own order within one instant.
  lines.sort((a, b) =>
    a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at < b.at ? 1 : -1,
  );
  return [columns.join(','), ...[...lines, ...after].map((l) => l.cells.map(cell).join(','))]
    .map((l) => `${l}\r\n`)
    .join('');
}

/** Letterboxd's import columns (letterboxd.com/about/importing-data). */
export const LETTERBOXD_COLUMNS = [
  'Title',
  'Year',
  'imdbID',
  'tmdbID',
  'WatchedDate',
  'Rating10',
  'Rewatch',
] as const;

/**
 * The films as Letterboxd's import reads them: one line per viewing, which Letterboxd logs as a diary entry on its
 * `WatchedDate` (the UTC day). A viewing with no date has an empty `WatchedDate`, which Letterboxd marks watched
 * without a diary entry. Series have no place in Letterboxd and are left out, as are films with no viewing.
 */
export function letterboxdCsv(history: HistoryExport): string {
  const lines = history.titles
    .filter((title) => title.type === 'movie')
    .flatMap((title) =>
      (title.plays ?? []).map((play) => ({
        at: play.watchedAt,
        cells: [
          title.title,
          title.year,
          title.imdbId,
          title.tmdbId,
          play.watchedAt?.slice(0, 10) ?? null,
          title.rating,
          play.rewatch,
        ],
      })),
    );
  return csv(LETTERBOXD_COLUMNS, lines);
}
