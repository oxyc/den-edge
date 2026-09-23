// Explore's picks in atlas's terms (`filterRoutes.ts`): the `[kind, value]` pairs each chip is, the selection as one
// atlas filter where every pick has an atlas form, and whether atlas's counts say an option would leave nothing.
// Counts are over atlas's corpus, not TMDB's whole catalogue: an option with none there is one Den would show
// nothing for.
//
// A value missing from a kind the counts list completely is 0; any other kind is unknown, and nothing of it is
// judged. Where atlas has no filter routes, there are no counts at all and `emptyOptions` keeps to what it can tell
// from the feed alone.

import { atlasWhere } from './atlasRows';
import { RECIPES, recipeParts, retargeted } from './catalog';
import type { FilterItem } from './filterRoutes';
import type { MediaType } from './library';
import { likeOf } from './route';

/** A kind's counts: value → titles, and whether a value missing from them has none (`complete`). */
export interface KindCounts {
  mode?: string;
  complete?: boolean;
  values?: Record<string, number>;
}
/** Kind → its counts, as atlas's `counts.json` gives them under `kinds`. */
export type FacetCounts = Record<string, Record<string, number> | KindCounts>;

/**
 * A kind's values, and whether a value missing from them means none: only when `complete` for the per-kind shape; a
 * plain value → titles map is complete. Undefined where the answer says nothing usable about the kind.
 */
function countsOf(kind: FacetCounts[string] | undefined) {
  if (!kind || typeof kind !== 'object') return undefined;
  if ('values' in kind || 'complete' in kind || 'mode' in kind) {
    const { values, complete } = kind as KindCounts;
    return values && typeof values === 'object'
      ? { values, complete: complete === true }
      : undefined;
  }
  return { values: kind as Record<string, number>, complete: true };
}

/**
 * The kinds only atlas's filter answers, each picked as `<kind>-<atlas's id>` (`person-Q25191`, `runtime-under-90`,
 * `technique-live_action`): people, studios, subjects and the rest. TMDB discover and atlas's rows know none of them.
 */
export const FILTER_ONLY = [
  'person',
  'made',
  'cast',
  'company',
  'network',
  'subject',
  'place',
  'format',
  'source',
  'technique',
  'audience',
  'critique',
  'runtime',
  'animated',
  'character',
] as const;
export type FilterOnlyKind = (typeof FILTER_ONLY)[number];

/** The filter-only kind a facet id picks, if any. */
export function filterOnlyKind(id: string): FilterOnlyKind | undefined {
  const kind = id.slice(0, id.indexOf('-'));
  return (FILTER_ONLY as readonly string[]).includes(kind) ? (kind as FilterOnlyKind) : undefined;
}

/**
 * What a facet id is in atlas's terms: `[kind, value]` pairs, several for a plot row that pairs two axes or a recipe
 * made of parts. A recipe atlas has no form of gives what it can — AND-joined genres, one language, one country —
 * which, counted, can only hide less. A "Like" for a title of the other type is nothing of this type's.
 */
export function facetParts(id: string, type: MediaType): [kind: string, value: string][] {
  const genre = /^genre-(\d+)$/.exec(id)?.[1];
  if (genre) return [['genre', genre]];
  const language = /^lang-([a-z]{2})$/.exec(id)?.[1];
  if (language) return [['language', language]];
  const country = /^country-([A-Z]{2})$/.exec(id)?.[1];
  if (country) return [['country', country]];
  const region = /^region-([a-z]+(?:-[a-z]+)*)$/.exec(id)?.[1];
  if (region) return [['region', region]];
  const decade = /^decade-(\d{4})$/.exec(id)?.[1];
  if (decade) return [['decade', String(Math.floor(Number(decade) / 10) * 10)]];
  const rating = /^rating-(\d+)$/.exec(id)?.[1];
  if (rating) return [['rating', rating]];
  const like = likeOf(id);
  if (like) return like.type === type ? [['like', String(like.id)]] : [];
  const only = filterOnlyKind(id);
  if (only) return [[only, id.slice(only.length + 1)]];
  if (id.startsWith('recipe-')) {
    const recipeId = id.slice('recipe-'.length);
    const whole = recipeParts(recipeId, type);
    if (whole) return whole;
    const recipe = RECIPES.find((r) => r.id === recipeId);
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

/** A selection's parts as atlas's filter items: what its counts are asked beside (`facetParts`). */
export const countItems = (selection: readonly string[], type: MediaType): FilterItem[] =>
  selection.flatMap((id) => facetParts(id, type).map(([kind, id]) => ({ kind, id })));

/**
 * The selection as one atlas filter, or undefined where a pick has no form there: a recipe atlas doesn't know, a
 * "Like" for the other type, an id nothing reads.
 */
export function filterItems(
  selection: readonly string[],
  type: MediaType,
): FilterItem[] | undefined {
  const items: FilterItem[] = [];
  for (const id of selection) {
    const parts = id.startsWith('recipe-')
      ? recipeParts(id.slice('recipe-'.length), type)
      : facetParts(id, type);
    if (!parts?.length) return undefined;
    items.push(...parts.map(([kind, value]) => ({ kind, id: value })));
  }
  return items;
}

/**
 * Whether an option leaves nothing beside the selection, by the counts: one of its parts is 0 in a kind the answer
 * lists completely. An option with no part atlas knows, or none in such a kind, is never judged. (A one-pick kind
 * that already has its pick is never asked about here: `emptyOptions` leaves it out first.)
 */
export function countedEmpty(id: string, type: MediaType, counts: FacetCounts): boolean {
  return facetParts(id, type).some(([kind, value]) => {
    const known = countsOf(counts[kind]);
    return !!known?.complete && !(known.values[value] ?? 0);
  });
}
