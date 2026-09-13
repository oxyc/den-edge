// Home's billboard as atlas ranks it (`POST /recommend`, den-atlas). This page sends what its library holds and says
// about taste, the household's hide rules, and the TMDB lists it already fetched for its rows; atlas answers with the
// titles to show, best first, and this page only draws them. An atlas without the route — or out of reach — answers
// nothing, and the caller ranks here instead.

import type { MediaType, Title } from './library';
import type { Prefs } from './prefs';

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
}

/** What atlas calls a series. */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

/** What TMDB said about a title. atlas reads it only where it knows nothing itself. */
function hintOf(title: Title) {
  return {
    releaseDate: title.releaseDate,
    genreIds: title.genreIds,
    originalLanguage: title.originalLanguage,
    countries: title.countries,
    popularity: title.popularity,
    rating: title.rating,
    votes: title.votes,
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
    services: prefs.services,
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

/** Titles as atlas names them, in Den's names; anything else dropped. */
function slidesOf(value: unknown): Slide[] {
  return (Array.isArray(value) ? (value as Record<string, unknown>[]) : []).flatMap(
    (slide): Slide[] => {
      const type = slide?.type === 'series' ? 'tv' : slide?.type === 'movie' ? 'movie' : null;
      if (!type || typeof slide.id !== 'number') return [];
      const imdbId =
        typeof slide.imdbId === 'string' && /^tt\d+$/.test(slide.imdbId) ? slide.imdbId : undefined;
      return [{ type, id: slide.id, imdbId }];
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
  fetchImpl: typeof fetch = fetch,
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
): Promise<Title[]> {
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
    return title ? [{ ...title, imdbId: title.imdbId ?? slide.imdbId }] : [];
  });
}
