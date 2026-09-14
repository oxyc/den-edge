// Everything the library has watched, newest first — the TV's Watchlist tab "Watched" section taken further. The TV
// lists only titles marked seen as a whole, so a series someone is halfway through appears nowhere but Continue
// Watching, and drops off that once caught up. Here a series counts from its first seen episode.

import { WATCHED } from './actions';
import { isAired, titleKey, type Shape, type Title } from './library';
import type { Row, TitleRow } from './wire';

export interface WatchedEntry {
  title: Title;
  /** When it was last watched (ms): the title seen as a whole, or its latest seen episode, whichever is later. */
  at: number;
  /** A series' latest seen episode. */
  episode?: { season: number; episode: number };
  /** How many of a series' episodes have been seen. */
  episodes: number;
}

interface SeenSeries {
  latest: { season: number; episode: number; at: number };
  count: number;
}

function titleRows(rows: Row[]): Map<string, TitleRow> {
  const titles = new Map<string, TitleRow>();
  for (const row of rows) {
    if (row.kind === 'rec') titles.set(titleKey(row.title), row);
  }
  return titles;
}

/** Each series' seen episodes: how many, and the latest. One from before the series was un-seen no longer counts. */
function seenSeries(rows: Row[], titles: Map<string, TitleRow>): Map<string, SeenSeries> {
  const series = new Map<string, SeenSeries>();
  for (const row of rows) {
    if (row.kind !== 'ep' || row.progress.value < WATCHED) continue;
    const key = titleKey(row.title);
    const at = row.progress.at[0];
    const reset = titles.get(key)?.episodesReset;
    if (reset && at <= reset[0]) continue;
    const seen = series.get(key);
    const episode = { season: row.season, episode: row.episode, at };
    if (!seen) series.set(key, { latest: episode, count: 1 });
    else {
      seen.count++;
      if (at > seen.latest.at) seen.latest = episode;
    }
  }
  return series;
}

/** How many episodes of each series have been seen, by `type:id`. */
export function seenEpisodeCounts(rows: Row[]): Map<string, number> {
  return new Map(
    [...seenSeries(rows, titleRows(rows))].map(([key, seen]) => [key, seen.count] as const),
  );
}

/** How many regular-season episodes have aired — what "4 of 10 episodes" counts to (SeriesProgress.airedEpisodes). */
export function airedEpisodes(shape: Shape): number {
  let aired = 0;
  for (const [season, count] of shape.counts) {
    if (season <= 0) continue;
    if (isAired({ season, episode: count }, shape.lastAired)) aired += count;
    else if (shape.lastAired?.season === season) aired += Math.min(count, shape.lastAired.episode);
  }
  return aired;
}

/**
 * The watched titles in `rows`, newest first. A title TMDB hasn't named yet (`names`, by `type:id`) waits, as the
 * library's other lists make it wait. An episode from before a series was un-seen (`episodesReset`) no longer counts,
 * and a title removed from the library after it was last watched is left out; watching it again brings it back.
 */
export function watchedHistory(rows: Row[], names: ReadonlyMap<string, Title>): WatchedEntry[] {
  const titles = titleRows(rows);
  const series = seenSeries(rows, titles);
  const entries: WatchedEntry[] = [];
  for (const key of new Set([...titles.keys(), ...series.keys()])) {
    const title = names.get(key);
    if (!title || title.title === '') continue;
    const row = titles.get(key);
    // A watchedAt of none (or the -1 some imports carry) falls back to when the status last changed.
    const seenAt =
      row?.status.value === 'watched'
        ? (row.watchedAt ?? 0) > 0
          ? (row.watchedAt as number)
          : row.status.at[0]
        : -Infinity;
    const episodes = series.get(key);
    const at = Math.max(seenAt, episodes?.latest.at ?? -Infinity);
    if (at === -Infinity || (row?.deleted.value && row.deleted.at[0] >= at)) continue;
    entries.push({
      title,
      at,
      episode: episodes && { season: episodes.latest.season, episode: episodes.latest.episode },
      episodes: episodes?.count ?? 0,
    });
  }
  return entries.sort((a, b) => b.at - a.at || titleKey(a.title).localeCompare(titleKey(b.title)));
}
