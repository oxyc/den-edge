// The library as the web shows it — the record log's rows (`applyLog`), named from TMDB — and the TV's own rules
// for its Watchlist and Continue Watching rows (LibraryStore, EpisodeProgressStore and ContinueWatchingRow.list),
// so the web shows the same rows in the same order.

import type { Row } from './wire';

export type MediaType = 'movie' | 'tv';

export interface Title {
  type: MediaType;
  id: number;
  title: string;
  posterPath?: string;
  year?: number;
  /** The full release date (`YYYY-MM-DD`) where TMDB gave one: a year can't tell last month from last January. */
  releaseDate?: string;
  rating?: number;
  /** How many votes that rating rests on — a 9.4 from eleven people is not a recommendation. */
  votes?: number;
  /** TMDB's popularity: how much attention it is getting now, which an unreleased title can have and a rating
      can't measure. The billboard uses it to tell an awaited film from an untracked micro-release. */
  popularity?: number;
  /** Where it was made (ISO-3166 alpha-2). A better reading of "Nordic" than the language is: the region's
      co-productions are routinely in two or three languages, and often in English. */
  countries?: string[];
  /** Its director and the top of its billing, by TMDB person id: the people a household follows are a taste of
      their own, and the one signal that crosses genres. */
  people?: number[];
  /** The TMDB collection a movie belongs to (from a detail fetch), so search can group a franchise. */
  collectionId?: number;
  /** What the TV's hide rules look at (`prefs.ts`): TMDB genre ids, original language, the adult flag. */
  genreIds?: number[];
  originalLanguage?: string;
  adult?: boolean;
}

type Status = 'none' | 'watchlist' | 'inProgress' | 'watched';

interface LibraryRecord {
  title: Title;
  status: Status;
  progress: number;
  progressAt: number;
  addedAt: number;
  deleted: boolean;
}

interface Mark {
  type: string;
  id: number;
  season: number;
  episode: number;
  fraction: number;
  updatedAt: number;
  title: string;
  posterPath?: string;
  voteAverage: number;
}

/** A series' season layout, which Continue Watching needs to find the next episode. */
export interface Shape {
  /** Episode count per season. */
  counts: Map<number, number>;
  lastAired?: { season: number; episode: number };
}

export interface Library {
  records: LibraryRecord[];
  marks: Mark[];
  /** By `type:id`. */
  shapes: Map<string, Shape>;
  dismissed: Map<string, number>;
}

export interface ContinueEntry {
  title: Title;
  /** 0…1 into the movie or episode. */
  fraction: number;
  /** The episode to resume or start next, for a series. */
  episode?: { season: number; episode: number };
}

/** The ≥95% auto-watched threshold (LibraryRecord.watchedThreshold). */
const WATCHED = 0.95;

export function emptyLibrary(): Library {
  return { records: [], marks: [], shapes: new Map(), dismissed: new Map() };
}

export const titleKey = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

/**
 * The record log's rows applied to `library`; the log's state wins. Rows carry no display, so a title arrives
 * unnamed until `untitled` and `withDisplay` fill it in from TMDB.
 */
export function applyLog(library: Library, rows: Row[]): Library {
  const records = new Map(library.records.map((r) => [titleKey(r.title), r]));
  const dismissed = new Map(library.dismissed);
  const marks = new Map(library.marks.map((m) => [markKey(m), m]));
  const resets = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === 'set') continue; // settings are read by prefs.ts
    if (row.title.type !== 'movie' && row.title.type !== 'tv') continue;
    const key = titleKey(row.title);
    if (row.kind === 'ep') {
      const episode = {
        type: row.title.type,
        id: row.title.id,
        season: row.season,
        episode: row.episode,
      };
      if (row.progress.value > 0) {
        // Display comes from the series' other marks, or TMDB once `untitled` asks for it.
        const series =
          marks.get(markKey(episode)) ?? [...marks.values()].find((m) => titleKey(m) === key);
        marks.set(markKey(episode), {
          ...episode,
          fraction: row.progress.value,
          updatedAt: row.progress.at[0],
          title: series?.title ?? '',
          posterPath: series?.posterPath,
          voteAverage: series?.voteAverage ?? 0,
        });
      } else {
        marks.delete(markKey(episode)); // un-watched
      }
      continue;
    }
    if (row.episodesReset) resets.set(key, row.episodesReset[0]);
    records.set(key, {
      title: records.get(key)?.title ?? { type: row.title.type, id: row.title.id, title: '' },
      status: row.status.value,
      progress: row.resume.value,
      progressAt: row.resume.at[0],
      addedAt: row.addedAt,
      deleted: row.deleted.value,
    });
    if (row.dismissed.value)
      dismissed.set(key, Math.max(dismissed.get(key) ?? -Infinity, row.dismissed.at[0]));
  }
  // A whole series un-watched: every episode progress from before it goes.
  for (const [key, mark] of marks) {
    const reset = resets.get(titleKey(mark));
    if (reset !== undefined && mark.updatedAt <= reset) marks.delete(key);
  }
  return { ...library, records: [...records.values()], marks: [...marks.values()], dismissed };
}

const markKey = (m: { type: string; id: number; season: number; episode: number }) =>
  `${m.type}:${m.id}:${m.season}:${m.episode}`;

/**
 * Titles with no display yet: the ones the rows would show, and series that only episode progress names.
 *
 * Watched titles are named too, though no row lists them. What has been watched is the only record of what this
 * viewer likes — its genres and its language are the whole taste signal — and an unnamed record carries neither.
 * Leaving them out let the billboard fill with horror and action for a household that watches Nordic crime.
 */
export function untitled(library: Library): { type: MediaType; id: number }[] {
  const refs = new Map<string, { type: MediaType; id: number }>();
  for (const r of library.records) {
    const wanted = r.status === 'watchlist' || r.status === 'inProgress' || r.status === 'watched';
    if (!r.deleted && r.title.title === '' && wanted) {
      refs.set(titleKey(r.title), { type: r.title.type, id: r.title.id });
    }
  }
  for (const m of library.marks) {
    if (m.title === '' && (m.type === 'movie' || m.type === 'tv'))
      refs.set(titleKey(m), { type: m.type, id: m.id });
  }
  return [...refs.values()];
}

export function withDisplay(library: Library, titles: Title[]): Library {
  const byKey = new Map(titles.map((t) => [titleKey(t), t]));
  return {
    ...library,
    records: library.records.map((r) => ({ ...r, title: byKey.get(titleKey(r.title)) ?? r.title })),
    marks: library.marks.map((m) => {
      const t = m.title === '' ? byKey.get(titleKey(m)) : undefined;
      return t ? { ...m, title: t.title, posterPath: t.posterPath, voteAverage: t.rating ?? 0 } : m;
    }),
  };
}

/** Newest additions first, as the TV lists them. A title with no display yet waits, as on the TV. */
export function watchlist(library: Library): Title[] {
  return library.records
    .filter((r) => !r.deleted && r.status === 'watchlist' && r.title.title !== '')
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((r) => r.title);
}

/** The next episode in season order (Specials last), or none past the end — SeriesProgress.episode(after:). */
export function episodeAfter(at: { season: number; episode: number }, shape: Shape) {
  const seasons = [...shape.counts.entries()].sort(
    ([a], [b]) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b),
  );
  const index = seasons.findIndex(([season]) => season === at.season);
  if (index < 0) return undefined;
  if (at.episode < (seasons[index]?.[1] ?? 0))
    return { season: at.season, episode: at.episode + 1 };
  const next = seasons.slice(index + 1).find(([, count]) => count > 0);
  return next ? { season: next[0], episode: 1 } : undefined;
}

export function isAired(
  at: { season: number; episode: number },
  lastAired: Shape['lastAired'],
): boolean {
  if (!lastAired || lastAired.season <= 0) return true;
  return (
    at.season < lastAired.season ||
    (at.season === lastAired.season && at.episode <= lastAired.episode)
  );
}

/** Started series (the episode to resume or start next), then in-progress movies, newest first. */
export function continueWatching(library: Library): ContinueEntry[] {
  const dismissedSince = (key: string, activity: number) =>
    (library.dismissed.get(key) ?? -Infinity) >= activity;
  const watchedTitles = new Set(
    library.records
      .filter((r) => !r.deleted && r.status === 'watched')
      .map((r) => titleKey(r.title)),
  );
  const seen = new Set<string>();
  const entries: ContinueEntry[] = [];

  const latest = new Map<string, Mark>();
  for (const mark of library.marks) {
    const current = latest.get(titleKey(mark));
    if (!current || mark.updatedAt > current.updatedAt) latest.set(titleKey(mark), mark);
  }
  const marks = [...latest.values()]
    .filter((m) => m.fraction > 0.02 && m.title !== '' && (m.type === 'movie' || m.type === 'tv'))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const mark of marks) {
    const key = titleKey(mark);
    if (dismissedSince(key, mark.updatedAt) || watchedTitles.has(key) || seen.has(key)) continue;
    const title: Title = {
      type: mark.type as MediaType,
      id: mark.id,
      title: mark.title,
      posterPath: mark.posterPath,
      rating: mark.voteAverage,
    };
    const shape = library.shapes.get(key);
    let episode = { season: mark.season, episode: mark.episode };
    let fraction = mark.fraction;
    if (mark.fraction >= WATCHED && shape) {
      const next = episodeAfter(episode, shape);
      if (!next || !isAired(next, shape.lastAired)) continue;
      episode = next;
      fraction = 0;
    }
    seen.add(key);
    entries.push({ title, fraction, episode });
  }

  const movies = library.records
    .filter(
      (r) =>
        !r.deleted && r.status === 'inProgress' && r.title.type === 'movie' && r.title.title !== '',
    )
    .sort((a, b) => b.progressAt - a.progressAt);
  for (const record of movies) {
    const key = titleKey(record.title);
    if (dismissedSince(key, record.progressAt) || seen.has(key)) continue;
    seen.add(key);
    entries.push({ title: record.title, fraction: record.progress });
  }
  return entries;
}
