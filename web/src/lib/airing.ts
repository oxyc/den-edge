// Episode release dates from den-atlas's `POST /airing` (TVmaze's schedule): the one date every series surface reads.
//
// TMDB dates an episode by its broadcaster's slot, which for a streaming release is often days late (Dexter:
// Resurrection S2E1 was on Paramount+ on Friday 30 Oct; TMDB said Sunday 1 Nov). Atlas answers with TVmaze's
// calendar date and service for the series a client follows. Where atlas has no answer, TMDB's date stands.
import type { Episode } from './detail';
import { calendarDate, futureDate } from './detailPresentation';

export type AiringStatus = 'running' | 'ended' | 'tbd' | 'development' | 'unknown';

export interface AiringEpisode {
  season: number;
  episode: number;
  name?: string;
  /** A calendar date (`YYYY-MM-DD`), never an instant. */
  date: string;
}

export interface Airing {
  source: 'tvmaze' | 'tmdb';
  status: AiringStatus;
  /** The streaming service or network, when known. */
  service: string | null;
  next?: AiringEpisode;
  previous?: AiringEpisode;
  /** Episodes due in the next 14 days. */
  upcoming: AiringEpisode[];
  /** The next or current season's first episode. */
  seasonPremiere?: { season: number; date: string };
}

/** One series as atlas is asked for it. */
export interface AiringSeries {
  tmdb: number;
  imdb?: string;
}

/**
 * Series asked for at once. One `GET /airing/tv/{id}` per series, so each answer is shared by every HTTP cache in front
 * of atlas; this bounds how many of a large library's are in flight together.
 */
export const AIRING_CONCURRENCY = 6;
/** How long an answer is kept when it names no `max-age`. */
export const AIRING_MAX_AGE_SECONDS = 3600;

const STATUSES = new Set<AiringStatus>(['running', 'ended', 'tbd', 'development', 'unknown']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;

function parseEpisode(value: unknown): AiringEpisode | undefined {
  if (!record(value) || !count(value.season) || !count(value.episode)) return;
  if (typeof value.date !== 'string' || !calendarDate(value.date)) return;
  return {
    season: value.season,
    episode: value.episode,
    ...(typeof value.name === 'string' && value.name ? { name: value.name.slice(0, 256) } : {}),
    date: value.date,
  };
}

/** One series' answer, or nothing when it is not one atlas would send. */
export function parseAiring(value: unknown): Airing | undefined {
  if (!record(value)) return;
  const status =
    typeof value.status === 'string' && STATUSES.has(value.status as AiringStatus)
      ? (value.status as AiringStatus)
      : 'unknown';
  const premiere = record(value.seasonPremiere) ? value.seasonPremiere : undefined;
  const next = parseEpisode(value.next);
  const previous = parseEpisode(value.previous);
  return {
    source: value.source === 'tvmaze' ? 'tvmaze' : 'tmdb',
    status,
    service:
      typeof value.service === 'string' && value.service.trim()
        ? value.service.trim().slice(0, 128)
        : null,
    ...(next ? { next } : {}),
    ...(previous ? { previous } : {}),
    upcoming: Array.isArray(value.upcoming)
      ? value.upcoming.flatMap((episode) => parseEpisode(episode) ?? []).slice(0, 64)
      : [],
    ...(premiere &&
    count(premiere.season) &&
    typeof premiere.date === 'string' &&
    calendarDate(premiere.date)
      ? { seasonPremiere: { season: premiere.season, date: premiere.date } }
      : {}),
  };
}

/** Atlas's address for one series' answer: the TMDB id, with the IMDb id as a hint for the TVmaze lookup. */
export function airingPath(series: AiringSeries): string {
  return `/airing/tv/${series.tmdb}${series.imdb ? `?imdb=${encodeURIComponent(series.imdb)}` : ''}`;
}

/**
 * Seconds an answer may be kept, from its `Cache-Control`; atlas's own hour when it names none. `no-store` keeps it not
 * at all: atlas says that of a 404 whose first TVmaze lookup is still running, which is asked again on the next pass.
 */
export function airingMaxAge(cacheControl: string | null): number {
  if (/(?:^|,)\s*no-store/i.test(cacheControl ?? '')) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match ? Number(match[1]) : AIRING_MAX_AGE_SECONDS;
  return Math.min(Math.max(seconds, 60), 86_400);
}

interface Kept {
  value: Airing | null;
  expires: number;
}

/**
 * Atlas's answers, each kept for as long as its answer said. A series atlas does not know is kept as `null` for the
 * same time (atlas answers it 404), so it is not asked again on every visit. A failed request keeps whatever was held
 * before it. This only saves the round trip: each answer is also an ordinary cacheable GET.
 */
export class AiringCache {
  readonly #kept = new Map<string, Kept>();
  readonly #asking = new Map<string, Promise<void>>();
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The answers for `series` from `atlas`, asking only for those not held fresh, `AIRING_CONCURRENCY` at a time.
   * `null` when nothing could be asked and nothing is held.
   */
  async lookup(
    atlas: string,
    series: readonly AiringSeries[],
    ask: (one: AiringSeries) => Promise<{ airing: Airing | null; maxAge: number }>,
  ): Promise<Map<number, Airing> | null> {
    const key = (id: number) => `${atlas}\0${id}`;
    const wanted = new Map<number, AiringSeries>();
    for (const one of series) if (!wanted.has(one.tmdb)) wanted.set(one.tmdb, one);
    const stale = [...wanted.values()].filter(({ tmdb }) => {
      const kept = this.#kept.get(key(tmdb));
      return (!kept || kept.expires <= this.now()) && !this.#asking.has(key(tmdb));
    });
    let failed = false;
    let next = 0;
    const settled = new Map<number, () => void>();
    for (const { tmdb } of stale)
      this.#asking.set(key(tmdb), new Promise<void>((resolve) => settled.set(tmdb, resolve)));
    const worker = async () => {
      for (let one = stale[next++]; one; one = stale[next++]) {
        try {
          const { airing, maxAge } = await ask(one);
          this.#kept.set(key(one.tmdb), { value: airing, expires: this.now() + maxAge * 1000 });
        } catch {
          failed = true;
        } finally {
          this.#asking.delete(key(one.tmdb));
          settled.get(one.tmdb)?.();
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(AIRING_CONCURRENCY, stale.length) }, worker));
    await Promise.all([...wanted.keys()].map((id) => this.#asking.get(key(id))));
    const found = new Map<number, Airing>();
    let held = false;
    for (const id of wanted.keys()) {
      const kept = this.#kept.get(key(id));
      if (!kept) continue;
      held = true;
      if (kept.value) found.set(id, kept.value);
    }
    return failed && !held ? null : found;
  }
}

/** The realm's answers: every content authority in a worker or page shares them. */
export const airingCache = new AiringCache();

/** Every atlas-dated episode of a series. */
function dated(airing: Airing): AiringEpisode[] {
  return [airing.previous, airing.next, ...airing.upcoming].filter(
    (episode): episode is AiringEpisode => !!episode,
  );
}

/** Atlas's date for one episode, when atlas dates it. */
export function airingEpisode(
  airing: Airing | undefined,
  season: number,
  episode: number,
): AiringEpisode | undefined {
  return airing
    ? dated(airing).find((one) => one.season === season && one.episode === episode)
    : undefined;
}

/** An episode with the date it is out: atlas's where atlas dates it, TMDB's otherwise. */
export interface AiredEpisode extends Episode {
  /** The service it is released on, where atlas dated it. */
  airService?: string;
}

/**
 * A season's episodes with atlas's dates laid over TMDB's: the episode list, the near-air rule (`airWindow`), episode
 * advance and season downloads all read these. The list is returned as it came when atlas dates none of it.
 */
export function withAiring(
  episodes: Episode[],
  season: number,
  airing: Airing | undefined,
): AiredEpisode[] {
  if (!airing) return episodes;
  let changed = false;
  const out = episodes.map((episode): AiredEpisode => {
    const found = airingEpisode(airing, season, episode.number);
    if (!found) return episode;
    changed = true;
    return {
      ...episode,
      airDate: found.date,
      ...(airing.service ? { airService: airing.service } : {}),
    };
  });
  return changed ? out : episodes;
}

type At = { season: number; episode: number };
const later = (a: At, b: At) =>
  a.season > b.season || (a.season === b.season && a.episode > b.episode);

/**
 * The newest episode out, from TMDB's last aired and every atlas-dated episode whose day has come. Atlas only moves it
 * forward: an episode TMDB already counts as aired stays aired.
 */
export function airedThrough(
  lastAired: At | undefined,
  airing: Airing | undefined,
  now = new Date(),
): At | undefined {
  let newest = lastAired;
  for (const episode of airing ? dated(airing) : []) {
    if (episode.season <= 0 || futureDate(episode.date, now)) continue;
    if (!newest || later(episode, newest))
      newest = { season: episode.season, episode: episode.episode };
  }
  return newest;
}

/** The series status badge: "Ended" or "Returning", from TVmaze's status; none when atlas does not know it. */
export function seriesStatusBadge(airing: Airing | undefined): 'Ended' | 'Returning' | undefined {
  if (airing?.source !== 'tvmaze') return;
  return airing.status === 'ended'
    ? 'Ended'
    : airing.status === 'running'
      ? 'Returning'
      : undefined;
}

/** "Fri 6 Nov": an episode's day, weekday first, in `locale`. */
export function outDay(date: string, locale?: string): string {
  return (
    calendarDate(date)?.toLocaleDateString(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }) ?? ''
  );
}

const DAY = 86_400_000;
const dayIndex = (date: Date) =>
  Math.round(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime() / DAY);

/** Whole calendar days from `now` to `date` (negative once past). */
export function daysUntil(date: string, now = new Date()): number | undefined {
  const day = calendarDate(date);
  return day ? dayIndex(day) - dayIndex(now) : undefined;
}

/** How long an episode counts as new once it is out. */
export const NEW_EPISODE_DAYS = 14;

/**
 * The episode a followed series has just released, if any: atlas's newest dated episode whose day has come within
 * `NEW_EPISODE_DAYS`. Whether it is shown as new also needs sources found for it and the viewer not to have
 * started it (`NewEpisodes`).
 */
export function releasedEpisode(
  airing: Airing | undefined,
  now = new Date(),
): AiringEpisode | undefined {
  if (!airing) return;
  let newest: AiringEpisode | undefined;
  for (const episode of dated(airing)) {
    const days = daysUntil(episode.date, now);
    if (episode.season <= 0 || days === undefined || days > 0 || days < -NEW_EPISODE_DAYS) continue;
    if (!newest || later(episode, newest)) newest = episode;
  }
  return newest;
}

/** How often one released episode's sources may be searched for again while nothing has been found. */
export const RECHECK_MS = 30 * 60_000;

/** A released episode of a followed series, once its sources were found. */
export interface NewEpisode {
  series: number;
  season: number;
  episode: number;
}

/**
 * Which released episodes have sources: each searched for at most once per `RECHECK_MS` until something is found, then
 * kept. The viewer starting the episode clears it (`clear`), as does the episode no longer being the newest released.
 */
export class NewEpisodes {
  readonly #checked = new Map<string, number>();
  readonly #found = new Set<string>();
  constructor(private readonly now: () => number = Date.now) {}

  static key(episode: NewEpisode): string {
    return `${episode.series}:${episode.season}:${episode.episode}`;
  }

  /** Whether this episode's sources should be searched for now. */
  due(episode: NewEpisode): boolean {
    const key = NewEpisodes.key(episode);
    if (this.#found.has(key)) return false;
    const last = this.#checked.get(key);
    return last === undefined || this.now() - last >= RECHECK_MS;
  }

  /** A search is starting: until it is answered, it is not due again. */
  started(episode: NewEpisode): void {
    this.#checked.set(NewEpisodes.key(episode), this.now());
  }

  /** A search was made: `sources` were found (0 when none, null when the search itself failed). */
  checked(episode: NewEpisode, sources: number | null): void {
    const key = NewEpisodes.key(episode);
    this.#checked.set(key, this.now());
    if (sources && sources > 0) this.#found.add(key);
  }

  has(episode: NewEpisode): boolean {
    return this.#found.has(NewEpisodes.key(episode));
  }

  clear(episode: NewEpisode): void {
    this.#found.delete(NewEpisodes.key(episode));
  }
}

/**
 * Continue Watching with each new episode's series first, marked new. A series already there keeps its entry and
 * moves up — to the new episode unless it is part way into another; one that is not there (TMDB had not dated the
 * episode out yet, so the library saw nothing to continue) is added by `make`.
 */
export function withNewEpisodes<
  E extends {
    title: { type: string; id: number };
    fraction: number;
    episode?: { season: number; episode: number };
    isNew?: true;
  },
>(
  entries: readonly E[],
  news: readonly NewEpisode[],
  make: (news: NewEpisode) => E | undefined,
): E[] {
  if (!news.length) return entries as E[];
  const lead: E[] = [];
  const taken = new Set<number>();
  for (const one of news) {
    if (taken.has(one.series)) continue;
    const held = entries.find(
      (entry) => entry.title.type === 'tv' && entry.title.id === one.series,
    );
    const entry = held
      ? held.fraction > 0
        ? held
        : { ...held, episode: { season: one.season, episode: one.episode }, fraction: 0 }
      : make(one);
    if (!entry) continue;
    taken.add(one.series);
    lead.push({ ...entry, isNew: true });
  }
  return [
    ...lead,
    ...entries.filter((entry) => !(entry.title.type === 'tv' && taken.has(entry.title.id))),
  ];
}

/** Followed series whose next season starts within this many days ("Coming back soon"). */
export const COMING_BACK_DAYS = 30;
/** Upcoming episodes within this many days ("This week"). */
export const THIS_WEEK_DAYS = 7;

/** Followed series whose next season premieres within `COMING_BACK_DAYS`, soonest first. */
export function comingBackSoon(
  airings: ReadonlyMap<number, Airing>,
  now = new Date(),
): Array<{ series: number; season: number; date: string }> {
  return [...airings]
    .flatMap(([series, airing]) => {
      const premiere = airing.seasonPremiere;
      const days = premiere && daysUntil(premiere.date, now);
      return premiere && days !== undefined && days > 0 && days <= COMING_BACK_DAYS
        ? [{ series, season: premiere.season, date: premiere.date }]
        : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.series - b.series);
}

/**
 * Each followed series' next episode due within `THIS_WEEK_DAYS`, soonest first. Today's is already out, so it is
 * not upcoming: it is a new episode instead.
 */
export function thisWeek(
  airings: ReadonlyMap<number, Airing>,
  now = new Date(),
): Array<{ series: number } & AiringEpisode> {
  return [...airings]
    .flatMap(([series, airing]) => {
      const soonest = [airing.next, ...airing.upcoming]
        .filter((episode): episode is AiringEpisode => {
          const days = episode && daysUntil(episode.date, now);
          return days !== undefined && days > 0 && days <= THIS_WEEK_DAYS;
        })
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      return soonest ? [{ series, ...soonest }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.series - b.series);
}
