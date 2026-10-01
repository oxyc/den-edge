// Home's billboard, as atlas ranks it: atlas is the only ranker, and this page only draws what it answers. Everyone
// first reads the same cacheable pool for the UTC day (`GET /recommend/<scope>.json`). Behind a switch
// (`memberPostOn`), a browser with a library then asks atlas to rank against the whole of it (`POST /recommend`),
// and that answer takes every slide after the one on screen and is kept for the next visit's first paint.

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

/**
 * Where everyone's billboard for `scope` is asked on `now`'s UTC day, from atlas at `base`; with `fresh`, the one of
 * only new titles (`freshOn`), which atlas ranks and keeps apart.
 */
const everyoneUrl = (base: string, scope: string, fresh: boolean, now: Date) =>
  `${base}/recommend/${scope}.json?day=${now.toISOString().slice(0, 10)}${fresh ? '&fresh=1' : ''}`;

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
  fresh: boolean,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): void {
  const scope =
    path === '/' ? 'home' : path === '/movies' ? 'movies' : path === '/series' ? 'series' : null;
  if (!scope || paired) return;
  const url = everyoneUrl(ATLAS.path, scope, fresh, now);
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
  fresh: boolean,
  now = new Date(),
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[] | null> {
  const url = everyoneUrl(base, scope, fresh, now);
  const early = started.get(url);
  started.delete(url);
  return early ?? askEveryone(url, fetchImpl);
}

type SwitchStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined;

/**
 * A billboard switch this browser keeps under `name`, on unless turned off: `?<param>=0` turns it off and
 * `?<param>=1` on again; either is remembered, so the parameter is needed once.
 */
function switchOn(name: string, param: string, search: string, storage: SwitchStorage): boolean {
  const asked = new URLSearchParams(search).get(param);
  try {
    if (asked === '1' || asked === '0') storage?.setItem(name, asked);
    return storage?.getItem(name) !== '0';
  } catch {
    // Storage refused (a private window): the parameter still counts for this page.
    return asked !== '0';
  }
}

/**
 * Whether a browser with a library asks atlas to rank its billboard against its recent library (`POST /recommend`):
 * on by default, `?billboard-post=0` turns it off (kept as `den.billboard.member-post`). Judged on den#161: it put
 * more of what the household went on to add in its top 10 than the shared order, and none of its dislikes near the top.
 */
export const memberPostOn = (
  search = globalThis.location?.search ?? '',
  storage: SwitchStorage = globalThis.localStorage,
) => switchOn('den.billboard.member-post', 'billboard-post', search, storage);

/**
 * Whether the billboard is atlas's pool of only new titles (`fresh`), for the shared GET and the member POST alike:
 * on by default, `?billboard-fresh=0` turns it off (kept as `den.billboard.fresh`).
 */
export const freshOn = (
  search = globalThis.location?.search ?? '',
  storage: SwitchStorage = globalThis.localStorage,
) => switchOn('den.billboard.fresh', 'billboard-fresh', search, storage);

/** What atlas calls a series. */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

/**
 * What TMDB said about a library title. atlas reads it only for a title it knows nothing about itself, and keeps
 * none of it: without it, a watched title outside atlas's corpus says nothing about taste.
 */
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

/** The most library and owned titles one request may name (den-atlas `recommend.rs` `MAX_LIBRARY`, `MAX_OWNED`). */
const MAX_LIBRARY = 5000;
const MAX_OWNED = 10_000;

/**
 * How far back the library speaks for taste: the last 180 days. Ranked against the whole history, a household's
 * years-old titles (and a second viewer's) outweighed what it watches now, and the billboard did no better than the
 * shared order (den#161). A library with nothing that recent is sent whole.
 */
const TASTE_WINDOW_MS = 180 * 86_400_000;

/**
 * The request for a billboard ranked against this library, on the page showing `facet` (Home: null). No candidate
 * lists: den-edge adds TMDB's trending and current releases to it (`billboard.rs`), and atlas has its own.
 */
export function recommendBody({
  facet,
  prefs,
  library,
  named = new Map(),
  owned,
  fresh = false,
  now = new Date(),
}: {
  facet: MediaType | null;
  prefs: Prefs;
  library: Weighted[];
  /** The library's titles TMDB has named, by `type:id`. */
  named?: Map<string, Title>;
  /** Every title the library holds, by `type:id`. */
  owned: Set<string>;
  /** Only new titles (`freshOn`). */
  fresh?: boolean;
  now?: Date;
}) {
  const recent = library.filter((title) => title.at >= now.getTime() - TASTE_WINDOW_MS);
  return {
    version: 1,
    surface: billboardScope(facet),
    now: now.toISOString(),
    ...(fresh ? { fresh: true } : {}),
    // Home uses these same six picks until the household saves a selection; a saved empty selection stays empty.
    services: prefs.servicesConfigured ? prefs.services : GUEST_PICKS,
    // Past atlas's limit it would refuse the whole request, so the most recent titles go.
    library: [...(recent.length ? recent : library)]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_LIBRARY)
      .map(({ ref, weight, at }) => {
        const title = named.get(`${ref.type}:${ref.id}`);
        return {
          type: atlasType(ref.type),
          id: ref.id,
          weight,
          at,
          ...(title ? { hint: hintOf(title) } : {}),
        };
      }),
    owned: [...owned].slice(0, MAX_OWNED).flatMap((key) => {
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
  };
}

/** atlas's billboard for `body`, best first; null where atlas can't rank (no route, out of reach, a malformed answer). */
export async function recommend(
  base: string,
  body: ReturnType<typeof recommendBody>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[] | null> {
  try {
    const res = await fetchImpl(`${base}/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const answer = (await res.json()) as { slides?: unknown };
    return Array.isArray(answer.slides) ? slidesOf(answer.slides) : null;
  } catch {
    return null;
  }
}

/** A billboard atlas ranked for this library, kept for the next visit (`LibraryLog.keep`), with when it was ranked. */
export interface KeptBillboard {
  at: number;
  titles: RecommendedTitle[];
}

/** How long a kept personal billboard may open the next visit before the shared one does instead. */
const KEPT_FOR_MS = 86_400_000;

/** The kept billboard's titles while it is under a day old; null when there is none, or it is older. */
export function freshKept(
  kept: KeptBillboard | null | undefined,
  now = Date.now(),
): RecommendedTitle[] | null {
  if (!kept || typeof kept.at !== 'number' || !Array.isArray(kept.titles)) return null;
  const age = now - kept.at;
  return kept.titles.length && age >= 0 && age < KEPT_FOR_MS ? kept.titles : null;
}

const slideKey = (slide: Pick<Slide, 'type' | 'id'>) => `${slide.type}:${slide.id}`;

/**
 * `next` in place of every slide after `visible`, the one on screen. It and the slides before it stay where they
 * are, so nothing moves under the viewer and the rail keeps its place; `next` follows, less what they already show.
 * With nothing on screen, `next` is the whole billboard.
 */
export function swapAfter<T extends Pick<Slide, 'type' | 'id'>>(
  shown: T[],
  visible: Pick<Slide, 'type' | 'id'> | undefined,
  next: T[],
): T[] {
  const at = visible ? shown.findIndex((slide) => slideKey(slide) === slideKey(visible)) : -1;
  const kept = shown.slice(0, at + 1);
  const keys = new Set(kept.map(slideKey));
  return [...kept, ...next.filter((slide) => !keys.has(slideKey(slide)))];
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
