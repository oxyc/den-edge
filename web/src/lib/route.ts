// Den Web's pages are real paths — `/movie/550-fight-club`, `/search?q=blade+runner` — not fragments. A path
// is what a share preview can be built for, what a search result can be linked to, and what reads as a place
// rather than an anchor. The fragment is left to the TV's pairing QR (`#pair=…`), which must never reach a
// server, so nothing here ever looks at it.
//
// den-edge serves `index.html` for any path with no file behind it (`web.rs`), so these are the app's to read.
// They must not collide with an API path — `/lib`, `/link`, `/pair`, `/inbox`, `/scout`, `/atlas`, `/reel`,
// `/remux`, `/routes`, `/config`, `/health`, `/metrics`, `/p` — because the API answers first.

import type { MediaType } from './library';

export type Route =
  | { page: 'library' }
  | { page: 'movies' }
  | { page: 'series' }
  | { page: 'watchlist' }
  | { page: 'settings' }
  | ({ page: 'search'; query: string } & Explore)
  | { page: 'title'; type: MediaType; id: number }
  | { page: 'person'; id: number }
  /** One streaming service in one country: the same service in two countries carries two catalogues. */
  | { page: 'service'; id: number; country: string };

/**
 * What Search is browsing, beside the query: the type it is showing and the facets picked, in the order they were
 * picked (`explore.ts`). In the address with the query — `c=country-SE,genre-28` — so an Explore view can be linked
 * and Back takes back the last pick. Both are absent for the defaults: Movies, and For You (no facets).
 */
export interface Explore {
  type?: MediaType;
  chips?: string[];
}

/** A facet id is lowercase words, digits, a country code and dashes: nothing that needs escaping in `c=`. */
const FACET = /^[a-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** The top-level tabs, by the path they live at. `/` is Home, so the library is not in here. */
const TABS = ['movies', 'series', 'watchlist', 'settings'] as const;

/** Any origin will do: only the path and the query are ever read, and a relative input needs some base. */
const BASE = 'https://den.invalid';

/**
 * A title's name as it appears in a link: lowercase words, hyphens between. Decoration only — the id ahead
 * of it is what identifies the title — so anything unusual is simply dropped rather than escaped.
 */
export function slug(name: string | undefined): string {
  if (!name) return '';
  const words = name
    .normalize('NFKD')
    // Drop the combining marks NFKD just split off, so "Amélie" becomes "amelie" and not "am-lie".
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Long enough for any real title, short enough that the id stays visible in a chat's link preview.
  return words.length > 60 ? words.slice(0, 60).replace(/-+[^-]*$/, '') : words;
}

/** `550` from `550-fight-club`; nothing for anything that is not a positive integer with an optional name. */
function identifier(segment: string | undefined): number | undefined {
  const digits = /^(\d+)(?:-[^/]*)?$/.exec(segment ?? '')?.[1];
  const id = Number(digits);
  return digits !== undefined && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** The route at `url` — a path with an optional query, or a whole href. Anything unrecognised is Home. */
export function parseRoute(url: string): Route {
  let path: string;
  let params: URLSearchParams;
  try {
    const parsed = new URL(url, BASE);
    path = parsed.pathname;
    params = parsed.searchParams;
  } catch {
    return { page: 'library' };
  }
  const [, first, second] = path.split('/');
  if (first === 'search') {
    const type = params.get('type');
    const chips = [...new Set((params.get('c') ?? '').split(',').filter((id) => FACET.test(id)))];
    return {
      page: 'search',
      query: params.get('q') ?? '',
      ...(type === 'movie' || type === 'tv' ? { type } : {}),
      ...(chips.length ? { chips } : {}),
    };
  }
  for (const tab of TABS) if (first === tab && !second) return { page: tab };
  const id = identifier(second);
  if ((first === 'movie' || first === 'tv') && id)
    return { page: 'title', type: first === 'tv' ? 'tv' : 'movie', id };
  if (first === 'person' && id) return { page: 'person', id };
  if (first === 'service') {
    const [, provider, country] = /^(\d+)-([A-Za-z]{2})(?:-[^/]*)?$/.exec(second ?? '') ?? [];
    const numeric = Number(provider);
    if (provider && country && Number.isInteger(numeric) && numeric > 0)
      return { page: 'service', id: numeric, country: country.toUpperCase() };
  }
  return { page: 'library' };
}

/** Where a route lives. The one place a path is built, so `parseRoute` is the only place one is read. */
export function routePath(route: Route): string {
  switch (route.page) {
    case 'library':
      return '/';
    case 'search':
      return searchHref(route.query, route);
    case 'title':
      return `/${route.type === 'tv' ? 'tv' : 'movie'}/${route.id}`;
    case 'person':
      return `/person/${route.id}`;
    case 'service':
      return serviceHref(route.id, route.country);
    default:
      return `/${route.page}`;
  }
}

/**
 * A service's link, named where the name is known: `/service/8-us-netflix`.
 *
 * The country is part of the address, not a preference read at the other end: a catalogue is licensed per country, so
 * `/service/8-us` and `/service/8-fi` are different places and have to be linkable as such.
 */
export const serviceHref = (id: number, country: string, name?: string) => {
  const named = slug(name);
  return `/service/${id}-${country.toLowerCase()}${named ? `-${named}` : ''}`;
};

/** A title's link, named where the name is known: `/movie/550-fight-club`. */
export const titleHref = (title: { type: MediaType; id: number; title?: string }) => {
  const name = slug(title.title);
  return `/${title.type === 'tv' ? 'tv' : 'movie'}/${title.id}${name ? `-${name}` : ''}`;
};

export const personHref = (id: number, name?: string) => {
  const slugged = slug(name);
  return `/person/${id}${slugged ? `-${slugged}` : ''}`;
};

/**
 * Search carries its query and what it is browsing, so a result page or an Explore view can be linked, kept, or
 * reloaded and still be the same.
 */
export function searchHref(query: string, { type, chips = [] }: Explore = {}): string {
  const facets = chips.filter((id) => FACET.test(id));
  const params = [
    query.trim() ? `q=${encodeURIComponent(query)}` : '',
    type ? `type=${type}` : '',
    facets.length ? `c=${facets.join(',')}` : '',
  ].filter(Boolean);
  return params.length ? `/search?${params.join('&')}` : '/search';
}

/**
 * The path an old `#…` link means, or null if it isn't one.
 *
 * Den Web addressed its pages by fragment until 0.67.0, so links shared before then — and any bookmark — still
 * arrive that way. They are answered once, at startup, by rewriting the address; `#pair=…` is deliberately not
 * a route and falls through to the pairing screen that reads it.
 */
export function legacyPath(hash: string): string | null {
  const fragment = hash.replace(/^#/, '');
  if (!fragment || fragment.includes('=')) return null;
  const [page, ...rest] = fragment.split('/');
  if (page === 'library') return '/';
  if (page === 'search') return '/search';
  for (const tab of TABS) if (page === tab && rest.length === 0) return `/${tab}`;
  const id = identifier(rest[1]);
  if (page === 'title' && (rest[0] === 'movie' || rest[0] === 'tv') && id)
    return `/${rest[0]}/${id}`;
  const person = identifier(rest[0]);
  if (page === 'person' && person) return `/person/${person}`;
  return null;
}
