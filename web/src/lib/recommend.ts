// Home's billboard as atlas ranks it (`POST /recommend`, den-atlas). This page sends what its library holds and says
// about taste, the household's hide rules, and the TMDB lists it already fetched for its rows; atlas answers with the
// titles to show, best first, and this page only draws them. An atlas without the route — or out of reach — answers
// nothing, and the caller ranks here instead.

import type { MediaType, Title } from './library';
import type { Prefs } from './prefs';
import { relayFetch } from './relayFetch';
import { ATLAS } from './scout';
import { GUEST_PICKS } from './services';

/** A library title and how much it says about taste, as `Library.svelte` weighs it. */
export interface Weighted {
  ref: { type: MediaType; id: number };
  weight: number;
  at: number;
}

/** One of the lists this page fetched, in the order it offers them. */
export interface OfferedList {
  titles: Title[];
  /** Whether the list is itself a ranking (trending), so a place in it says something. */
  ranked: boolean;
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
  arrived: 'New on your services',
  recent: 'Recently released',
  upcoming: 'Coming soon',
  timely: 'New or coming soon',
  quality: 'Highly rated',
  buzz: 'Popular now',
};

/** Short billboard copy for Atlas's choice. Missing and newer unknown codes stay silent. */
export const recommendationReason = (why: RecommendationWhy | undefined): string | undefined =>
  why?.reason ? REASONS[why.reason] : undefined;

/** What atlas calls a series. */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

/** What TMDB said about a title. atlas reads it only where it knows nothing itself. */
function hintOf(title: Title) {
  const tmdbRating =
    title.ratingSource === 'tmdb' &&
    typeof title.rating === 'number' &&
    Number.isFinite(title.rating) &&
    title.rating > 0 &&
    title.rating <= 10
      ? title.rating
      : undefined;
  return {
    // For a library title outside Atlas's corpus, these let /recommend build a transient semantic vector instead
    // of losing all plot-taste evidence. They are public TMDB identity, never persisted by Atlas.
    title: title.title,
    year: title.year,
    releaseDate: title.releaseDate,
    genreIds: title.genreIds,
    originalLanguage: title.originalLanguage,
    countries: title.countries,
    popularity: title.popularity,
    ...(tmdbRating !== undefined
      ? {
          rating: tmdbRating,
          ...(typeof title.votes === 'number' && Number.isInteger(title.votes) && title.votes >= 0
            ? { votes: title.votes }
            : {}),
        }
      : {}),
    adult: title.adult,
    imdbId: title.imdbId,
  };
}

/**
 * The request for a billboard on the page showing `facet` (Home: null). A library title TMDB has named goes with what
 * TMDB said about it: atlas holds a subset of titles, and until its facts cover what a household watches, a library
 * title it has never seen says nothing about taste without one.
 */
export function recommendBody({
  facet,
  prefs,
  library,
  named = new Map(),
  owned,
  lists,
  now = new Date(),
}: {
  facet: MediaType | null;
  prefs: Prefs;
  library: Weighted[];
  /** The library's titles TMDB has named, by `type:id`. */
  named?: Map<string, Title>;
  /** Every title the library holds, by `type:id`. */
  owned: Set<string>;
  lists: OfferedList[];
  now?: Date;
}) {
  return {
    version: 1,
    surface: facet === 'movie' ? 'movies' : facet === 'tv' ? 'series' : 'home',
    now: now.toISOString(),
    // Home uses these same six picks until the household saves a selection. Keep atlas's ranking input in
    // step with the shelves on screen; an explicitly saved empty array remains empty.
    services: prefs.servicesConfigured ? prefs.services : GUEST_PICKS,
    library: library.map(({ ref, weight, at }) => {
      const title = named.get(`${ref.type}:${ref.id}`);
      return {
        type: atlasType(ref.type),
        id: ref.id,
        weight,
        at,
        ...(title ? { hint: hintOf(title) } : {}),
      };
    }),
    owned: [...owned].flatMap((key) => {
      const [type, id] = key.split(':');
      const numeric = Number(id);
      return (type === 'movie' || type === 'tv') && Number.isInteger(numeric)
        ? [{ type: atlasType(type), id: numeric }]
        : [];
    }),
    hide: {
      minYear: prefs.minReleaseYear,
      genres: [...prefs.excludedGenres],
      languages: [...prefs.excludedLanguages],
      anime: prefs.hideAnime,
    },
    candidates: lists.flatMap(({ titles, ranked }) =>
      titles.map((title, rank) => ({
        type: atlasType(title.type),
        id: title.id,
        ...(ranked ? { rank, of: titles.length } : {}),
        hint: hintOf(title),
      })),
    ),
  };
}

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

export interface Recommended {
  /** The slides, best first. */
  slides: Slide[];
  /** Titles atlas knew nothing about, most worth describing first: described, they can be ranked. */
  unjudged: Slide[];
}

/** atlas's answer for `body`; null where atlas can't rank (no route, out of reach, a malformed answer). */
export async function recommend(
  base: string,
  body: ReturnType<typeof recommendBody>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Recommended | null> {
  try {
    const res = await fetchImpl(`${base}/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const answer = (await res.json()) as { slides?: unknown; unjudged?: unknown };
    if (!Array.isArray(answer.slides)) return null;
    return { slides: slidesOf(answer.slides), unjudged: slidesOf(answer.unjudged) };
  } catch {
    return null;
  }
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
 */
export function startBillboard(
  path: string,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): void {
  const scope =
    path === '/' ? 'home' : path === '/movies' ? 'movies' : path === '/series' ? 'series' : null;
  if (!scope) return;
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
