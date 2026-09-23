// atlas's stackable filters (`/index/filter/<movie|series>/…`): for a selection of values from many kinds, how many
// titles each further value would leave (`counts.json`), the titles themselves (`titles.json`), and one kind's values
// by a typed prefix (`values/<kind>.json`, the people and characters typeahead).
//
// The URL is atlas's cache key, and through den-edge's relay a redirect arrives with no Location, so every address
// here is built in atlas's one canonical spelling (`canonicalQuery`), which `filterRoutes.test.ts` holds to atlas's
// own fixture. Where the routes are not there (a 404) or leave a picked kind out, callers fall back to what Den did
// before them: TMDB discover, atlas's rows, the feed's own titles.

import { titlesOf } from './atlasRows';
import type { MediaType, Title } from './library';
import { relayFetch } from './relayFetch';
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

type IdFormat = 'integer' | 'decade' | 'lower' | 'upper' | 'label' | 'qid' | 'character';

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
  like: { mode: 'single', id: 'integer' },
};

/** The old `structure` axis, as the axes atlas answers it with. */
const STRUCTURE_ALIAS: Record<string, string> = {
  'single-day': 'timespan',
  anthology: 'continuity',
};

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

export type FilterRoute = 'counts' | 'titles' | { values: string };

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
function normalise(rawKind: string, rawId: string): [string, string] | undefined {
  let kind = rawKind.trim().toLowerCase();
  const id = rawId.trim();
  if (!id) return undefined;
  if (kind === 'structure') kind = STRUCTURE_ALIAS[id.toLowerCase()] ?? 'chronology';
  const spec = FILTER_KINDS[kind];
  if (!spec) return [kind, id];
  const number = /^\d+$/.test(id) ? Number(id) : undefined;
  switch (spec.id) {
    case 'integer':
      return number === undefined ? undefined : [kind, String(number)];
    case 'decade':
      return number === undefined ? undefined : [kind, String(Math.floor(number / 10) * 10)];
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
  }
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A route's query in atlas's canonical spelling, with its `?`, or '' for none; undefined for a question atlas
 * refuses. `sel`: each item normalised, sorted by kind, then positive before excluded, then id, once each; then
 * `skip` and `limit` (titles) or `q` and `limit` (values), each only when not its default.
 */
export function canonicalQuery(
  route: FilterRoute,
  {
    items = [],
    skip = 0,
    limit,
    q,
  }: { items?: FilterItem[]; skip?: number; limit?: number; q?: string } = {},
): string | undefined {
  const normal: Required<FilterItem>[] = [];
  for (const item of items) {
    const pair = normalise(item.kind, item.id);
    if (!pair) return undefined;
    normal.push({ kind: pair[0], id: pair[1], exclude: !!item.exclude });
  }
  normal.sort(
    (a, b) =>
      byString(a.kind, b.kind) || Number(a.exclude) - Number(b.exclude) || byString(a.id, b.id),
  );
  const sel = normal
    .map((item) => `${item.exclude ? '-' : ''}${item.kind}:${encodeURIComponent(item.id)}`)
    .filter((item, at, all) => all.indexOf(item) === at);
  if (sel.length > MAX_SELECTION) return undefined;

  const values = typeof route === 'object' ? route.values : undefined;
  const character = values === 'character';
  const [fallback, most] =
    route === 'counts'
      ? [0, 0]
      : route === 'titles'
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
  if (route === 'titles' && skip) parts.push(`skip=${skip}`);
  if (prefix !== undefined) parts.push(`q=${encodeURIComponent(prefix)}`);
  if (route !== 'counts' && size !== fallback) parts.push(`limit=${size}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const routePath = (route: FilterRoute) =>
  route === 'counts'
    ? 'counts.json'
    : route === 'titles'
      ? 'titles.json'
      : `values/${route.values}.json`;

/** A filter route's canonical address under `base`, or undefined for a question atlas refuses. */
export function filterUrl(
  base: string,
  type: MediaType,
  route: FilterRoute,
  options: Parameters<typeof canonicalQuery>[1] = {},
): string | undefined {
  const query = canonicalQuery(route, options);
  if (query === undefined) return undefined;
  return `${base}/index/filter/${type === 'tv' ? 'series' : 'movie'}/${routePath(route)}${query}`;
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
  const match = /^\/index\/filter\/(movie|series)\/(counts|titles|values\/([a-z]+))\.json$/.exec(
    pathname,
  );
  if (!match) return undefined;
  const route: FilterRoute =
    match[2] === 'counts' ? 'counts' : match[2] === 'titles' ? 'titles' : { values: match[3]! };
  const params = new Map<string, string>();
  for (const pair of query.split('&').filter(Boolean)) {
    const at = pair.indexOf('=');
    const [name, value] = at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    if (!params.has(name)) params.set(name, value);
  }
  const items: FilterItem[] = [];
  for (const raw of decode(params.get('sel') ?? '')
    .split(',')
    .filter(Boolean)) {
    const exclude = raw.startsWith('-');
    const body = exclude ? raw.slice(1) : raw;
    const colon = body.indexOf(':');
    if (colon < 0) return undefined;
    items.push({ kind: body.slice(0, colon), id: body.slice(colon + 1), exclude });
  }
  const count = (name: string) => {
    const value = params.get(name);
    if (value === undefined || route === 'counts') return { ok: true, n: undefined };
    if (name === 'skip' && route !== 'titles') return { ok: true, n: undefined };
    return /^\d+$/.test(value) ? { ok: true, n: Number(value) } : { ok: false, n: undefined };
  };
  const [skip, limit] = [count('skip'), count('limit')];
  if (!skip.ok || !limit.ok) return undefined;
  const q = typeof route === 'object' && params.has('q') ? decode(params.get('q')!) : undefined;
  const canonical = canonicalQuery(route, { items, skip: skip.n, limit: limit.n, q });
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
  type: MediaType,
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
  type: MediaType,
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
}

/** A kind's values starting with `q`, beside a selection; none where atlas has no such route or `q` is too short. */
export async function searchFilterValues(
  base: string,
  type: MediaType,
  kind: string,
  q: string,
  items: FilterItem[] = [],
  { signal, fetchImpl = relayFetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FilterValue[]> {
  const url = filterUrl(base, type, { values: kind }, { items, q });
  if (!url) return [];
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      unanswered(url, res);
      return [];
    }
    const values = ((await res.json()) as { values?: unknown }).values;
    if (!Array.isArray(values)) {
      unanswered(url, new Error('values without a list'));
      return [];
    }
    return (values as Record<string, unknown>[]).flatMap((v): FilterValue[] =>
      typeof v.id === 'string' && typeof v.name === 'string'
        ? [{ id: v.id, name: v.name, count: typeof v.count === 'number' ? v.count : 0 }]
        : [],
    );
  } catch (error) {
    unanswered(url, error);
    return [];
  }
}
