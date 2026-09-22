// How many of atlas's titles each option would leave, beside a selection (`GET <atlas>/index/facets/<type>.json`), so
// Explore stops offering what would show nothing. Counts are over atlas's corpus, not TMDB's whole catalogue: an
// option with none there is one Den would show nothing for.
//
// A kind the answer names is complete, and a value missing from it is 0. A kind it doesn't name is unknown, and
// nothing of it is judged. Where atlas has no such route, or doesn't answer, there are no counts at all and
// `emptyOptions` keeps to what it can tell from the feed alone.

import { atlasWhere } from './atlasRows';
import { RECIPES, retargeted } from './catalog';
import type { MediaType } from './library';
import { relayFetch } from './relayFetch';

/** Kind → value → titles. */
export type FacetCounts = Record<string, Record<string, number>>;

/** A selection's worth of `sel`: more than this and atlas refuses it, so none is asked. */
const MAX_VALUES = 16;

/**
 * What a facet id is in atlas's terms: `[kind, value]` pairs, several for a plot row that pairs two axes or a recipe
 * made of parts. A recipe gives only what atlas knows — AND-joined genres, one language, one country; its keywords
 * and OR-joined genres have no kind there, so it asks for less, which can only hide less.
 */
export function facetParts(id: string, type: MediaType): [kind: string, value: string][] {
  const genre = /^genre-(\d+)$/.exec(id)?.[1];
  if (genre) return [['genre', genre]];
  const language = /^lang-([a-z]{2})$/.exec(id)?.[1];
  if (language) return [['language', language]];
  const country = /^country-([A-Z]{2})$/.exec(id)?.[1];
  if (country) return [['country', country]];
  const decade = /^decade-(\d{4})$/.exec(id)?.[1];
  if (decade) return [['decade', String(Math.floor(Number(decade) / 10) * 10)]];
  if (id.startsWith('recipe-')) {
    const recipe = RECIPES.find((r) => r.id === id.slice('recipe-'.length));
    const query = recipe && retargeted(recipe.query, type);
    if (!query) return [];
    const parts: [string, string][] = [];
    if (query.genreJoin !== 'or')
      for (const g of query.genres ?? []) parts.push(['genre', String(g)]);
    if (query.originalLanguage && !query.originalLanguage.includes('|'))
      parts.push(['language', query.originalLanguage]);
    if (query.originCountry?.length === 1) parts.push(['country', query.originCountry[0]!]);
    return parts;
  }
  const where = atlasWhere(type, id);
  if (!where) return [];
  // A mood and a subgenre are atlas's own labels, case and all; a plot facet's value is lowercase.
  return Object.entries(where).map(([kind, value]) =>
    kind === 'mood' || kind === 'subgenre' ? [kind, value] : [kind, value.toLowerCase()],
  );
}

/**
 * The one address atlas answers a selection at without redirecting: `sel` alone, its values sorted by kind and then
 * value as strings (so `genre:10759` comes before `genre:18`), once each; none for an empty selection. Undefined
 * where the selection is more than atlas takes.
 */
export function facetCountsUrl(
  base: string,
  type: MediaType,
  selection: readonly string[],
): string | undefined {
  const path = `${base}/index/facets/${type === 'tv' ? 'series' : 'movie'}.json`;
  const byOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const parts = selection
    .flatMap((id) => facetParts(id, type))
    .sort(([ka, va], [kb, vb]) => byOrder(ka, kb) || byOrder(va, vb))
    .map(([kind, value]) => `${kind}:${encodeURIComponent(value)}`)
    .filter((part, at, all) => all.indexOf(part) === at);
  if (parts.length > MAX_VALUES) return undefined;
  return parts.length ? `${path}?sel=${parts.join(',')}` : path;
}

/** atlas's counts for a selection, or null where it has none to give (no route, an error, too many values). */
export async function fetchFacetCounts(
  base: string,
  type: MediaType,
  selection: readonly string[],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FacetCounts | null> {
  const url = facetCountsUrl(base, type, selection);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as FacetCounts) : null;
  } catch {
    return null;
  }
}

/**
 * Whether an option leaves nothing beside the selection, by the counts: one of its parts is 0 in a kind the answer
 * names. An option with no part atlas knows, or none in a named kind, is never judged.
 */
export function countedEmpty(id: string, type: MediaType, counts: FacetCounts): boolean {
  return facetParts(id, type).some(([kind, value]) => {
    const values = counts[kind];
    return values !== undefined && !(values[value] ?? 0);
  });
}
