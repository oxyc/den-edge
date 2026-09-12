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
}

const DAY = 86_400_000;
/** The same 120 days that New Releases calls new, so the billboard and that row can't disagree. */
const FRESH_DAYS = 120;
/** Below this a rating is one of a handful of opinions, not a verdict. */
const ENOUGH_VOTES = 50;

/**
 * How the terms trade off. Freshness leads, but not alone: ranking on recency by itself fills a billboard with
 * whatever came out last, and most of what comes out in any given week is an untracked micro-release nobody is
 * looking for. Attention is weighted to match it, so among new things the ones people are actually watching win.
 */
export const WEIGHTS = { fresh: 0.3, buzz: 0.3, quality: 0.15 };

/** When it came out, as a date. A title known only by its year is placed mid-year — coarse, but honest. */
function released(title: Title): Date | undefined {
  if (title.releaseDate) {
    const parsed = new Date(`${title.releaseDate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return title.year === undefined ? undefined : new Date(Date.UTC(title.year, 6, 1));
}

/** 1 for anything not yet out, decaying over four months to nothing. Unknown dates score as old. */
export function freshness(title: Title, now: Date): number {
  const date = released(title);
  if (!date) return 0;
  const days = (now.getTime() - date.getTime()) / DAY;
  return days <= 0 ? 1 : Math.exp(-days / FRESH_DAYS);
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
export function quality(title: Title): number {
  if (title.rating === undefined || (title.votes ?? 0) < ENOUGH_VOTES) return 0;
  return Math.min(1, Math.max(0, (title.rating - 6) / 2));
}

export function score(candidate: Candidate, now: Date, busiest = 0): number {
  return (
    WEIGHTS.fresh * freshness(candidate.title, now) +
    WEIGHTS.buzz * buzz(candidate, busiest) +
    WEIGHTS.quality * quality(candidate.title)
  );
}

const keyOf = (title: Title) => `${title.type}:${title.id}`;

/**
 * The slides, best first. Deduped, filtered and only then cut to `slides` — cutting first would let the filter
 * empty a list that had plenty of candidates behind the cut, which is how the old billboard ended up with two
 * slides on a strict library.
 */
export function pickBillboard(
  candidates: Candidate[],
  { now = new Date(), slides = 40, keep = () => true }: { now?: Date; slides?: number; keep?: (title: Title) => boolean } = {},
): Title[] {
  const seen = new Set<string>();
  const running: Candidate[] = [];
  for (const candidate of candidates) {
    const key = keyOf(candidate.title);
    if (seen.has(key) || !keep(candidate.title)) continue;
    seen.add(key);
    running.push(candidate);
  }
  const busiest = running.reduce((most, { title }) => Math.max(most, title.popularity ?? 0), 0);
  // A stable sort, so candidates that score the same keep the order their source put them in.
  return running
    .map((candidate) => ({ candidate, score: score(candidate, now, busiest) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, slides)
    .map(({ candidate }) => candidate.title);
}
