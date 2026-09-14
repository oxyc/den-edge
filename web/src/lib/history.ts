// Everything the library has watched, newest first — the TV's Watchlist tab "Watched" section taken further. The TV
// lists only titles marked seen as a whole, so a series someone is halfway through appears nowhere but Continue
// Watching, and drops off that once caught up. Here a series counts from its first seen episode.

import { WATCHED } from './actions';
import { isAired, titleKey, type Shape, type Title } from './library';
import type { Row, TitleRow } from './wire';

export interface WatchedEntry {
  title: Title;
  /**
   * When it was last watched (ms): the title seen as a whole, or its latest seen episode, whichever is later. 0 when
   * the library only knows that it was, not when — a watch imported from a tracker is stamped at zero.
   */
  at: number;
  /** A series' latest seen episode. */
  episode?: { season: number; episode: number };
  /** How many of a series' episodes have been seen. */
  episodes: number;
}

export interface SeenEpisode {
  season: number;
  episode: number;
}

interface SeenSeries {
  latest: SeenEpisode & { at: number };
  seen: SeenEpisode[];
}

function titleRows(rows: Row[]): Map<string, TitleRow> {
  const titles = new Map<string, TitleRow>();
  for (const row of rows) {
    if (row.kind === 'rec') titles.set(titleKey(row.title), row);
  }
  return titles;
}

/** Each series' seen episodes, and the latest. One from before the series was un-seen no longer counts. */
function seenSeries(rows: Row[], titles: Map<string, TitleRow>): Map<string, SeenSeries> {
  const series = new Map<string, SeenSeries>();
  for (const row of rows) {
    if (row.kind !== 'ep' || row.progress.value < WATCHED) continue;
    const key = titleKey(row.title);
    const at = row.progress.at[0];
    const reset = titles.get(key)?.episodesReset;
    if (reset && at <= reset[0]) continue;
    const found = series.get(key);
    const episode = { season: row.season, episode: row.episode };
    if (!found) series.set(key, { latest: { ...episode, at }, seen: [episode] });
    else {
      found.seen.push(episode);
      if (at > found.latest.at) found.latest = { ...episode, at };
    }
  }
  return series;
}

/** The episodes seen of each series, by `type:id`. */
export function seenEpisodes(rows: Row[]): Map<string, SeenEpisode[]> {
  return new Map(
    [...seenSeries(rows, titleRows(rows))].map(([key, found]) => [key, found.seen] as const),
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
 * The seen episodes that count towards `airedEpisodes`: regular seasons, aired, and in the layout — so a seen Special,
 * or an episode the layout doesn't know yet, can't make "10 of 10" out of seven.
 */
export function seenAired(seen: readonly SeenEpisode[], shape: Shape | undefined): number {
  return seen.filter(
    (e) =>
      e.season > 0 &&
      (!shape || (e.episode <= (shape.counts.get(e.season) ?? 0) && isAired(e, shape.lastAired))),
  ).length;
}

/**
 * The watched titles in `rows`, newest first, then those watched at a time the library doesn't know. A title TMDB
 * hasn't named yet (`names`, by `type:id`) waits, as the library's other lists make it wait. An episode from before a
 * series was un-seen (`episodesReset`) no longer counts, and a title removed from the library after it was last
 * watched is left out; watching it again brings it back.
 */
export function watchedHistory(rows: Row[], names: ReadonlyMap<string, Title>): WatchedEntry[] {
  const titles = titleRows(rows);
  const series = seenSeries(rows, titles);
  const entries: WatchedEntry[] = [];
  for (const key of new Set([...titles.keys(), ...series.keys()])) {
    const title = names.get(key);
    if (!title || title.title === '') continue;
    const row = titles.get(key);
    // `watchedAt` is the first watch, so a title seen again is dated by the status set since; an import that stamped
    // its status at zero keeps the first watch. -1, which some imports carry, is no time at all.
    const seenAt =
      row?.status.value === 'watched' ? Math.max(row.watchedAt ?? 0, row.status.at[0], 0) : -1;
    const episodes = series.get(key);
    const at = Math.max(seenAt, episodes ? Math.max(episodes.latest.at, 0) : -1);
    if (at < 0 || (row?.deleted.value && row.deleted.at[0] >= at)) continue;
    entries.push({
      title,
      at,
      episode: episodes && { season: episodes.latest.season, episode: episodes.latest.episode },
      episodes: episodes?.seen.length ?? 0,
    });
  }
  // A watch with no time sorts after every dated one, as `at` 0 already does.
  return entries.sort((a, b) => b.at - a.at || titleKey(a.title).localeCompare(titleKey(b.title)));
}
