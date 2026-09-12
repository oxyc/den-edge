// Den's text search, ported from the TV's TMDBDiscovery.searchStream so the web answers a query the way the TV
// does. A strong facet ("spanish series", "80s korean horror") browses the facet lane. Otherwise the first paint is
// TMDB — a trailing "(1999)" routed to a year-scoped search, the singular/plural variant appended, a top person hit
// expanded into their films — with the exact title promoted; then semantic hits fold in, and the exact title leads
// the titles similar to it. The TV's on-device indexes are atlas here: its fuzzy title index leads the first paint,
// as the TV's does. Every source is best-effort except TMDB's multi search, whose failure still leaves the title
// index and the semantic tail, as on the TV.

import type { MediaType, Title } from './library';

export interface Ref {
  type: MediaType;
  id: number;
}

export interface Person {
  id: number;
  name: string;
  profilePath?: string;
}

export type Hit = { kind: 'title'; title: Title } | { kind: 'person'; person: Person };

export interface FacetAnswer {
  /** What atlas read in the query; null when it names no facet. */
  facet: {
    mediaType: MediaType | null;
    country: string | null;
    decade: number | null;
    leftover: string;
  } | null;
  /** The matching titles, a leftover theme ranked to the front. */
  titles: Ref[];
}

export interface SearchSources {
  /** atlas's fuzzy title index — the TV's on-device one: typo-tolerant, popularity-ranked, movies and series. */
  titles(query: string): Promise<Ref[]>;
  /** TMDB /search/multi in TMDB's order; rejects when TMDB can't answer. */
  multi(query: string): Promise<Hit[]>;
  /** Exact matches from that release year, movies then series. */
  byYear(query: string, year: number): Promise<Title[]>;
  /** A person's own films and series, most notable first, cameos left out. */
  notableFilms(personId: number): Promise<Title[]>;
  semantic(query: string): Promise<Ref[]>;
  facets(query: string): Promise<FacetAnswer>;
  similar(ref: Ref): Promise<Ref[]>;
  title(ref: Ref): Promise<Title | null>;
}

/** The TV's hydration caps: 16 title-index hits, 12 for the semantic and similar tails, 50 for the facet lane. */
const TITLE_LIMIT = 16;
const TAIL_LIMIT = 12;
const FACET_LIMIT = 50;

export const hitKey = (hit: Hit) =>
  hit.kind === 'person' ? `person-${hit.person.id}` : `${hit.title.type}-${hit.title.id}`;

const titleHit = (title: Title): Hit => ({ kind: 'title', title });

function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = hitKey(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * NFC-composed, whitespace collapsed, and a trailing "(YYYY)" taken out as the year: TMDB's multi search finds
 * nothing for "Title (Year)" and ignores a year parameter. A year that is part of the title stays.
 */
export function normalizeQuery(query: string): { text: string; year?: number } {
  const composed = query.normalize('NFC');
  const match = /\((\d{4})\)\s*$/.exec(composed);
  const year = match ? Number(match[1]) : undefined;
  const text = composed
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return year !== undefined && year >= 1900 && year <= 2099 ? { text, year } : { text };
}

/** The last word toggled between singular and plural, for words of four letters or more. */
export function pluralVariant(query: string): string | undefined {
  const words = query.split(' ');
  const last = words.at(-1);
  if (!last || last.length < 4) return undefined;
  words[words.length - 1] = last.endsWith('s') ? last.slice(0, -1) : `${last}s`;
  return words.join(' ');
}

/** Case- and accent-folded, a leading English article dropped, so "matrix" is the exact title "The Matrix". */
export function foldedTitle(text: string): string {
  let folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  for (const article of ['the ', 'an ', 'a ']) {
    if (folded.startsWith(article)) {
      folded = folded.slice(article.length);
      break;
    }
  }
  return folded;
}

const isExact = (hit: Hit, query: string) =>
  hit.kind === 'title' && foldedTitle(hit.title.title) === foldedTitle(query);

/** Exact title matches moved to the front, in order; nothing moves when none matches. */
export function promoteExact(hits: Hit[], query: string): Hit[] {
  if (!foldedTitle(query)) return hits;
  const exact = hits.filter((h) => isExact(h, query));
  return exact.length ? [...exact, ...hits.filter((h) => !isExact(h, query))] : hits;
}

async function hydrate(refs: Ref[], limit: number, sources: SearchSources): Promise<Hit[]> {
  const titles = await Promise.all(
    refs.slice(0, limit).map((ref) => sources.title(ref).catch(() => null)),
  );
  return titles.filter((t): t is Title => t !== null).map(titleHit);
}

/**
 * The title index's hits with the franchise grouped under the top one: when it belongs to a TMDB collection, the
 * other hits from that collection move up to follow it, so "matrix" gives the films before "Matrix Dreads".
 */
async function titleIndexHits(text: string, sources: SearchSources): Promise<Hit[]> {
  const refs = await sources.titles(text).catch((): Ref[] => []);
  const hits = await hydrate(refs, TITLE_LIMIT, sources);
  const anchor = hits[0]?.kind === 'title' ? hits[0].title.collectionId : undefined;
  if (anchor === undefined) return hits;
  const inFranchise = (hit: Hit) => hit.kind === 'title' && hit.title.collectionId === anchor;
  return [...hits.filter(inFranchise), ...hits.filter((h) => !inFranchise(h))];
}

/** Year-scoped matches lead, then TMDB's own ranking, then what only the plural variant found. */
async function tmdbHits(
  text: string,
  year: number | undefined,
  sources: SearchSources,
): Promise<Hit[]> {
  const byYear =
    year === undefined ? Promise.resolve([]) : sources.byYear(text, year).catch(() => []);
  const variant = pluralVariant(text);
  const variantHits = variant ? sources.multi(variant).catch(() => []) : Promise.resolve([]);
  const primary = await sources.multi(text);
  return dedupe([...(await byYear).map(titleHit), ...primary, ...(await variantHits)]);
}

/** A person at the top leads with their notable films, so "brad pitt" shows his movies, not just a card. */
async function expandTopPerson(hits: Hit[], sources: SearchSources): Promise<Hit[]> {
  const first = hits[0];
  if (first?.kind !== 'person') return hits;
  const films = await sources.notableFilms(first.person.id).catch(() => []);
  return films.length ? dedupe([first, ...films.map(titleHit), ...hits.slice(1)]) : hits;
}

/** The exact title first, then the titles most like it, then everything else. */
async function anchorExact(fused: Hit[], query: string, sources: SearchSources): Promise<Hit[]> {
  const anchor = fused.find((h) => isExact(h, query));
  if (!anchor) return fused;
  if (anchor.kind !== 'title') return dedupe([anchor, ...fused]);
  const similar = await hydrate(
    await sources.similar(anchor.title).catch(() => []),
    TAIL_LIMIT,
    sources,
  );
  return dedupe([anchor, ...similar, ...fused]);
}

/**
 * "<facet> <person>" — "spanish series jose coronado" — is that person's work of the facet's type. Only when the
 * top multi hit is a person whose name matches the leftover, so a theme ("about a heist") isn't hijacked.
 */
async function facetPersonHits(
  leftover: string,
  mediaType: MediaType | null,
  sources: SearchSources,
) {
  const top = (await sources.multi(leftover).catch(() => []))[0];
  if (top?.kind !== 'person') return undefined;
  const [want, name] = [leftover.toLowerCase(), top.person.name.toLowerCase()];
  if (!name.includes(want) && !want.includes(name)) return undefined;
  const films = (await sources.notableFilms(top.person.id).catch(() => [])).filter(
    (t) => mediaType === null || t.type === mediaType,
  );
  return films.length ? films.map(titleHit) : undefined;
}

async function facetLane(answer: FacetAnswer, sources: SearchSources): Promise<Hit[]> {
  const leftover = answer.facet?.leftover ?? '';
  const person = leftover
    ? facetPersonHits(leftover, answer.facet?.mediaType ?? null, sources)
    : undefined;
  if (answer.titles.length === 0) return (await person) ?? [];
  const matches = await hydrate(answer.titles, FACET_LIMIT, sources);
  return dedupe((await person) ?? matches);
}

/** Results as they improve: a first paint, then the fused final list. Rejects only when nothing answered. */
export async function* searchStream(query: string, sources: SearchSources): AsyncGenerator<Hit[]> {
  const { text, year } = normalizeQuery(query);
  if (text.length < 2) return;
  // Every source starts at once; the slow ones only stop blocking the first paint.
  const facets = sources.facets(query).catch((): FacetAnswer => ({ facet: null, titles: [] }));
  const index = titleIndexHits(text, sources);
  const tmdb = tmdbHits(text, year, sources).then((hits) => expandTopPerson(hits, sources));
  tmdb.catch(() => {}); // awaited below; this only keeps an early failure from being reported unhandled
  const semantic = sources
    .semantic(text)
    .then((refs) => hydrate(refs, TAIL_LIMIT, sources))
    .catch((): Hit[] => []);

  // A country or decade is a facet; a bare "movies" or "series" is not ("batman movies" is a title search).
  const answer = await facets;
  if (answer.facet && (answer.facet.country || answer.facet.decade)) {
    const lane = await facetLane(answer, sources);
    if (lane.length) {
      yield lane;
      return;
    }
  }

  // The first paint: the title index leads — it forgives typos — then TMDB's answer.
  const local = await index;
  let first: Hit[];
  try {
    first = dedupe([...local, ...(await tmdb)]);
  } catch (error) {
    // Search matters most when TMDB is down: the title index and the semantic tail still answer if they can.
    const tail = dedupe([...local, ...(await semantic)]);
    if (tail.length === 0) throw error;
    yield promoteExact(tail, text);
    return;
  }
  yield promoteExact(first, text);
  yield await anchorExact(dedupe([...first, ...(await semantic)]), text, sources);
}
