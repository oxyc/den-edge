// The TV's library, read from its backup snapshot (DenKit's LibrarySnapshot, as Swift's JSONEncoder writes
// it), and the TV's own rules for its Watchlist and Continue Watching rows (LibraryStore, EpisodeProgressStore
// and ContinueWatchingRow.list) — so the web shows the same rows in the same order.
//
// Swift's encoder writes a Date as seconds since 2001-01-01, Data as base64, and an Int-keyed dictionary as a
// flat [key, value, key, value] array.

import type { Row } from './wire';

export type MediaType = 'movie' | 'tv';

export interface Title {
  type: MediaType;
  id: number;
  title: string;
  posterPath?: string;
  year?: number;
  rating?: number;
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

interface Shape {
  /** Episode count per regular season. */
  counts: Map<number, number>;
  lastAired?: { season: number; episode: number };
}

export interface Library {
  records: LibraryRecord[];
  marks: Mark[];
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
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** A Swift Date (seconds since 2001) as milliseconds since 1970; anything else as 0. */
export function swiftDate(value: unknown): number {
  return typeof value === 'number' ? APPLE_EPOCH_MS + value * 1000 : 0;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function parseRecord(raw: unknown): LibraryRecord | null {
  const r = obj(raw);
  const id = obj(r.id);
  const type = id.mediaType;
  const tmdbId = num(id.id);
  if ((type !== 'movie' && type !== 'tv') || tmdbId === undefined) return null;
  const status = str(obj(r.status).value);
  return {
    title: {
      type,
      id: tmdbId,
      title: str(r.title) ?? '',
      posterPath: str(r.posterPath),
      year: num(r.year),
      rating: num(r.voteAverage),
    },
    status: status === 'watchlist' || status === 'inProgress' || status === 'watched' ? status : 'none',
    progress: num(obj(r.progress).value) ?? 0,
    progressAt: swiftDate(obj(r.progress).at),
    addedAt: swiftDate(r.addedAt),
    deleted: obj(r.isDeleted).value === true,
  };
}

function parseMark(raw: unknown): Mark | null {
  const m = obj(raw);
  const [id, season, episode] = [num(m.id), num(m.season), num(m.episode)];
  if (id === undefined || season === undefined || episode === undefined) return null;
  return {
    type: str(m.type) ?? '',
    id,
    season,
    episode,
    fraction: num(m.fraction) ?? 0,
    updatedAt: swiftDate(m.updatedAt),
    title: str(m.title) ?? '',
    posterPath: str(m.posterPath),
    voteAverage: num(m.voteAverage) ?? 0,
  };
}

function parseShape(raw: unknown): Shape {
  const s = obj(raw);
  const flat = Array.isArray(s.episodeCounts) ? s.episodeCounts : [];
  const counts = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [season, count] = [num(flat[i]), num(flat[i + 1])];
    if (season !== undefined && count !== undefined) counts.set(season, count);
  }
  const [season, episode] = [num(s.lastAiredSeason), num(s.lastAiredEpisode)];
  return { counts, lastAired: season !== undefined && episode !== undefined ? { season, episode } : undefined };
}

/** The episode progress the TV embeds as base64 JSON (EpisodeProgressStore's backup). */
function parseEpisodeProgress(base64: unknown): Pick<Library, 'marks' | 'shapes' | 'dismissed'> {
  const empty = { marks: [], shapes: new Map(), dismissed: new Map() };
  if (typeof base64 !== 'string') return empty;
  let backup: Json;
  try {
    backup = obj(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))));
  } catch {
    return empty;
  }
  return {
    marks: Object.values(obj(backup.marks)).map(parseMark).filter((m): m is Mark => m !== null),
    shapes: new Map(Object.entries(obj(backup.shapes)).map(([key, shape]) => [key, parseShape(shape)])),
    dismissed: new Map(Object.entries(obj(backup.dismissed)).map(([key, at]) => [key, swiftDate(at)])),
  };
}

export function parseSnapshot(snapshot: unknown): Library {
  const s = obj(snapshot);
  const records = (Array.isArray(s.records) ? s.records : [])
    .map(parseRecord)
    .filter((r): r is LibraryRecord => r !== null);
  return { records, ...parseEpisodeProgress(s.episodeProgress) };
}

const titleKey = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

/**
 * The record log's title rows over a backup's records. The log is the fresher of the two — the TV writes it on
 * every change and the backup only when asked — so its state wins. A title only the log knows arrives without
 * display (rows carry none); `untitled` and `withDisplay` fill it in from TMDB.
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
      const episode = { type: row.title.type, id: row.title.id, season: row.season, episode: row.episode };
      if (row.progress.value > 0) {
        // Display comes from the series' other marks, or TMDB once `untitled` asks for it.
        const series = marks.get(markKey(episode)) ?? [...marks.values()].find((m) => titleKey(m) === key);
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
    if (row.dismissed.value) dismissed.set(key, Math.max(dismissed.get(key) ?? -Infinity, row.dismissed.at[0]));
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

/** Titles the rows would show that have no display yet: library titles, and series only episode progress names. */
export function untitled(library: Library): { type: MediaType; id: number }[] {
  const refs = new Map<string, { type: MediaType; id: number }>();
  for (const r of library.records) {
    if (!r.deleted && r.title.title === '' && (r.status === 'watchlist' || r.status === 'inProgress')) {
      refs.set(titleKey(r.title), { type: r.title.type, id: r.title.id });
    }
  }
  for (const m of library.marks) {
    if (m.title === '' && (m.type === 'movie' || m.type === 'tv')) refs.set(titleKey(m), { type: m.type, id: m.id });
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
function episodeAfter(at: { season: number; episode: number }, shape: Shape) {
  const seasons = [...shape.counts.entries()].sort(([a], [b]) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b));
  const index = seasons.findIndex(([season]) => season === at.season);
  if (index < 0) return undefined;
  if (at.episode < (seasons[index]?.[1] ?? 0)) return { season: at.season, episode: at.episode + 1 };
  const next = seasons.slice(index + 1).find(([, count]) => count > 0);
  return next ? { season: next[0], episode: 1 } : undefined;
}

function isAired(at: { season: number; episode: number }, lastAired: Shape['lastAired']): boolean {
  if (!lastAired || lastAired.season <= 0) return true;
  return at.season < lastAired.season || (at.season === lastAired.season && at.episode <= lastAired.episode);
}

/** Started series (the episode to resume or start next), then in-progress movies, newest first. */
export function continueWatching(library: Library): ContinueEntry[] {
  const dismissedSince = (key: string, activity: number) => (library.dismissed.get(key) ?? -Infinity) >= activity;
  const watchedTitles = new Set(
    library.records.filter((r) => !r.deleted && r.status === 'watched').map((r) => titleKey(r.title)),
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
    .filter((r) => !r.deleted && r.status === 'inProgress' && r.title.type === 'movie' && r.title.title !== '')
    .sort((a, b) => b.progressAt - a.progressAt);
  for (const record of movies) {
    const key = titleKey(record.title);
    if (dismissedSince(key, record.progressAt) || seen.has(key)) continue;
    seen.add(key);
    entries.push({ title: record.title, fraction: record.progress });
  }
  return entries;
}
