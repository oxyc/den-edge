// atlas's stackable filters (`/index/filter/<movie|series|all>/…`, `all` being films and series together): for a
// selection of values from many kinds, how many titles each further value would leave (`counts.json`), the titles
// themselves (`titles.json`), and one kind's values by a typed prefix (`values/<kind>.json`, the people and
// characters typeahead). And the people credited on those titles, narrowed by what Wikidata says about them
// (`traits`): the people themselves (`people.json`), their traits' counts (`people/counts.json`), and one trait's
// values by a typed prefix (`people/values/<trait>.json`).
//
// The URL is atlas's cache key, and through den-edge's relay a redirect arrives with no Location, so every address
// here is built in atlas's one canonical spelling (`canonicalQuery`), which `filterRoutes.test.ts` holds to atlas's
// own fixture. Where the routes are not there (a 404) or leave a picked kind out, callers fall back to what Den did
// before them: TMDB discover, atlas's rows, the feed's own titles.

import { titlesOf } from './atlasRows';
import type { ExploreType, MediaType, Title } from './library';
import { relayFetch } from './relayFetch';
import { PEOPLE_ORDERS } from './route';
import { withSharedTitleMetadata } from './titleMetadata';

/** How a kind's values combine: several apply together (`and`), or a title has one and a pick takes it (`single`). */
export type FilterMode = 'and' | 'single';

/** The plot-facet axes, each a one-value kind. */
export const PLOT_AXES = [
  'archetype',
  'chronology',
  'conflict',
  'continuity',
  'ending',
  'ensemble',
  'era',
  'pacing',
  'scope',
  'setting',
  'timespan',
  'tone',
] as const;

type IdFormat =
  'integer' | 'decade' | 'born' | 'lower' | 'upper' | 'label' | 'qid' | 'character' | 'like';

/** Every kind atlas's filter reads, with how it combines and how its ids are written (its `/index/schema.json`). */
export const FILTER_KINDS: Record<string, { mode: FilterMode; id: IdFormat }> = {
  genre: { mode: 'and', id: 'integer' },
  language: { mode: 'and', id: 'lower' },
  country: { mode: 'and', id: 'upper' },
  region: { mode: 'single', id: 'lower' },
  decade: { mode: 'single', id: 'decade' },
  mood: { mode: 'and', id: 'label' },
  subgenre: { mode: 'and', id: 'label' },
  primary: { mode: 'single', id: 'label' },
  animated: { mode: 'single', id: 'lower' },
  runtime: { mode: 'single', id: 'lower' },
  source: { mode: 'and', id: 'lower' },
  rating: { mode: 'single', id: 'integer' },
  technique: { mode: 'and', id: 'lower' },
  audience: { mode: 'and', id: 'lower' },
  critique: { mode: 'and', id: 'lower' },
  warning: { mode: 'and', id: 'lower' },
  ...Object.fromEntries(PLOT_AXES.map((axis) => [axis, { mode: 'single', id: 'lower' }])),
  person: { mode: 'and', id: 'qid' },
  made: { mode: 'and', id: 'qid' },
  cast: { mode: 'and', id: 'qid' },
  company: { mode: 'and', id: 'qid' },
  network: { mode: 'and', id: 'qid' },
  subject: { mode: 'and', id: 'qid' },
  place: { mode: 'and', id: 'qid' },
  format: { mode: 'and', id: 'qid' },
  character: { mode: 'and', id: 'character' },
  like: { mode: 'single', id: 'like' },
};

/** Every person trait the people routes read in `traits` (atlas's `filter.traits` in `/index/schema.json`). */
export const TRAIT_KINDS: Record<string, { mode: FilterMode; id: IdFormat }> = {
  gender: { mode: 'single', id: 'qid' },
  born: { mode: 'single', id: 'born' },
  citizenship: { mode: 'and', id: 'qid' },
  occupation: { mode: 'and', id: 'qid' },
  role: { mode: 'and', id: 'lower' },
};

/** The traits `people/values/<trait>.json` answers: those whose values are Wikidata items. */
const TRAIT_VALUES = ['gender', 'citizenship', 'occupation'];

/**
 * A "Like"'s value in atlas's filter: the title's id under its own type's route; under `all`, which holds both types'
 * ids, the id with its type (`movie-550`, `series-1396`). The one place that form is decided.
 */
export const likeValue = (title: { type: MediaType; id: number }, route: ExploreType): string =>
  route === 'all' ? `${title.type === 'tv' ? 'series' : 'movie'}-${title.id}` : String(title.id);

/** The old `structure` axis, as the axes atlas answers it with. */
const STRUCTURE_ALIAS: Record<string, string> = {
  'single-day': 'timespan',
  anthology: 'continuity',
};

/** The earliest birth year a `born` range may name; the latest is next year. */
export const FIRST_BIRTH_YEAR = 1800;

/**
 * A `born` range of birth years as atlas spells it — `1976-1996`, `1976-`, `-1996`: both ends inclusive, either left
 * out, each a year from `FIRST_BIRTH_YEAR` to next year — or undefined for one atlas refuses.
 */
export function bornRange(id: string): string | undefined {
  const ends = id.split('-');
  if (ends.length !== 2) return undefined;
  const latest = new Date().getUTCFullYear() + 1;
  const years = ends.map((end) => end.trim());
  if (years.some((year) => year && !/^\d+$/.test(year))) return undefined;
  const [from, to] = years.map((year) => (year ? Number(year) : undefined));
  if (from === undefined && to === undefined) return undefined;
  if ([from, to].some((year) => year !== undefined && (year < FIRST_BIRTH_YEAR || year > latest)))
    return undefined;
  if (from !== undefined && to !== undefined && from > to) return undefined;
  return `${from ?? ''}-${to ?? ''}`;
}

const MAX_SELECTION = 16;
const TITLES_PAGE = 24;
const MAX_TITLES_PAGE = 100;

/** One `[-]<kind>:<id>` of a selection. */
export interface FilterItem {
  kind: string;
  id: string;
  /** The titles known NOT to carry it. */
  exclude?: boolean;
}

export type FilterRoute =
  'counts' | 'titles' | 'people' | 'peopleCounts' | { values: string } | { peopleValues: string };

/** Text folded as atlas folds names: accents off, lowercase, runs of anything but letters and digits one space. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ');
}

/**
 * A kind and an id as their canonical pair, or undefined for an id the kind can't read. An unknown kind is kept,
 * lowercased with its id as sent: atlas answers it as ignored.
 *
 * A character is folded as atlas folds one; atlas also drops honorifics and numbers ("Guard #2"), which the ids
 * this app sends — atlas's own, from its typeahead — never carry.
 */
function normalise(
  rawKind: string,
  rawId: string,
  kinds = FILTER_KINDS,
  type?: ExploreType,
): [string, string] | undefined {
  let kind = rawKind.trim().toLowerCase();
  const id = rawId.trim();
  if (!id) return undefined;
  if (kind === 'structure' && kinds === FILTER_KINDS)
    kind = STRUCTURE_ALIAS[id.toLowerCase()] ?? 'chronology';
  const spec = kinds[kind];
  if (!spec) return [kind, id];
  const number = /^\d+$/.test(id) ? Number(id) : undefined;
  switch (spec.id) {
    case 'integer':
      return number === undefined ? undefined : [kind, String(number)];
    case 'decade':
      return number === undefined ? undefined : [kind, String(Math.floor(number / 10) * 10)];
    // A birth decade, or a range of birth years.
    case 'born': {
      if (id.includes('-')) {
        const range = bornRange(id);
        return range === undefined ? undefined : [kind, range];
      }
      return number === undefined ? undefined : [kind, String(Math.floor(number / 10) * 10)];
    }
    case 'lower':
      return [kind, id.toLowerCase()];
    case 'upper':
      return [kind, id.toUpperCase()];
    case 'label':
      return [kind, id];
    case 'qid': {
      const digits = id.replace(/^[Qq]/, '');
      return /^\d+$/.test(digits) ? [kind, `Q${Number(digits)}`] : undefined;
    }
    case 'character': {
      const name = fold(id);
      return name ? [kind, name.replace(/ /g, '-')] : undefined;
    }
    // A bare id under one type's route, a typed one under `all` (`likeValue`); either where the type isn't known.
    case 'like': {
      if (number !== undefined) return type === 'all' ? undefined : [kind, String(number)];
      const typed = /^(movie|series)-(\d+)$/i.exec(id);
      return typed && (type === undefined || type === 'all')
        ? [kind, `${typed[1]!.toLowerCase()}-${Number(typed[2])}`]
        : undefined;
    }
  }
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Items in atlas's spelling — each normalised by `kinds`, sorted by kind, then positive before excluded, then id,
 * once each — or undefined where one can't be read, there are too many values, or a `born` range stands beside
 * another positive `born` pick.
 *
 * An item's id may be an OR group of its kind's values (`country:FR|IT`, any of them): each value normalised alone,
 * the group sorted as strings and each value kept once, joined with a literal `|` (a one-value group has none) and
 * sorted among the items by that joined id. Every value must read as the same kind (the old `structure` spreads over
 * two), a "Like" never groups, and each value counts toward the cap.
 */
function spelled(
  items: FilterItem[],
  kinds = FILTER_KINDS,
  type?: ExploreType,
): string[] | undefined {
  const normal: { kind: string; ids: string[]; exclude: boolean }[] = [];
  for (const item of items) {
    let kind: string | undefined;
    const ids: string[] = [];
    for (const raw of item.id.split('|')) {
      const pair = normalise(item.kind, raw, kinds, type);
      if (!pair || (kind !== undefined && pair[0] !== kind)) return undefined;
      kind = pair[0];
      ids.push(pair[1]);
    }
    const group = [...new Set(ids)].sort(byString);
    if (!kind || (group.length > 1 && kinds[kind]?.id === 'like')) return undefined;
    normal.push({ kind, ids: group, exclude: !!item.exclude });
  }
  const born = new Set(
    normal
      .filter((item) => kinds === TRAIT_KINDS && item.kind === 'born' && !item.exclude)
      .flatMap((item) => item.ids),
  );
  if (born.size > 1 && [...born].some((id) => id.includes('-'))) return undefined;
  const id = (item: (typeof normal)[number]) => item.ids.join('|');
  normal.sort(
    (a, b) =>
      byString(a.kind, b.kind) || Number(a.exclude) - Number(b.exclude) || byString(id(a), id(b)),
  );
  const spelt = normal.map((item) => ({
    text: `${item.exclude ? '-' : ''}${item.kind}:${item.ids.map(encodeURIComponent).join('|')}`,
    values: item.ids.length,
  }));
  const once = spelt.filter((item, at, all) => all.findIndex((x) => x.text === item.text) === at);
  const values = once.reduce((sum, item) => sum + item.values, 0);
  return values > MAX_SELECTION ? undefined : once.map((item) => item.text);
}

/**
 * A route's query in atlas's canonical spelling, with its `?`, or '' for none; undefined for a question atlas
 * refuses. `sel`, then (the people routes) `traits`, each `spelled`; then (people) `order`; then `skip` and `limit`
 * (titles, people) or `q` and `limit` (values, people values), each only when not its default.
 */
export function canonicalQuery(
  route: FilterRoute,
  {
    items = [],
    traits = [],
    order,
    skip = 0,
    limit,
    q,
    type,
  }: {
    items?: FilterItem[];
    traits?: FilterItem[];
    order?: string;
    skip?: number;
    limit?: number;
    q?: string;
    /** The route's type, which decides how a "Like" is written. */
    type?: ExploreType;
  } = {},
): string | undefined {
  const sel = spelled(items, FILTER_KINDS, type);
  if (!sel) return undefined;
  const people =
    route === 'people' ||
    route === 'peopleCounts' ||
    (typeof route === 'object' && 'peopleValues' in route);
  const traitList = people ? spelled(traits, TRAIT_KINDS) : [];
  if (!traitList) return undefined;
  let orderName: string | undefined;
  if (route === 'people' && order !== undefined && order.trim()) {
    orderName = order.trim().toLowerCase();
    if (!(PEOPLE_ORDERS as readonly string[]).includes(orderName)) return undefined;
    if (orderName === PEOPLE_ORDERS[0]) orderName = undefined;
  }

  const values =
    typeof route === 'object' ? ('values' in route ? route.values : route.peopleValues) : undefined;
  const character = typeof route === 'object' && 'values' in route && values === 'character';
  const paged = route === 'titles' || route === 'people';
  const [fallback, most] =
    route === 'counts' || route === 'peopleCounts'
      ? [0, 0]
      : paged
        ? [TITLES_PAGE, MAX_TITLES_PAGE]
        : character
          ? [5, 5]
          : [10, 10];
  const size = Math.min(Math.max(limit ?? fallback, Math.min(fallback, 1)), most);
  if (!Number.isInteger(skip) || skip < 0 || (size > 0 && skip % size !== 0)) return undefined;

  let prefix: string | undefined;
  if (values !== undefined) {
    const folded = q === undefined ? '' : fold(q);
    if (character && folded.length < 3) return undefined;
    if (folded) {
      if (folded.length < 2) return undefined;
      prefix = folded;
    }
  }

  const parts: string[] = [];
  if (sel.length) parts.push(`sel=${sel.join(',')}`);
  if (traitList.length) parts.push(`traits=${traitList.join(',')}`);
  if (orderName) parts.push(`order=${orderName}`);
  if (paged && skip) parts.push(`skip=${skip}`);
  if (prefix !== undefined) parts.push(`q=${encodeURIComponent(prefix)}`);
  if (fallback > 0 && size !== fallback) parts.push(`limit=${size}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const routePath = (route: FilterRoute) =>
  route === 'counts'
    ? 'counts.json'
    : route === 'titles'
      ? 'titles.json'
      : route === 'people'
        ? 'people.json'
        : route === 'peopleCounts'
          ? 'people/counts.json'
          : 'values' in route
            ? `values/${route.values}.json`
            : `people/values/${route.peopleValues}.json`;

/** A filter route's canonical address under `base`, or undefined for a question atlas refuses. */
export function filterUrl(
  base: string,
  type: ExploreType,
  route: FilterRoute,
  options: Parameters<typeof canonicalQuery>[1] = {},
): string | undefined {
  const query = canonicalQuery(route, { ...options, type });
  if (query === undefined) return undefined;
  const segment = type === 'tv' ? 'series' : type;
  return `${base}/index/filter/${segment}/${routePath(route)}${query}`;
}

/** Decoded as atlas decodes a query value: `+` a space, then percent escapes. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Any filter address, as the canonical one atlas answers it at (undefined where atlas refuses it). Reads a path and
 * its query as atlas reads them — the first of each parameter, unknown ones dropped — and spells them
 * `canonicalQuery`'s way; the same builder every request here goes through.
 */
export function canonicalFilterPath(path: string): string | undefined {
  const [pathname, query = ''] = path.split('?', 2) as [string, string?];
  const match =
    /^\/index\/filter\/(movie|series|all)\/(counts|titles|people|people\/counts|values\/([a-z]+)|people\/values\/([a-z]+))\.json$/.exec(
      pathname,
    );
  if (!match) return undefined;
  if (match[4] !== undefined && !TRAIT_VALUES.includes(match[4])) return undefined;
  const route: FilterRoute =
    match[3] !== undefined
      ? { values: match[3] }
      : match[4] !== undefined
        ? { peopleValues: match[4] }
        : match[2] === 'people/counts'
          ? 'peopleCounts'
          : (match[2] as 'counts' | 'titles' | 'people');
  const params = new Map<string, string>();
  for (const pair of query.split('&').filter(Boolean)) {
    const at = pair.indexOf('=');
    const [name, value] = at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    if (!params.has(name)) params.set(name, value);
  }
  const read = (name: string): FilterItem[] | undefined => {
    const items: FilterItem[] = [];
    for (const raw of decode(params.get(name) ?? '')
      .split(',')
      .filter(Boolean)) {
      const exclude = raw.startsWith('-');
      const body = exclude ? raw.slice(1) : raw;
      const colon = body.indexOf(':');
      if (colon < 0) return undefined;
      items.push({ kind: body.slice(0, colon), id: body.slice(colon + 1), exclude });
    }
    return items;
  };
  const people = route === 'people' || route === 'peopleCounts' || match[4] !== undefined;
  const items = read('sel');
  const traits = people ? read('traits') : [];
  if (!items || !traits) return undefined;
  const count = (name: string) => {
    const value = params.get(name);
    if (value === undefined || route === 'counts' || route === 'peopleCounts')
      return { ok: true, n: undefined };
    if (name === 'skip' && route !== 'titles' && route !== 'people')
      return { ok: true, n: undefined };
    return /^\d+$/.test(value) ? { ok: true, n: Number(value) } : { ok: false, n: undefined };
  };
  const [skip, limit] = [count('skip'), count('limit')];
  if (!skip.ok || !limit.ok) return undefined;
  const q = typeof route === 'object' && params.has('q') ? decode(params.get('q')!) : undefined;
  const order = route === 'people' ? decode(params.get('order') ?? '') : undefined;
  const canonical = canonicalQuery(route, {
    items,
    traits,
    order,
    skip: skip.n,
    limit: limit.n,
    q,
    type: match[1] === 'series' ? 'tv' : (match[1] as ExploreType),
  });
  return canonical === undefined ? undefined : `${pathname}${canonical}`;
}

/** One kind's counts beside a selection. */
export interface FilterKindCounts {
  mode: FilterMode;
  /** Whether every value the kind holds beside the selection is listed: a value missing from it has none. */
  complete: boolean;
  values: Record<string, number>;
  /** Names, for the kinds whose ids aren't (people, studios, characters…). */
  labels?: Record<string, string>;
  selected?: string[];
  excluded?: string[];
}

export interface FilterCounts {
  total: number;
  kinds: Record<string, FilterKindCounts>;
  /** Kinds in the selection atlas left out of the answer: unknown to it, or unavailable. */
  ignored: string[];
  kindsUnavailable: string[];
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Says why atlas's filter gave nothing, where that is news: a failed request, a body that isn't what atlas sends, a
 * status other than 404. A 404 is the routes not deployed, and a cancelled request is one the next question replaced:
 * both expected, and quiet.
 */
function unanswered(url: string, why: unknown) {
  if (why instanceof Response ? why.status === 404 : (why as Error)?.name === 'AbortError') return;
  console.warn('atlas filter:', why instanceof Response ? `answered ${why.status}` : why, url);
}

/** atlas's counts beside a selection; null where the route isn't there, fails, or the question is refused. */
export async function fetchFilterCounts(
  base: string,
  type: ExploreType,
  items: FilterItem[],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FilterCounts | null> {
  const url = filterUrl(base, type, 'counts', { items });
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      unanswered(url, res);
      return null;
    }
    const body = (await res.json()) as Record<string, unknown> | null;
    const kinds = body?.kinds;
    if (!body || !kinds || typeof kinds !== 'object') {
      unanswered(url, new Error('counts without kinds'));
      return null;
    }
    return {
      total: typeof body.total === 'number' ? body.total : 0,
      kinds: kinds as Record<string, FilterKindCounts>,
      ignored: strings(body.ignored),
      kindsUnavailable: strings(body.kindsUnavailable),
    };
  } catch (error) {
    unanswered(url, error);
    return null;
  }
}

/**
 * Thrown by a titles page atlas can't give: the caller goes back to what it did without atlas's filter. `deployed`
 * is false for a 404 — the routes not there, expected and quiet — and true where atlas answered but couldn't apply
 * the selection, which is worth saying.
 */
export class FilterUnavailable extends Error {
  constructor(
    message: string,
    readonly deployed = true,
  ) {
    super(message);
  }
}

/**
 * The titles carrying a selection, a page at a time, as a row's `load`. atlas pages by `skip`, so a page is a page
 * boundary; if its `order` changes between pages (a new ratings join), paging starts again from the top, and titles
 * already given aren't given twice. A page asked out of turn — a row rebuilt under a list that had already loaded
 * some — starts at that page's `skip` instead of at the top. Throws `FilterUnavailable` for a 404, and for an answer
 * that ignored a picked kind or named one of its values unknown — its titles would not be the selection's.
 */
export function filterTitles(
  base: string,
  type: ExploreType,
  items: FilterItem[],
  { fetchImpl = relayFetch }: { fetchImpl?: typeof fetch } = {},
): (page: number) => Promise<Title[]> {
  let order: string | undefined;
  let offset = 0;
  let last = 0;
  const given = new Set<string>();
  const picked = new Set(items.map((item) => item.kind.toLowerCase()));
  async function read(skip: number) {
    const url = filterUrl(base, type, 'titles', { items, skip });
    if (!url) throw new FilterUnavailable('atlas refuses this selection');
    const res = await fetchImpl(url);
    if (res.status === 404) throw new FilterUnavailable('atlas has no filter routes', false);
    if (!res.ok) throw new Error(`atlas answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const missing = [...strings(body.ignored), ...strings(body.kindsUnavailable)].filter((kind) =>
      picked.has(kind),
    );
    if (missing.length) throw new FilterUnavailable(`atlas can't apply ${missing.join(', ')}`);
    const unknown = strings(body.unknownValues);
    if (unknown.length) throw new FilterUnavailable(`atlas has no ${unknown.join(', ')}`);
    return { titles: titlesOf(body), order: typeof body.order === 'string' ? body.order : '' };
  }
  // An empty page ends a row, so a page of titles already given (after a restart) reads on instead.
  return async (page) => {
    if (page !== last + 1) offset = (page - 1) * TITLES_PAGE;
    last = page;
    for (;;) {
      let answer = await read(offset);
      if (order !== undefined && answer.order !== order) {
        offset = 0;
        answer = await read(0);
      }
      order = answer.order;
      offset += TITLES_PAGE;
      const fresh = answer.titles.filter((title) => {
        const key = `${title.type}:${title.id}`;
        if (given.has(key)) return false;
        given.add(key);
        return true;
      });
      if (fresh.length || !answer.titles.length) return withSharedTitleMetadata(fresh, fetchImpl);
    }
  };
}

/** One value a typeahead found. */
export interface FilterValue {
  id: string;
  name: string;
  count: number;
  /** A person's TMDB id, where Wikidata has it: what their page is addressed by. */
  tmdbId?: number;
}

/**
 * A kind's values starting with `q`, beside a selection: none where `q` is too short, and null where atlas didn't
 * answer (no such route, a failure), so a caller can ask elsewhere.
 */
export async function searchFilterValues(
  base: string,
  type: ExploreType,
  kind: string,
  q: string,
  items: FilterItem[] = [],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FilterValue[] | null> {
  const url = filterUrl(base, type, { values: kind }, { items, q });
  return url ? readValues(url, signal, fetchImpl) : [];
}

/** A person trait's values starting with `q` (`people/values/<trait>.json`), as `searchFilterValues` answers. */
export async function searchTraitValues(
  base: string,
  type: ExploreType,
  trait: string,
  q: string,
  items: FilterItem[] = [],
  traits: FilterItem[] = [],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FilterValue[] | null> {
  const url = filterUrl(base, type, { peopleValues: trait }, { items, traits, q });
  return url ? readValues(url, signal, fetchImpl) : [];
}

async function readValues(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<FilterValue[] | null> {
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      unanswered(url, res);
      return null;
    }
    const values = ((await res.json()) as { values?: unknown }).values;
    if (!Array.isArray(values)) {
      unanswered(url, new Error('values without a list'));
      return null;
    }
    return (values as Record<string, unknown>[]).flatMap((v): FilterValue[] =>
      typeof v.id === 'string' && typeof v.name === 'string'
        ? [
            {
              id: v.id,
              name: v.name,
              count: typeof v.count === 'number' ? v.count : 0,
              ...(typeof v.tmdbId === 'number' ? { tmdbId: v.tmdbId } : {}),
            },
          ]
        : [],
    );
  } catch (error) {
    unanswered(url, error);
    return null;
  }
}

/**
 * Several answers' values as one list, most titles first: a value in more than one (a person in films and series)
 * once, its counts added.
 */
export function mergeFilterValues(lists: readonly (FilterValue[] | null)[]): FilterValue[] {
  const merged = new Map<string, FilterValue>();
  for (const value of lists.flatMap((list) => list ?? [])) {
    const known = merged.get(value.id);
    merged.set(value.id, known ? { ...known, count: known.count + value.count } : value);
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

/** The traits' counts beside a selection and the traits picked (`people/counts.json`). */
export interface PeopleCounts {
  /** The people credited under the selection and holding every trait. */
  total: number;
  /** Trait → its counts, shaped as `counts.json`'s kinds: the Wikidata kinds labelled. */
  traits: Record<string, FilterKindCounts>;
}

/** atlas's trait counts; null where the route isn't there, fails, or the question is refused. */
export async function fetchPeopleCounts(
  base: string,
  type: ExploreType,
  items: FilterItem[],
  traits: FilterItem[],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<PeopleCounts | null> {
  const url = filterUrl(base, type, 'peopleCounts', { items, traits });
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      unanswered(url, res);
      return null;
    }
    const body = (await res.json()) as Record<string, unknown> | null;
    const kinds = body?.traits;
    if (!body || !kinds || typeof kinds !== 'object') {
      unanswered(url, new Error('people counts without traits'));
      return null;
    }
    return {
      total: typeof body.total === 'number' ? body.total : 0,
      traits: kinds as Record<string, FilterKindCounts>,
    };
  } catch (error) {
    unanswered(url, error);
    return null;
  }
}

/** One title a person is known for: among their biggest under the selection, as atlas's cards name it. */
export interface KnownFor {
  type: MediaType;
  id: number;
  title: string;
  year?: number;
}

/** One person as `people.json` lists them, less what Den doesn't show. */
export interface FilterPerson {
  /** Their Wikidata id. */
  id: string;
  name: string;
  /** Their TMDB id: what their page is addressed by. */
  tmdbId?: number;
  knownFor: KnownFor[];
}

function knownFor(value: unknown): KnownFor[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[]).flatMap((t): KnownFor[] => {
    const type = t.type === 'series' ? 'tv' : t.type === 'movie' ? 'movie' : undefined;
    return type && typeof t.id === 'number' && typeof t.title === 'string'
      ? [
          {
            type,
            id: t.id,
            title: t.title,
            ...(typeof t.year === 'number' ? { year: t.year } : {}),
          },
        ]
      : [];
  });
}

/**
 * The people credited under a selection and holding every trait, a page at a time, in `order`: each page's people
 * and the total there are. Throws `FilterUnavailable` for a 404, and for an answer that left a picked title kind or
 * trait out, or named one of their values unknown — its people would not be the selection's.
 */
export function filterPeople(
  base: string,
  type: ExploreType,
  items: FilterItem[],
  traits: FilterItem[],
  order?: string,
  { fetchImpl = relayFetch }: { fetchImpl?: typeof fetch } = {},
): (page: number) => Promise<{ people: FilterPerson[]; total: number }> {
  const picked = new Set([...items, ...traits].map((item) => item.kind.toLowerCase()));
  return async (page) => {
    const url = filterUrl(base, type, 'people', {
      items,
      traits,
      order,
      skip: (page - 1) * TITLES_PAGE,
    });
    if (!url) throw new FilterUnavailable('atlas refuses this selection');
    const res = await fetchImpl(url);
    if (res.status === 404) throw new FilterUnavailable('atlas has no people route', false);
    if (!res.ok) throw new Error(`atlas answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const missing = [
      ...strings(body.ignored),
      ...strings(body.kindsUnavailable),
      ...strings(body.ignoredTraits),
      ...strings(body.traitsUnavailable),
    ].filter((kind) => picked.has(kind));
    if (missing.length) throw new FilterUnavailable(`atlas can't apply ${missing.join(', ')}`);
    const unknown = [...strings(body.unknownValues), ...strings(body.unknownTraits)];
    if (unknown.length) throw new FilterUnavailable(`atlas has no ${unknown.join(', ')}`);
    const people = (
      Array.isArray(body.people) ? (body.people as Record<string, unknown>[]) : []
    ).flatMap((p): FilterPerson[] =>
      typeof p.id === 'string' && typeof p.name === 'string'
        ? [
            {
              id: p.id,
              name: p.name,
              ...(typeof p.tmdbId === 'number' ? { tmdbId: p.tmdbId } : {}),
              knownFor: knownFor(p.knownFor),
            },
          ]
        : [],
    );
    return { people, total: typeof body.total === 'number' ? body.total : people.length };
  };
}
