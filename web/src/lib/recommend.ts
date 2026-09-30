// Home's billboard as atlas ranks it once per UTC day. Everyone reads the same cacheable pool; a browser with a
// library moves titles found in the public "fans of" rows for its strongest titles upward, without disclosing the
// library in a recommendation request.

import type { MediaType, Title } from './library';
import { relayFetch } from './relayFetch';
import { ATLAS } from './scout';

/** A library title and how much it says about taste, as `Library.svelte` weighs it. */
export interface Weighted {
  ref: { type: MediaType; id: number };
  weight: number;
  at: number;
}

export interface Slide {
  type: MediaType;
  id: number;
  imdbId?: string;
  why?: RecommendationWhy;
}

/** Atlas's scoring diagnostics. The terms are carried intact for inspection; only `reason` is presentation. */
export interface RecommendationWhy {
  score?: number;
  fit?: number;
  similar?: number | null;
  profile?: number;
  people?: number;
  confidence?: number;
  fresh?: number;
  arrived?: number;
  quality?: number;
  buzz?: number;
  /** A stable scorer-selected code. Unknown codes are retained but deliberately have no browser copy. */
  reason?: string;
}

/** A named recommendation, including the explanation Atlas attached to this particular ranking. */
export interface RecommendedTitle extends Title {
  why?: RecommendationWhy;
}

const REASONS: Readonly<Record<string, string>> = {
  similar: 'Similar to what you watch',
  profile: 'Fits your viewing taste',
  people: 'Cast and creators you like',
  franchise: 'From a franchise you like',
  arrived: 'New on streaming',
  recent: 'Recently released',
  upcoming: 'Coming soon',
  timely: 'New or coming soon',
  quality: 'Highly rated',
  buzz: 'Popular now',
};

/** Short billboard copy for Atlas's choice. Missing and newer unknown codes stay silent. */
export const recommendationReason = (why: RecommendationWhy | undefined): string | undefined =>
  why?.reason ? REASONS[why.reason] : undefined;

const WHY_NUMBERS = [
  'score',
  'fit',
  'similar',
  'profile',
  'people',
  'confidence',
  'fresh',
  'arrived',
  'quality',
  'buzz',
] as const;

/** Read every usable diagnostic independently, so one malformed term cannot discard its slide. */
function whyOf(value: unknown): RecommendationWhy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const why: RecommendationWhy = {};
  for (const field of WHY_NUMBERS) {
    const number = input[field];
    if (typeof number === 'number' && Number.isFinite(number)) why[field] = number;
    else if (field === 'similar' && number === null) why.similar = null;
  }
  if (typeof input.reason === 'string' && input.reason) why.reason = input.reason;
  return Object.keys(why).length ? why : undefined;
}

/** Titles as atlas names them, in Den's names; anything else dropped. */
function slidesOf(value: unknown): Slide[] {
  return (Array.isArray(value) ? (value as Record<string, unknown>[]) : []).flatMap(
    (slide): Slide[] => {
      const type = slide?.type === 'series' ? 'tv' : slide?.type === 'movie' ? 'movie' : null;
      if (!type || typeof slide.id !== 'number') return [];
      const imdbId =
        typeof slide.imdbId === 'string' && /^tt\d+$/.test(slide.imdbId) ? slide.imdbId : undefined;
      return [{ type, id: slide.id, imdbId, why: whyOf(slide.why) }];
    },
  );
}

/** The billboard's scope for the page showing `facet` (Home: null), as `GET /recommend/<scope>.json` names it. */
export const billboardScope = (facet: MediaType | null) =>
  facet === 'movie' ? 'movies' : facet === 'tv' ? 'series' : 'home';

/** Where everyone's billboard for `scope` is asked on `now`'s UTC day, from atlas at `base`. */
const everyoneUrl = (base: string, scope: string, now: Date) =>
  `${base}/recommend/${scope}.json?day=${now.toISOString().slice(0, 10)}`;

async function askEveryone(url: string, fetchImpl: typeof fetch): Promise<Slide[] | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const answer = (await res.json()) as { slides?: unknown };
    return Array.isArray(answer.slides) ? slidesOf(answer.slides) : null;
  } catch {
    return null;
  }
}

/** Billboards asked before the app knew it would want them (`startBillboard`), by address, until taken. */
const started = new Map<string, Promise<Slide[] | null>>();

/**
 * Ask for this page's billboard for everyone as the app starts (`main.ts`), before it has found atlas or opened the
 * library: at the address a browser with no library of its own finds atlas at (`findAtlas`'s same-origin `/atlas`).
 * `recommendForEveryone` takes this answer when it asks the same address; if nothing asks, it was one kept GET.
 *
 * Not for a `paired` browser: its library's own atlas install answers at `/atlas/<config>`, which atlas ranks for that
 * install's region and services, so its Home asks that address and this one would be a second billboard nobody reads.
 */
export function startBillboard(
  path: string,
  paired: boolean,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): void {
  const scope =
    path === '/' ? 'home' : path === '/movies' ? 'movies' : path === '/series' ? 'series' : null;
  if (!scope || paired) return;
  const url = everyoneUrl(ATLAS.path, scope, now);
  started.set(url, askEveryone(url, fetchImpl));
}

/**
 * atlas's billboard for everyone (`GET /recommend/<scope>.json`): no library, so one answer per scope and day, which
 * Cloudflare and the browser keep. The UTC day is in the address so each day is its own answer. Null where atlas can't
 * rank (no route, out of reach, a malformed answer).
 */
export function recommendForEveryone(
  base: string,
  scope: string,
  now = new Date(),
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[] | null> {
  const url = everyoneUrl(base, scope, now);
  const early = started.get(url);
  started.delete(url);
  return early ?? askEveryone(url, fetchImpl);
}

const PERSONAL_SEEDS = 10;
const PERSONAL_REQUESTS = 4;
const FAN_LIMIT = 100;
// A perfect fan match may move a nearby shared pick to the lead, but cannot let a ubiquitous deep-pool title
// overwhelm the quality/freshness prior merely because it appeared in every seed row.
const PERSONAL_LIFT = 2;
// One top-five hit among ten full-weight seeds, or several weaker agreements, is enough to make a title personal.
// Anything below this remains evidence for ordering, but not enough to displace the shared lead on its own.
const PERSONAL_MATCH = 0.01;
const slideKey = (slide: Pick<Slide, 'type' | 'id'>) => `${slide.type}:${slide.id}`;

/** Read one public, long-lived "fans of this title" row. Older atlases may answer same-type `ids` only. */
async function fansOf(base: string, seed: Weighted, fetchImpl: typeof fetch): Promise<Slide[]> {
  const kind = seed.ref.type === 'tv' ? 'series' : 'movie';
  try {
    const res = await fetchImpl(
      `${base}/index/suggest/${kind}/${seed.ref.id}.json?skip=0&limit=${FAN_LIMIT}`,
    );
    if (!res.ok) return [];
    const answer = (await res.json()) as { mixed?: unknown; ids?: unknown };
    if (Array.isArray(answer.mixed)) return slidesOf(answer.mixed);
    return (Array.isArray(answer.ids) ? answer.ids : []).flatMap((id): Slide[] =>
      typeof id === 'number' && Number.isInteger(id) ? [{ type: seed.ref.type, id }] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Re-rank the shared pool locally from public per-title affinity rows. The shared order remains the quality,
 * freshness and buzz prior; fan matches add a bounded reciprocal-rank lift. At most four requests run at once so
 * opening Home cannot occupy the relay's whole request budget. A missing/older atlas simply leaves the shared order.
 */
export async function personalizeEveryone(
  base: string,
  slides: Slide[],
  library: Weighted[],
  owned: ReadonlySet<string>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[]> {
  const candidates = slides.filter((slide) => !owned.has(slideKey(slide)));
  const seeds = library
    .filter(({ weight }) => weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.at - a.at)
    .slice(0, PERSONAL_SEEDS);
  if (!seeds.length || !candidates.length) return candidates;
  const seedWeight = seeds.reduce((sum, seed) => sum + Math.abs(seed.weight), 0);

  const affinity = new Map<string, number>();
  const queue = seeds.slice();
  const work = async () => {
    for (let seed = queue.shift(); seed; seed = queue.shift()) {
      const fans = await fansOf(base, seed, fetchImpl);
      const seen = new Set<string>();
      fans.forEach((slide, rank) => {
        const key = slideKey(slide);
        if (seen.has(key)) return;
        seen.add(key);
        affinity.set(key, (affinity.get(key) ?? 0) + seed.weight / (rank + 5));
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PERSONAL_REQUESTS, seeds.length) }, work));

  return candidates
    .map((slide, rank) => {
      const lift = ((affinity.get(slideKey(slide)) ?? 0) / seedWeight) * PERSONAL_LIFT;
      return {
        slide,
        rank,
        lift,
        matched: lift / PERSONAL_LIFT >= PERSONAL_MATCH,
        // A slowly declining prior keeps a weak affinity hit from discarding atlas's quality/freshness ranking.
        score: 1 / (1 + rank * 0.05) + lift,
      };
    })
    .sort((a, b) =>
      a.matched !== b.matched ? (a.matched ? -1 : 1) : b.score - a.score || a.rank - b.rank,
    )
    .map(({ slide, matched }) =>
      matched ? { ...slide, why: { ...slide.why, reason: 'profile' } } : slide,
    );
}

/**
 * The slides as titles to draw, in atlas's order. A title one of the offered lists already named is taken from there;
 * the rest — atlas's own lists name titles by id — are looked up, `lookups` at a time. One TMDB can't name is left
 * out rather than drawn blank.
 */
export async function nameSlides(
  slides: Slide[],
  known: Map<string, Title>,
  lookup: (ref: { type: MediaType; id: number }) => Promise<Title | null>,
  lookups: number,
): Promise<RecommendedTitle[]> {
  const named = new Map<string, Title>();
  const queue = slides.filter((slide) => !known.has(`${slide.type}:${slide.id}`));
  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const title = await lookup({ type: next.type, id: next.id }).catch(() => null);
      if (title) named.set(`${next.type}:${next.id}`, title);
    }
  };
  await Promise.all(Array.from({ length: lookups }, work));
  return slides.flatMap((slide) => {
    const key = `${slide.type}:${slide.id}`;
    const title = known.get(key) ?? named.get(key);
    return title ? [{ ...title, imdbId: title.imdbId ?? slide.imdbId, why: slide.why }] : [];
  });
}
