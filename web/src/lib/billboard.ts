// What Home's billboard shows.
//
// Not the leading row. A "Because you watched X" row is the nearest neighbours of a title already watched, and
// after enough history that neighbourhood IS the history: the billboard filled up with old, half-familiar things
// its owner had often already seen. A billboard is the top of a page opened to find something to watch, so this
// ranks what is new — new in the world (just released) and new to this library (never seen) — with what is being
// watched now as a tie-breaker, and leaves "more like that" to the rows below.
//
// Pure and deterministic given `now`, so both clients can be held to the same answer.

import type { Title } from './library';

/** A title in the running, with where it came from. */
export interface Candidate {
  title: Title;
  /** Its place in the list it arrived in, when that list is itself a ranking (trending). */
  rank?: number;
  /** How long that list was, without which a rank says nothing. */
  of?: number;
  /** Its place in a "new on <service>" list: newly watchable here, whatever year it came out. */
  arrival?: { rank: number; of: number };
}

const DAY = 86_400_000;
/** The same 120 days that New Releases calls new, so the billboard and that row can't disagree. */
const FRESH_DAYS = 120;
/** Below this a rating is one of a handful of opinions, not a verdict. */
const ENOUGH_VOTES = 50;
/**
 * What a title still to come is worth. High, because "out next month" is the most interesting thing a billboard
 * can say — but short of full marks, since an unreleased film nobody has seen yet shouldn't outrank the series
 * half the world is watching this week.
 */
const UNRELEASED = 0.8;

/**
 * How the terms trade off. Freshness leads, but not alone: ranking on recency by itself fills a billboard with
 * whatever came out last, and most of what comes out in any given week is an untracked micro-release nobody is
 * looking for. Attention is weighted to match it, so among new things the ones people are actually watching win.
 */
export const WEIGHTS = { fresh: 0.22, attention: 0.4, quality: 0.15, taste: 0.35 };
/** How much a second kind of attention adds once the first is counted. See `attention`. */
const CORROBORATION = 0.3;

/** What a library says its viewer likes: how much of it sits in each genre, and in each original language. */
export interface Taste {
  genres: Map<number, number>;
  languages: Map<string, number>;
}

/**
 * The shape of a library. Weights let a watched title count for more than a watchlisted one — the first is a
 * verdict, the second only an intention.
 */
export function tasteOf(entries: { title: Title; weight?: number }[]): Taste {
  const genres = new Map<number, number>();
  const languages = new Map<string, number>();
  for (const { title, weight = 1 } of entries) {
    for (const id of title.genreIds ?? []) genres.set(id, (genres.get(id) ?? 0) + weight);
    const language = title.originalLanguage;
    if (language) languages.set(language, (languages.get(language) ?? 0) + weight);
  }
  return { genres, languages };
}

/**
 * How much a title looks like the library. Its best-matching genre rather than its average one — a Nordic crime
 * drama shouldn't be marked down for also being tagged Mystery — read against the strongest genre in the
 * profile, since a large library spreads its shares thin. Language carries the rest: "Nordic" is a language
 * before it is a genre.
 */
export function affinity(title: Title, taste?: Taste): number {
  if (!taste) return 0;
  const topGenre = Math.max(0, ...taste.genres.values());
  const topLanguage = Math.max(0, ...taste.languages.values());
  const genre = topGenre > 0 ? Math.max(0, ...(title.genreIds ?? []).map((id) => taste.genres.get(id) ?? 0)) / topGenre : 0;
  const language = topLanguage > 0 ? (taste.languages.get(title.originalLanguage ?? '') ?? 0) / topLanguage : 0;
  return 0.7 * genre + 0.3 * language;
}

/** When it came out, as a date. A title known only by its year is placed mid-year — coarse, but honest. */
function released(title: Title): Date | undefined {
  if (title.releaseDate) {
    const parsed = new Date(`${title.releaseDate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return title.year === undefined ? undefined : new Date(Date.UTC(title.year, 6, 1));
}

/** High for anything not yet out, decaying over four months once it is. Unknown dates score as old. */
export function freshness(title: Title, now: Date): number {
  const date = released(title);
  if (!date) return 0;
  const days = (now.getTime() - date.getTime()) / DAY;
  return days <= 0 ? UNRELEASED : Math.exp(-days / FRESH_DAYS);
}

/**
 * How much attention it has. A place in a ranked list says it outright; otherwise TMDB's popularity does, read
 * against the busiest title in the same pool so the number is a standing rather than an absolute. A title that
 * is both ranked and popular takes the better of the two.
 */
export function buzz({ rank, of, title }: Candidate, busiest = 0): number {
  const ranked = rank === undefined || of === undefined || of <= 0 ? 0 : Math.max(0, 1 - rank / of);
  // Logarithmic: TMDB's popularity is long-tailed, and one runaway title would otherwise flatten the rest to 0.
  const popular = busiest > 0 ? Math.log1p(title.popularity ?? 0) / Math.log1p(busiest) : 0;
  return Math.max(ranked, Math.min(1, popular));
}

/** Well-liked, on enough votes to mean it: 6.0 scores nothing, 8.0 and up scores 1. */
/**
 * Newly watchable on a service this household has. "New to you" rather than "new in the world": a 1997 film that
 * landed on Netflix yesterday is worth a slide, and it is the only term that knows the title can be pressed play
 * on at all.
 */
export function arrival({ arrival: at }: Candidate): number {
  return !at || at.of <= 0 ? 0 : Math.max(0, 1 - at.rank / at.of);
}

/**
 * The two kinds of attention, counted once rather than twice.
 *
 * They are not independent: a service pushing its own new release puts it at the top of that service's arrivals
 * AND at the top of what is trending, so adding the two together let anything being marketed collect nearly
 * every point going and finish above titles the library actually likes. The stronger signal counts in full and
 * the second only corroborates it.
 */
export function attention(candidate: Candidate, busiest = 0): number {
  const [strong, weak] = [buzz(candidate, busiest), arrival(candidate)].sort((a, b) => b - a) as [number, number];
  return strong + CORROBORATION * weak;
}

export function quality(title: Title): number {
  if (title.rating === undefined || (title.votes ?? 0) < ENOUGH_VOTES) return 0;
  return Math.min(1, Math.max(0, (title.rating - 6) / 2));
}

export function score(candidate: Candidate, now: Date, busiest = 0, taste?: Taste): number {
  return (
    WEIGHTS.fresh * freshness(candidate.title, now) +
    WEIGHTS.attention * attention(candidate, busiest) +
    WEIGHTS.quality * quality(candidate.title) +
    WEIGHTS.taste * affinity(candidate.title, taste)
  );
}

/**
 * Whether a title resembles nothing this library holds — not one of its genres, not its language. Worth
 * dropping from a billboard that is meant to be personal, but only when the question was actually asked: a
 * title whose genres were never fetched scores zero for want of an answer, not for want of a match, and a
 * library with no profile yet would otherwise reject everything.
 */
function strangerHere(title: Title, taste?: Taste): boolean {
  if (!taste || taste.genres.size === 0) return false;
  if (!title.genreIds || title.genreIds.length === 0) return false;
  return affinity(title, taste) === 0;
}

const keyOf = (title: Title) => `${title.type}:${title.id}`;

/**
 * The same title from two sources is one candidate holding everything both knew about it. This matters more
 * than it sounds: atlas's catalogs name a title by id, year and nothing else, so a trending title arrived with
 * no genres to match a taste against and no rating to be judged on — it could only ever score on its ranking,
 * and lost to a new release that came from TMDB with every field filled in. Merged, it keeps its ranking AND
 * gets scored on the rest.
 */
function merge(a: Candidate, b: Candidate): Candidate {
  return {
    title: {
      ...b.title,
      ...a.title,
      posterPath: a.title.posterPath ?? b.title.posterPath,
      year: a.title.year ?? b.title.year,
      releaseDate: a.title.releaseDate ?? b.title.releaseDate,
      rating: a.title.rating ?? b.title.rating,
      votes: a.title.votes ?? b.title.votes,
      popularity: a.title.popularity ?? b.title.popularity,
      genreIds: a.title.genreIds ?? b.title.genreIds,
      originalLanguage: a.title.originalLanguage ?? b.title.originalLanguage,
    },
    ...best({ rank: a.rank, of: a.of }, { rank: b.rank, of: b.of }),
    arrival: best(a.arrival, b.arrival),
  };
}

/**
 * The better of two placings. The same service in two countries is two lists, and a title can sit first in one
 * and fortieth in the other; which of those the merge happened to see first is no basis for judging it.
 */
function best<T extends { rank?: number; of?: number }>(a: T | undefined, b: T | undefined): T | undefined {
  const standing = (p?: { rank?: number; of?: number }) =>
    p?.rank === undefined || !p.of ? -1 : 1 - p.rank / p.of;
  if (standing(a) < 0) return b;
  if (standing(b) < 0) return a;
  return standing(a) >= standing(b) ? a : b;
}

/**
 * The slides, best first. Deduped, filtered and only then cut to `slides` — cutting first would let the filter
 * empty a list that had plenty of candidates behind the cut, which is how the old billboard ended up with two
 * slides on a strict library.
 */
export function pickBillboard(
  candidates: Candidate[],
  {
    now = new Date(),
    slides = 40,
    keep = () => true,
    taste,
  }: { now?: Date; slides?: number; keep?: (title: Title) => boolean; taste?: Taste } = {},
): Title[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!keep(candidate.title) || strangerHere(candidate.title, taste)) continue;
    const key = keyOf(candidate.title);
    const already = byKey.get(key);
    byKey.set(key, already ? merge(already, candidate) : candidate);
  }
  const running = [...byKey.values()];
  const busiest = running.reduce((most, { title }) => Math.max(most, title.popularity ?? 0), 0);
  // A stable sort, so candidates that score the same keep the order their source put them in.
  return running
    .map((candidate) => ({ candidate, score: score(candidate, now, busiest, taste) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, slides)
    .map(({ candidate }) => candidate.title);
}
