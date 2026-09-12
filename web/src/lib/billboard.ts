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
export const WEIGHTS = { fresh: 0.22, attention: 0.4, quality: 0.15 };
/**
 * What a title keeps when it matches nothing this library watches. Taste multiplies the rest rather than adding
 * to it: as a fourth addend it could always be outvoted by the other three, so a film at the top of both the
 * trending and the arrivals lists won whatever the household's taste, which is how the billboard came to lead
 * with an action comedy for people who watch Nordic crime. As a multiplier it decides between contenders
 * instead of shouting alongside them: a title that matches nothing this library watches keeps roughly a third
 * of what it was otherwise worth, without any term having to drop it.
 */
const TASTE_FLOOR = 0.35;
/** How much a second kind of attention adds once the first is counted. See `attention`. */
const CORROBORATION = 0.3;

/**
 * How the facets of a taste trade off. The genre decides; the rest separate titles the genre can't tell apart.
 * Language is deliberately the smallest: in a library three-quarters in English it would otherwise hand a third
 * of the decision to every Hollywood release for the least interesting fact about it. Only the facets a title
 * can actually be judged on are counted (see `affinity`), which is why language is smaller still than it looks —
 * on a title that arrived with no credits and no countries it would otherwise inflate to a sixth of the answer.
 */
const FACETS = { genres: 0.56, people: 0.22, countries: 0.1, languages: 0.06, decades: 0.06 };
/** Weight of matching people at which the household counts as following them: one lead is a coincidence. */
const PEOPLE_ENOUGH = 2;
/** How far towards a full match a title carries for being the next of something already followed. */
const FRANCHISE_LIFT = 0.5;
/** Weight of dislike that halves a title's affinity. Below it a single bad film marks a title down, not out. */
const DISLIKE_PATIENCE = 2;

/**
 * What a library says its viewer likes, facet by facet.
 *
 * Weights are signed: watching something adds, disliking it subtracts, so a genre the household otherwise
 * watches survives one bad film in it while a genre only ever turned down goes negative.
 */
export interface Taste {
  genres: Map<number, number>;
  languages: Map<string, number>;
  /** Where what they watch was made. It reads "Nordic" better than the language does: the region co-produces
      constantly, in two or three languages and often in English. */
  countries: Map<string, number>;
  /** By TMDB person id — the director and the head of the billing. The one taste that crosses genres. */
  people: Map<number, number>;
  /** By decade. Whether this is a household that watches what just came out, or one that watches the eighties. */
  decades: Map<number, number>;
  /** By TMDB collection id: the franchises already being followed. */
  franchises: Map<number, number>;
  /**
   * What a title from this library scores on each facet, averaged over the library itself.
   *
   * Facets are read as a share of the whole profile, and a share alone says nothing: in a library half of whose
   * titles are tagged Drama, "Drama" is a third of the genre weight and "Drama, Mystery, Crime" barely more, so
   * every drama on earth looked like a perfect match and taste stopped deciding anything at all. Measured
   * against what this household's own titles score, the same numbers separate properly — and they calibrate
   * themselves to a library of any size or spread.
   */
  typical: { genres: number; languages: number; countries: number; decades: number };
}

const genresOf = (title: Title) => title.genreIds ?? [];
const languagesOf = (title: Title) => (title.originalLanguage ? [title.originalLanguage] : []);
const countriesOf = (title: Title) => title.countries ?? [];
const peopleOf = (title: Title) => title.people ?? [];
const franchisesOf = (title: Title) =>
  title.collectionId === undefined ? [] : [title.collectionId];

/** The decade it belongs to, from the fullest date it has. */
function decadesOf(title: Title): number[] {
  const year = title.releaseDate ? Number.parseInt(title.releaseDate.slice(0, 4), 10) : title.year;
  return year === undefined || !Number.isFinite(year) ? [] : [Math.floor(year / 10) * 10];
}

/**
 * How much of a facet's liked weight these keys account for. Only the liked part: a key in the red counts as
 * nothing here, and is answered for by `distaste`.
 */
function shareOf<K>(map: Map<K, number>, keys: K[]): number {
  let liked = 0;
  for (const weight of map.values()) if (weight > 0) liked += weight;
  if (liked <= 0) return 0;
  let mine = 0;
  for (const key of new Set(keys)) mine += Math.max(0, map.get(key) ?? 0);
  return Math.min(1, mine / liked);
}

/**
 * The shape of a library. Weights let a watched title count for more than a watchlisted one — the first is a
 * verdict, the second only an intention — and a negative weight is a title turned down.
 */
export function tasteOf(entries: { title: Title; weight?: number }[]): Taste {
  const taste: Taste = {
    genres: new Map(),
    languages: new Map(),
    countries: new Map(),
    people: new Map(),
    decades: new Map(),
    franchises: new Map(),
    typical: { genres: 0, languages: 0, countries: 0, decades: 0 },
  };
  const add = <K>(map: Map<K, number>, keys: K[], weight: number) => {
    for (const key of new Set(keys)) map.set(key, (map.get(key) ?? 0) + weight);
  };
  for (const { title, weight = 1 } of entries) {
    if (weight === 0) continue;
    add(taste.genres, genresOf(title), weight);
    add(taste.languages, languagesOf(title), weight);
    add(taste.countries, countriesOf(title), weight);
    add(taste.people, peopleOf(title), weight);
    add(taste.decades, decadesOf(title), weight);
    add(taste.franchises, franchisesOf(title), weight);
  }
  // What the library scores against itself, now that there is a profile to score against.
  const liked = entries.filter((entry) => (entry.weight ?? 1) > 0);
  const mean = <K>(map: Map<K, number>, keysOf: (title: Title) => K[]) => {
    let sum = 0;
    let total = 0;
    for (const { title, weight = 1 } of liked) {
      sum += weight * shareOf(map, keysOf(title));
      total += weight;
    }
    return total > 0 ? sum / total : 0;
  };
  taste.typical = {
    genres: mean(taste.genres, genresOf),
    languages: mean(taste.languages, languagesOf),
    countries: mean(taste.countries, countriesOf),
    decades: mean(taste.decades, decadesOf),
  };
  return taste;
}

/** Whether the household follows the people behind this title, saturating: one shared lead is a coincidence. */
function following(map: Map<number, number>, people: number[]): number | undefined {
  if (people.length === 0 || map.size === 0) return undefined;
  let met = 0;
  for (const id of new Set(people)) met += Math.max(0, map.get(id) ?? 0);
  return 1 - Math.exp(-met / PEOPLE_ENOUGH);
}

/**
 * How much this library has turned down what the title is made of. A dislike is the one thing a viewer says
 * outright, so it is answered outright rather than left to cancel out inside a share: a genre, a person or a
 * franchise carrying negative weight marks the title down in proportion to how firmly it was rejected.
 */
function distaste(title: Title, taste: Taste): number {
  const owed = <K>(map: Map<K, number>, keys: K[]) => {
    let against = 0;
    for (const key of new Set(keys)) against -= Math.min(0, map.get(key) ?? 0);
    return against;
  };
  const against =
    owed(taste.genres, genresOf(title)) +
    owed(taste.people, peopleOf(title)) +
    owed(taste.franchises, franchisesOf(title));
  return against <= 0 ? 0 : against / (against + DISLIKE_PATIENCE);
}

/**
 * How much a title looks like the library, across every facet either of them knows about.
 *
 * Facets a title can't be judged on are left out rather than scored zero, and the rest are re-weighted between
 * them: an atlas catalog names a title by id, so most candidates arrive with no credits and no countries, and
 * counting those as "no match" would mark down every title for what TMDB simply wasn't asked.
 */
export function affinity(title: Title, taste?: Taste): number {
  if (!taste) return 0;
  const facet = <K>(map: Map<K, number>, keys: K[], typical: number) =>
    keys.length === 0 || typical <= 0 ? undefined : Math.min(1, shareOf(map, keys) / typical);
  const parts: [number, number | undefined][] = [
    [FACETS.genres, facet(taste.genres, genresOf(title), taste.typical.genres)],
    [FACETS.languages, facet(taste.languages, languagesOf(title), taste.typical.languages)],
    [FACETS.countries, facet(taste.countries, countriesOf(title), taste.typical.countries)],
    [FACETS.decades, facet(taste.decades, decadesOf(title), taste.typical.decades)],
    [FACETS.people, following(taste.people, peopleOf(title))],
  ];
  const known = parts.filter((part): part is [number, number] => part[1] !== undefined);
  const total = known.reduce((sum, [weight]) => sum + weight, 0);
  if (total <= 0) return 0;
  const match = known.reduce((sum, [weight, value]) => sum + weight * value, 0) / total;
  // The next of something already followed is wanted whatever else it is: a sequel shares a franchise, rarely a
  // genre profile, and nobody who watched the first three needs to be sold the fourth.
  const followed =
    title.collectionId !== undefined && (taste.franchises.get(title.collectionId) ?? 0) > 0;
  return (followed ? match + (1 - match) * FRANCHISE_LIFT : match) * (1 - distaste(title, taste));
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
  const [strong, weak] = [buzz(candidate, busiest), arrival(candidate)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return strong + CORROBORATION * weak;
}

export function quality(title: Title): number {
  if (title.rating === undefined || (title.votes ?? 0) < ENOUGH_VOTES) return 0;
  return Math.min(1, Math.max(0, (title.rating - 6) / 2));
}

/**
 * What a title is worth before taste is consulted — new, watched, well liked. Exported because it says which
 * candidates are worth asking TMDB about: taste can only judge a title whose genres are known, and there are
 * far more candidates than are worth a request.
 */
export function worth(candidate: Candidate, now: Date, busiest = 0): number {
  return (
    WEIGHTS.fresh * freshness(candidate.title, now) +
    WEIGHTS.attention * attention(candidate, busiest) +
    WEIGHTS.quality * quality(candidate.title)
  );
}

export function score(candidate: Candidate, now: Date, busiest = 0, taste?: Taste): number {
  return (
    worth(candidate, now, busiest) *
    (TASTE_FLOOR + (1 - TASTE_FLOOR) * affinity(candidate.title, taste))
  );
}

/**
 * How much of a match is too little to belong on a personal billboard. Not zero: a title sharing one genre this
 * library has watched once scores a sliver, which is not a reason to feature it — an action comedy is not
 * "for you" because you once watched an action film. Above this, the multiplier decides; below it, the title
 * doesn't take a slide from something the household would actually pick.
 */
const STRANGER = 0.15;

/**
 * Whether a title resembles too little of what this library holds. Only asked when there is an answer: a title
 * whose genres were never fetched scores zero for want of an answer rather than for want of a match — dropping
 * those would quietly delete every arrival past the handful that get named — and a library with no profile yet
 * would otherwise reject everything it was offered.
 */
function strangerHere(title: Title, taste?: Taste): boolean {
  if (!taste || taste.genres.size === 0) return false;
  if (!title.genreIds || title.genreIds.length === 0) return false;
  return affinity(title, taste) < STRANGER;
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
function best<T extends { rank?: number; of?: number }>(
  a: T | undefined,
  b: T | undefined,
): T | undefined {
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
