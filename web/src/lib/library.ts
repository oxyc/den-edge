// The library as the web shows it — the record log's rows (`applyLog`), named from TMDB — and the TV's own rules
// for its Watchlist and Continue Watching rows (LibraryStore, EpisodeProgressStore and ContinueWatchingRow.list),
// so the web shows the same rows in the same order.

import { syncPolicy } from './syncCore';
import type { Row } from './wire';

export type MediaType = 'movie' | 'tv';

export interface Title {
  type: MediaType;
  id: number;
  title: string;
  posterPath?: string;
  /**
   * Art for a title TMDB has no poster path for here, as a whole URL: atlas's service catalogs carry one per title,
   * keyed by IMDb id, which reaches titles its own dataset does not hold. Only ever set from such a catalog, and only
   * ever used when `posterPath` is absent, so TMDB stays the art everywhere it can be.
   */
  posterUrl?: string;
  /** Available in discovery results, before the full detail request finishes. */
  backdropPath?: string;
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
  /** Its IMDb id where whatever named it said so — scout keys availability by it, so no lookup is needed. */
  imdbId?: string;
  /**
   * When it arrives on a streaming service, or leaves one — epoch milliseconds, from atlas's chart (`denAt`, which
   * is in seconds). Only its leaving and coming charts carry one, and nothing else can: TMDB has no arrival date,
   * so without this a row of what is coming can be ordered only by the order it was sent in.
   */
  arrivesAt?: number;
  /** Which services a pooled row found it on, named for the card's caption ("Netflix", "Max"). */
  services?: string[];
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
  /**
   * Episodes known to be watched with no time behind it — a tracker import, written with the zero stamp.
   *
   * Apart from `marks` deliberately, and the TV keeps them apart for the same reason: such a bit says only
   * "this was watched". It is not a resume position and it carries no stamp to compare, so storing it as a
   * mark would put a fraction of 1 at the epoch into the history, where every later comparison reads real
   * progress as the older side. By `markKey`. Optional, so a library built before this stays valid.
   */
  flags?: Map<string, { type: string; id: number; season: number; episode: number }>;
  /** By `type:id`. */
  shapes: Map<string, Shape>;
  dismissed: Map<string, number>;
}

/**
 * What the shared policy says one episode row means for what we already hold (`episode_mark`).
 *
 * An action rather than a mark, because the TV and the web store watch state differently and neither shape
 * belongs in the policy: `clear` hold nothing, `keep` what is held still wins, `flag` watched but timeless,
 * `replace` take the row's figures.
 */
type EpisodeAction =
  | { action: 'clear' | 'keep' | 'flag' }
  | { action: 'replace'; fraction: number; at: number; seconds?: number };

/**
 * What Continue Watching should do with one series (`continue_entry`).
 *
 * `code` is what to branch on; `reason` is prose for whoever reads a log. Matching the prose is how a
 * dismissed series was once put back on the row. `episode` is null exactly when the action is `none`.
 */
type ContinueAnswer = {
  action: 'resume' | 'next' | 'start' | 'none';
  code: string;
  episode: { season: number; episode: number } | null;
  fraction: number;
  reason: string;
};

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
  return { records: [], marks: [], flags: new Map(), shapes: new Map(), dismissed: new Map() };
}

export const titleKey = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

/**
 * The record log's rows applied to `library`; the log's state wins. Rows carry no display, so a title arrives
 * unnamed until `untitled` and `withDisplay` fill it in from TMDB.
 *
 * **Requires an initialised sync core**, because it asks the shared policy what each row means. That holds in
 * the app by construction rather than by care: `LibraryLog.open()` awaits `ensureSyncPolicy()`, so a log
 * cannot exist before the core does, and this is only ever called with one. Anything that builds a log by
 * hand — a test fixture — must await it first, or every call here throws "Sync core is not initialized".
 * It is called from a `$derived`, which cannot await, so there is nowhere to fix this further down.
 */
export function applyLog(library: Library, rows: Row[]): Library {
  const records = new Map(library.records.map((r) => [titleKey(r.title), r]));
  const dismissed = new Map(library.dismissed);
  const marks = new Map(library.marks.map((m) => [markKey(m), m]));
  // A mark of each series, for the display a new episode mark borrows: scanning every mark per episode row was
  // quadratic in a long watch history.
  const seriesMarks = new Map(library.marks.map((m) => [titleKey(m), m]));
  const flags = new Map(library.flags ?? []);
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
      // What a row means for what we hold is the shared policy's to decide, so the TV and the web cannot
      // drift on it — above all on the zero stamp, which says "watched, time unknown". Written here as a
      // mark it became a fraction of 1 stamped at the epoch, and every later comparison then read real
      // progress as the older side, which is the opposite of what the stamp is for (wire/library-v2.md §3).
      //
      // Authoritative: `rows()` hands us one merged row per name out of the log's own store, so a row IS the
      // record rather than a claim about it, and there is nothing for it to outrank.
      const held = marks.get(markKey(episode));
      const decided = syncPolicy<EpisodeAction>({
        op: 'episode_mark',
        row,
        mark: held ? { fraction: held.fraction, at: held.updatedAt } : null,
        authoritative: true,
      });
      if (decided.action === 'clear') {
        marks.delete(markKey(episode));
        flags.delete(markKey(episode));
      } else if (decided.action === 'flag') {
        flags.set(markKey(episode), episode);
      } else if (decided.action === 'replace') {
        // Display comes from the series' other marks, or TMDB once `untitled` asks for it.
        const series = held ?? seriesMarks.get(key);
        const mark = {
          ...episode,
          fraction: decided.fraction,
          updatedAt: decided.at,
          title: series?.title ?? '',
          posterPath: series?.posterPath,
          voteAverage: series?.voteAverage ?? 0,
        };
        marks.set(markKey(episode), mark);
        seriesMarks.set(key, mark);
        // Real progress supersedes a timeless bit for the same episode.
        flags.delete(markKey(episode));
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
  // And every timeless bit for it, whenever it was learned. A flag has no stamp to compare, so it can never
  // lose the test above — and a series un-watched while fabricated "watched" bits survive would offer them
  // again on the next pull, and go on doing so forever.
  for (const [key, flag] of flags) {
    if (resets.has(titleKey(flag))) flags.delete(key);
  }
  return {
    ...library,
    records: [...records.values()],
    marks: [...marks.values()],
    flags,
    dismissed,
  };
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

  // Three summaries per series, because the policy asks three different questions of them and conflating any
  // two is a defect one of the clients actually shipped: where a resume would go (the mark touched last), how
  // far the series is actually finished (the furthest FINISHED mark, which is not the same episode), and how
  // far a timeless bit says it was watched. Watching E1–E4 and then opening E5 for two seconds leaves the
  // newest mark on E5 below the floor, and reading that alone drops a series being actively watched.
  const ahead = (a: { season: number; episode: number }, b: { season: number; episode: number }) =>
    a.season > b.season || (a.season === b.season && a.episode > b.episode);
  const latest = new Map<string, Mark>();
  const finished = new Map<string, { season: number; episode: number }>();
  const flagged = new Map<string, { season: number; episode: number }>();
  for (const mark of library.marks) {
    const key = titleKey(mark);
    const current = latest.get(key);
    if (!current || mark.updatedAt > current.updatedAt) latest.set(key, mark);
    if (mark.fraction >= WATCHED) {
      const front = finished.get(key);
      if (!front || ahead(mark, front))
        finished.set(key, { season: mark.season, episode: mark.episode });
    }
  }
  for (const flag of library.flags?.values() ?? []) {
    const key = titleKey(flag);
    const front = flagged.get(key);
    if (!front || ahead(flag, front))
      flagged.set(key, { season: flag.season, episode: flag.episode });
  }

  // A series known only through a flag has no time behind it, so it has no place in an order built on when
  // things were watched: it sorts last among the series rather than claiming the top.
  const series = [...new Set([...latest.keys(), ...flagged.keys()])].sort(
    (a, b) => (latest.get(b)?.updatedAt ?? -Infinity) - (latest.get(a)?.updatedAt ?? -Infinity),
  );
  for (const key of series) {
    const mark = latest.get(key);
    // A series known only through a bare watched flag has no mark to take its name and art from — a tracker
    // pull writes no progress — so the record carries the display instead. Without this such a series is
    // decided correctly and then dropped for want of a title, which is the same as never offering it.
    const title: Title | undefined = mark
      ? {
          type: mark.type as MediaType,
          id: mark.id,
          title: mark.title,
          posterPath: mark.posterPath,
          rating: mark.voteAverage,
        }
      : library.records.find((r) => !r.deleted && titleKey(r.title) === key)?.title;
    if (!title || title.title === '' || (title.type !== 'movie' && title.type !== 'tv')) continue;
    const shape = library.shapes.get(key);
    // Branch on `code`, never on `reason`: matching the prose swallowed "dismissed" once and put a dismissed
    // series back on the row.
    const answer = syncPolicy<ContinueAnswer>({
      op: 'continue_entry',
      mark: mark
        ? {
            season: mark.season,
            episode: mark.episode,
            fraction: mark.fraction,
            at: mark.updatedAt,
          }
        : null,
      finished: finished.get(key) ?? null,
      flag: flagged.get(key) ?? null,
      seasons: [...(shape?.counts ?? new Map())].map(([season, episodes]) => ({
        season,
        episodes,
      })),
      last_aired: shape?.lastAired ?? null,
      dismissed_at: library.dismissed.get(key) ?? null,
      title_watched: watchedTitles.has(key),
    });
    if (answer.action === 'none' || !answer.episode || seen.has(key)) continue;
    seen.add(key);
    entries.push({ title, fraction: answer.fraction, episode: answer.episode });
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
