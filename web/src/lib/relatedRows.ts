// The rows under a title (You might also like, the franchise, More from / Starring), each a `RowDef` so `BrowseRow`
// loads it a page at a time as the viewer scrolls: the more they slide, the more appears. None is a fixed slice.

import type { RowDef } from './catalog';
import { groupFilmography, type TitleDetail } from './detail';
import { likeValue } from './filterRoutes';
import { contentFilterTitles } from './contentAtlas';
import type { IconicStudio } from './iconicStudios';
import type { MediaType, Title } from './library';
import { fansId, likeId, personHref, searchHref } from './route';
import type { Browsable, TitleFacts } from './titleFacts';
import type { ContentServiceClientPort } from './libraryServiceFactory';

/** Titles a page adds: a screenful and a bit, the size TMDB's own pages come in. */
const CHUNK = 20;
/** How many plot neighbours atlas is asked for once the closer ones and TMDB's recommendations run out (its cap). */
const NEIGHBOURS = 50;

const keyOf = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

type Ref = { type: MediaType; id: number };

/**
 * `refs` drawn, in their order, from the cards atlas sent with them. A title atlas has a card for needs no request of
 * its own; the posters cards lack come from den-edge's shared metadata in one request; only what neither can draw is
 * asked of TMDB, one title at a time.
 */
async function drawRefs(
  refs: Ref[],
  cards: Title[],
  content: ContentServiceClientPort,
): Promise<Title[]> {
  const byKey = new Map(cards.map((t) => [keyOf(t), t]));
  const missing = refs.filter((ref) => !byKey.get(keyOf(ref))?.posterPath);
  const normalized = missing.length
    ? (await content.query({ kind: 'titles', titles: missing })).titles
    : [];
  const drawn = new Map(normalized.map((title) => [keyOf(title), title]));
  return refs.flatMap((ref) => drawn.get(keyOf(ref)) ?? byKey.get(keyOf(ref)) ?? []);
}

export interface RelatedOptions {
  /** Worker-owned normalized content; provider keys and response shapes remain behind it. */
  content: ContentServiceClientPort;
  /**
   * How many of atlas's closest titles to ask for at once. Its first screenful (20) is what a detail page's row
   * needs; a whole feed of them — Search's "Like" — asks for as many as atlas keeps (200).
   */
  similarLimit?: number;
  /**
   * Films and series together: atlas's closest titles as its `mixed` list, of either type, where it has one. A title
   * page's row, and Search's "Like" under All.
   */
  mixed?: boolean;
  /** Use Atlas's structural-affinity You Might Also Like order, with Similar as an old-Atlas fallback. */
  affinity?: boolean;
  /**
   * Go on to atlas's wider neighbours and TMDB's recommendations once the row's own atlas answer runs out (the
   * default). Off, the row is that answer alone, and empty where atlas has none.
   */
  fallback?: boolean;
  /**
   * The titles already offered, shared between rows on one page so a title appears once: in whichever row offered it
   * first. A row adds what it offers.
   */
  seen?: Set<string>;
}

/**
 * A related-title row without an end short of what is known. Atlas leads with either More Like This, or — when
 * `affinity` is set — its distinct structural-affinity You Might Also Like order. An Atlas predating that endpoint
 * falls back to More Like This. Wider plot neighbours follow, then TMDB pads the end with its recommendations page
 * after page. The sources are never interleaved, and a title is offered once, whichever source names it first.
 *
 * With no atlas (`atlas` null), or one with no answer for this title (unreachable, its index queries off, no
 * neighbours), the row is TMDB's recommendations alone, as it always was.
 *
 * `load` ignores its page number and walks the sources in order: a page that would hold only titles already offered
 * moves on to the next source rather than coming back empty, because an empty page is what ends a row.
 *
 * `more`, TMDB's first page of recommendations, is what a title's page already has; without it, it is fetched.
 */
export function moreLikeThisRow(
  detail: Pick<TitleDetail, 'title'> & { more?: Title[] },
  atlas: string | null,
  {
    content,
    similarLimit,
    mixed = false,
    affinity = false,
    fallback = true,
    seen = new Set(),
  }: RelatedOptions,
): RowDef {
  const self = detail.title;
  seen.add(keyOf(self));

  /** `unknown` is atlas not yet asked; whether it has anything for this title decides which way the row goes. */
  type Source = 'unknown' | 'cards' | 'similar' | 'neighbours' | 'recommended' | 'done';
  /** How far into the paged affinity row (`cardsPath`) the row has read. */
  let cardsSkip = 0;
  let source: Source = atlas === null ? 'recommended' : 'unknown';
  /** The TMDB page the detail already carried (page 1) is served first, then page 2 on. */
  let recommendedPage = 1;
  let queue: Ref[] | undefined;

  /**
   * The titles an atlas list names: its `ids`, of the seed's type, or — for a mixed row, where the answer has one —
   * its `mixed` list, each with its own type.
   */
  async function idsFrom(source: 'similar' | 'neighbours'): Promise<Ref[]> {
    try {
      const result = await content.query({
        kind: 'atlas.related',
        query: {
          operation: 'list',
          source,
          title: { type: self.type, id: self.id },
          mixed,
          limit: source === 'neighbours' ? NEIGHBOURS : similarLimit,
        },
      });
      return result.answer.state === 'ready' && result.answer.value.operation === 'refs'
        ? result.answer.value.refs
        : [];
    } catch {
      return [];
    }
  }

  /** The one requested seed's row, or null when this Atlas does not implement the affinity contract. */
  async function suggested(): Promise<Ref[] | null> {
    try {
      const result = await content.query({
        kind: 'atlas.related',
        query: {
          operation: 'suggest',
          title: { type: self.type, id: self.id },
          mixed,
          limit: similarLimit,
        },
      });
      return result.answer.state === 'ready' && result.answer.value.operation === 'refs'
        ? result.answer.value.refs
        : null;
    } catch {
      return null;
    }
  }

  /**
   * The next page of atlas's mixed affinity row as cards, drawn (`drawRefs`). `null` when this atlas has no such
   * route (the POST's ids are read instead), `undefined` once the row has nothing left.
   */
  async function drawCards(): Promise<Title[] | null | undefined> {
    try {
      const result = await content.query({
        kind: 'atlas.related',
        query: {
          operation: 'cards',
          title: { type: self.type, id: self.id },
          skip: cardsSkip,
          limit: CHUNK,
        },
      });
      if (result.answer.state !== 'ready' || result.answer.value.operation !== 'cards')
        return cardsSkip === 0 ? null : undefined;
      const { refs, titles } = result.answer.value;
      if (refs.length === 0) return undefined;
      cardsSkip += refs.length;
      const wanted = refs.filter((ref) => !seen.has(keyOf(ref)));
      return drawRefs(wanted, titles, content);
    } catch {
      return cardsSkip === 0 ? null : undefined;
    }
  }

  /** The next chunk of a queued atlas source, drawn; `undefined` once it has none left to give. */
  async function drawQueued(source: 'similar' | 'neighbours'): Promise<Title[] | undefined> {
    queue ??= await idsFrom(source);
    const wanted = queue.filter((ref) => !seen.has(keyOf(ref))).slice(0, CHUNK);
    const last = wanted[wanted.length - 1];
    queue = last ? queue.slice(queue.indexOf(last) + 1) : [];
    if (wanted.length === 0) return undefined;
    return (await content.query({ kind: 'titles', titles: wanted })).titles;
  }

  /** Where the row goes once atlas's own answer for it has run out: the wider sources, or nowhere. */
  const after: Source = fallback ? 'neighbours' : 'done';

  async function step(): Promise<Title[]> {
    if (source === 'unknown' && affinity && mixed) {
      const found = await drawCards();
      if (found !== null) {
        if (found) {
          source = 'cards';
          return found;
        }
        source = after; // atlas's affinity row for this title is empty
      }
    }
    if (source === 'cards') {
      const found = await drawCards();
      if (found) return found;
      source = after;
    }
    if (source === 'unknown') {
      queue = affinity
        ? ((await suggested()) ?? (fallback ? await idsFrom('similar') : []))
        : await idsFrom('similar');
      source = queue.length > 0 ? 'similar' : fallback ? 'recommended' : 'done';
      if (source !== 'similar') queue = undefined; // atlas has nothing for this title: TMDB alone
    }
    if (source === 'similar') {
      const found = await drawQueued('similar');
      if (found) return found;
      source = after;
      queue = undefined;
    }
    if (source === 'neighbours') {
      const found = await drawQueued('neighbours');
      if (found) return found;
      source = 'recommended'; // atlas is exhausted: TMDB pads the end
    }
    if (source === 'recommended') {
      if (recommendedPage === 1 && detail.more) {
        recommendedPage = 2;
        return detail.more;
      }
      try {
        const page = (
          await content.query({
            kind: 'catalog.page',
            catalog: { kind: 'recommendations', title: { type: self.type, id: self.id } },
            page: recommendedPage++,
          })
        ).titles;
        if (page.length > 0) return page;
      } catch {
        // TMDB has nothing deeper, or isn't answering: the row is as long as it gets.
      }
      source = 'done';
    }
    return [];
  }

  return {
    id: affinity ? 'you-might-also-like' : 'more-like-this',
    title: affinity ? 'You might also like' : 'More like this',
    // The same titles as a whole page to browse and narrow: Search with this title as its "Like" — or, for You might
    // also like, its "Fans of" — under All, where they are films and series together.
    aside: affinity
      ? { label: 'Explore', href: searchHref('', { chips: [fansId(self)] }) }
      : { label: 'Explore similar', href: searchHref('', { chips: [likeId(self)] }) },
    load: async () => {
      while (source !== 'done') {
        const fresh = (await step()).filter((t) => {
          if (seen.has(keyOf(t))) return false;
          seen.add(keyOf(t));
          return true;
        });
        if (fresh.length > 0) return fresh;
      }
      return [];
    },
  };
}

/** How many pages `firstScreen` reads while looking for a title that survives the hide rules (`BrowseRow`'s burst). */
const SEARCH_PAGES = 3;

/**
 * A row only once it has something to show. Reads pages until one holds a title `keep` admits, and answers with the
 * row served from what it read, so the loader is not asked for them again; null when there is nothing. A row nobody
 * can see never takes room on the page, so nothing shifts when it turns out empty (which would also move a
 * scroll position restored on Back).
 */
export async function firstScreen(
  row: RowDef,
  keep: (title: Title) => boolean,
): Promise<RowDef | null> {
  const read: Title[][] = [];
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    let titles: Title[];
    try {
      titles = await row.load(page);
    } catch {
      break;
    }
    read.push(titles);
    if (titles.length === 0) break;
    if (titles.some((t) => keep(t) && (row.filter?.(t) ?? true))) {
      return { ...row, load: async (page) => read[page - 1] ?? row.load(page) };
    }
  }
  return null;
}

/**
 * `row` with a poster for every card: atlas's filter sends none, den-edge's shared metadata has only the titles it has
 * already seen, and a title page hides a card without one — which left "More from Telecinco Cinema" 2 of its 33. What
 * neither has is asked of TMDB, one title at a time, as the franchise row does (`drawRefs`).
 */
export function withPosters(row: RowDef, { content }: RelatedOptions): RowDef {
  return {
    ...row,
    load: async (page) => {
      const loaded = await row.load(page);
      const missing = loaded.filter((title) => !title.posterPath && !title.posterUrl);
      if (!missing.length) return loaded;
      const normalized = (await content.query({ kind: 'titles', titles: missing })).titles;
      const byKey = new Map(normalized.map((title) => [keyOf(title), title]));
      return loaded.map((title) => ({ ...title, ...byKey.get(keyOf(title)) }));
    },
  };
}

/** Every indexed title from one curated studio, films and series together, except the title already open. */
export function studioRow(
  studio: IconicStudio,
  self: Title,
  content: ContentServiceClientPort,
): RowDef {
  return {
    id: `studio-${studio.id}`,
    title: `More from ${studio.name}`,
    headingLink: {
      before: 'More from ',
      label: studio.name,
      after: '',
      href: searchHref('', { chips: [`studio-${studio.id}`] }),
    },
    filter: (title) => keyOf(title) !== keyOf(self),
    load: contentFilterTitles(content, 'all', [{ kind: 'studio', id: studio.id }]),
  };
}

/** More titles in a non-English original language, kept low on the page as a regional discovery row. */
export function languageRow(
  language: { id: string; name: string },
  self: Title,
  content: ContentServiceClientPort,
): RowDef {
  const label = `in ${language.name}`;
  return {
    id: `language-${language.id}`,
    title: `More ${label}`,
    headingLink: {
      before: 'More ',
      label,
      after: '',
      href: searchHref('', { type: self.type, chips: [`lang-${language.id}`] }),
    },
    // Atlas's broad language facts may contain several languages; its card's single original language is the
    // stricter meaning this row promises.
    filter: (title) => keyOf(title) !== keyOf(self) && title.originalLanguage === language.id,
    load: contentFilterTitles(content, self.type, [{ kind: 'language', id: language.id }]),
  };
}

/** Where each language is at home: the countries a title in it is "from" when it lists them. */
const HOMES: Record<string, string[]> = {
  es: [
    'ES',
    'MX',
    'AR',
    'CO',
    'CL',
    'PE',
    'VE',
    'UY',
    'CU',
    'BO',
    'EC',
    'PY',
    'DO',
    'GT',
    'CR',
    'PR',
  ],
  ca: ['ES'],
  eu: ['ES'],
  gl: ['ES'],
  pt: ['BR', 'PT'],
  fr: ['FR', 'BE', 'CA', 'CH', 'LU', 'SN', 'MA', 'DZ', 'TN'],
  de: ['DE', 'AT', 'CH'],
  it: ['IT', 'CH'],
  nl: ['NL', 'BE'],
  sv: ['SE', 'FI'],
  da: ['DK'],
  no: ['NO'],
  nb: ['NO'],
  nn: ['NO'],
  fi: ['FI'],
  is: ['IS'],
  et: ['EE'],
  lv: ['LV'],
  lt: ['LT'],
  pl: ['PL'],
  cs: ['CZ'],
  sk: ['SK'],
  sl: ['SI'],
  hu: ['HU'],
  ro: ['RO', 'MD'],
  bg: ['BG'],
  hr: ['HR', 'BA'],
  sr: ['RS', 'BA'],
  bs: ['BA'],
  mk: ['MK'],
  sq: ['AL', 'XK'],
  el: ['GR', 'CY'],
  tr: ['TR'],
  ru: ['RU'],
  uk: ['UA'],
  be: ['BY'],
  ka: ['GE'],
  hy: ['AM'],
  he: ['IL'],
  ar: ['EG', 'LB', 'SA', 'AE', 'MA', 'TN', 'DZ', 'SY', 'JO', 'IQ', 'PS', 'QA', 'KW'],
  fa: ['IR'],
  ur: ['PK'],
  hi: ['IN'],
  bn: ['IN', 'BD'],
  ta: ['IN', 'LK'],
  te: ['IN'],
  ml: ['IN'],
  kn: ['IN'],
  mr: ['IN'],
  pa: ['IN', 'PK'],
  ja: ['JP'],
  ko: ['KR'],
  zh: ['CN', 'TW', 'HK', 'SG'],
  cn: ['CN', 'HK'],
  th: ['TH'],
  vi: ['VN'],
  id: ['ID'],
  ms: ['MY'],
  tl: ['PH'],
};

/**
 * The country a title is "from" for its row: the first of `countries` where `language` is at home — Swedish is
 * Sweden, not the German co-producer Wikidata names first for The Bridge. Undefined where none is (a Spanish-language
 * US film, a language not listed here): the language row says it better.
 */
export const homeCountry = (language: string, countries: string[]): string | undefined =>
  countries.find((country) => HOMES[language]?.includes(country));

/** Countries named with "the" in English: "More from the Netherlands". */
const WITH_THE = new Set(['NL', 'PH', 'AE', 'DO']);

/**
 * More titles made in a title's country and language, films and series together: "More from Spain". Atlas's country
 * is any production country, so it is paired with the language, and a card must be in that original language — a
 * Hollywood film shot in Spain lists Spain too. A country says more than its language does (Spanish is Spain,
 * Mexico, Argentina…), so where a title has one this row takes the language row's place.
 */
export function countryRow(
  country: { id: string; name: string },
  language: string,
  self: Title,
  content: ContentServiceClientPort,
): RowDef {
  const name = WITH_THE.has(country.id) ? `the ${country.name}` : country.name;
  return {
    id: `country-${country.id}`,
    title: `More from ${name}`,
    headingLink: {
      before: 'More from ',
      label: name,
      after: '',
      href: searchHref('', { chips: [`country-${country.id}`, `lang-${language}`] }),
    },
    filter: (title) => keyOf(title) !== keyOf(self) && title.originalLanguage === language,
    load: contentFilterTitles(content, 'all', [
      { kind: 'country', id: country.id },
      { kind: 'language', id: language },
    ]),
  };
}

/** A studio or network's row is worth it between these many titles: fewer is no row, more says nothing (Warner Bros.). */
const PRODUCER_TITLES = { min: 10, max: 300 };

const folded = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * "More from Showtime": the network a series aired on, then the company that made a title, one row each at most, from
 * atlas's facts. Only the right size to say something (`PRODUCER_TITLES`), and none a curated studio row already shows.
 */
export function producerRows(
  facts: TitleFacts,
  studios: IconicStudio[],
  self: Title,
  content: ContentServiceClientPort,
): RowDef[] {
  const taken = new Set(studios.flatMap((studio) => [studio.id, folded(studio.name)]));
  const fits = (value: Browsable) =>
    value.titles >= PRODUCER_TITLES.min &&
    value.titles <= PRODUCER_TITLES.max &&
    !taken.has(value.id) &&
    !taken.has(folded(value.name));
  const rows: RowDef[] = [];
  const network = facts.networks.find(fits);
  if (network) {
    rows.push(producerRow('network', network, self, content));
    taken.add(network.id).add(folded(network.name));
  }
  const company = facts.companies.filter(fits).sort((a, b) => b.titles - a.titles)[0];
  if (company) rows.push(producerRow('company', company, self, content));
  return rows;
}

function producerRow(
  kind: 'network' | 'company',
  value: Browsable,
  self: Title,
  content: ContentServiceClientPort,
): RowDef {
  return {
    id: `${kind}-${value.id}`,
    title: `More from ${value.name}`,
    headingLink: {
      before: 'More from ',
      label: value.name,
      after: '',
      href: searchHref('', { chips: [`${kind}-${value.id}`] }),
    },
    filter: (title) => keyOf(title) !== keyOf(self),
    load: contentFilterTitles(content, 'all', [{ kind, id: value.id }]),
  };
}

/** A subject or place's row is worth it between these many titles: fewer is a row of a few, more says nothing (New York City). */
const THEME_TITLES = { min: 8, max: 300 };

/**
 * "More about drug trafficking" and "Set in Baltimore", from atlas's facts: the first subject and the first place the
 * right size to say something (`THEME_TITLES`), films and series together. A place that is the title's own country
 * (`countryName`) is left to the country row.
 */
export function themeRows(
  facts: TitleFacts,
  self: Title,
  content: ContentServiceClientPort,
  countryName?: string,
): RowDef[] {
  const fits = (value: Browsable) =>
    value.titles >= THEME_TITLES.min && value.titles <= THEME_TITLES.max;
  const rows: RowDef[] = [];
  const subject = facts.subjects.find(fits);
  if (subject) rows.push(themeRow('subject', subject, 'More about ', self, content));
  const country = countryName && folded(countryName);
  const place = facts.places.find((value) => fits(value) && folded(value.name) !== country);
  if (place) rows.push(themeRow('place', place, 'Set in ', self, content));
  return rows;
}

function themeRow(
  kind: 'subject' | 'place' | 'author',
  value: Browsable,
  before: string,
  self: Title,
  content: ContentServiceClientPort,
): RowDef {
  return {
    id: `${kind}-${value.id}`,
    title: `${before}${value.name}`,
    headingLink: {
      before,
      label: value.name,
      after: '',
      href: searchHref('', { chips: [`${kind}-${value.id}`] }),
    },
    filter: (title) => keyOf(title) !== keyOf(self),
    load: contentFilterTitles(content, 'all', [{ kind, id: value.id }]),
  };
}

/**
 * "More adapted from Frank Herbert": every other title adapted from the same author's work, from atlas's facts,
 * including what the franchise and other-versions rows also show — the whole list is what the row is for. Any author
 * with another adaptation has one. The name opens Search on that author.
 */
export function authorRow(
  facts: TitleFacts,
  self: Title,
  content: ContentServiceClientPort,
): RowDef | null {
  const author = facts.authors.find((value) => value.titles >= 2);
  return author ? themeRow('author', author, 'More adapted from ', self, content) : null;
}

/** How a mood reads in "More … like this"; a mood not named here is its own label, lowercased. */
const MOOD_WORDS: Record<string, string> = {
  'Dark & Gritty': 'dark and gritty',
  'Tense/Edge-of-seat': 'tense',
  'Quirky/Offbeat': 'quirky',
  'Visually-stunning': 'visually stunning',
  Tearjerker: 'heartbreaking',
  'Comfort-watch': 'comforting',
};
/** Moods that say how a title is watched or ends, not how it feels: no row reads well for them. */
const NOT_A_FEELING = new Set(['Bingeable', 'Twist-ending']);

/**
 * "More tense like this": the titles closest to this one that share its strongest mood, in atlas's likeness order,
 * films and series together. A narrower More like this, so it shares that row's `seen` and waits for its first page
 * (`after`): a title shows in one of them only, and the closer row keeps it.
 */
export function moodRow(
  moods: string[],
  self: Title,
  content: ContentServiceClientPort,
  { seen, after }: { seen: Set<string>; after: Promise<void> },
): RowDef | null {
  const mood = moods.find((label) => !NOT_A_FEELING.has(label));
  if (!mood) return null;
  const word = MOOD_WORDS[mood] ?? mood.toLowerCase().replace(/[-/]/g, ' ');
  const load = contentFilterTitles(content, 'all', [
    { kind: 'like', id: likeValue(self, 'all') },
    { kind: 'mood', id: mood },
  ]);
  let read = 0;
  return {
    id: `mood-like-${mood}`,
    // No link: Search takes a "Like" or a mood, never both, so no page there shows these titles.
    title: `More ${word} like this`,
    filter: (title) => keyOf(title) !== keyOf(self),
    load: async () => {
      await after;
      // A page all shown above reads on: an empty page would end the row.
      for (;;) {
        const titles = await load(++read);
        if (titles.length === 0) return [];
        const fresh = titles.filter((t) => !seen.has(keyOf(t)));
        for (const t of fresh) seen.add(keyOf(t));
        if (fresh.length > 0) return fresh;
      }
    },
  };
}

/** The franchise a film belongs to, in release order: one fetch, one page. */
export function collectionRow(
  collection: { id: number; name: string },
  self: Title,
  { content }: RelatedOptions,
): RowDef {
  return {
    id: `collection-${collection.id}`,
    title: collection.name,
    filter: (t) => keyOf(t) !== keyOf(self),
    load: async (page) =>
      page === 1 ? (await content.query({ kind: 'collection', id: collection.id })).titles : [],
  };
}

/**
 * The title's curated primary franchise from atlas, with TMDB's movie collection only when atlas has none.
 * Atlas already orders the mixed film/TV members for this seed: its era first, newest first within each era.
 * Its cards carry no posters, so the members are drawn (`drawRefs`) in that order; a card left without one would be
 * hidden as blank, and the whole row with it.
 * A primary with no other member is still authoritative: there is no row, and it deliberately does not fall
 * through to a different, narrower TMDB grouping.
 */
export async function franchiseRow(
  collection: { id: number; name: string } | undefined,
  self: Title,
  atlas: string | null,
  options: RelatedOptions,
): Promise<RowDef | null> {
  if (atlas) {
    try {
      const result = await options.content.query({
        kind: 'atlas.related',
        query: { operation: 'franchise', title: { type: self.type, id: self.id } },
      });
      if (result.answer.state === 'ready' && result.answer.value.operation === 'franchise') {
        const { id, name, members: cards } = result.answer.value;
        const refs = cards
          .filter((card) => keyOf(card) !== keyOf(self))
          .map(({ type, id }) => ({ type, id }));
        if (refs.length === 0) return null;
        let members: Promise<Title[]> | undefined;
        return {
          id: `franchise-${id}`,
          title: name,
          filter: (title) => keyOf(title) !== keyOf(self),
          load: async (page) =>
            page === 1 ? await (members ??= drawRefs(refs, cards, options.content)) : [],
        };
      }
    } catch {
      // An older/unreachable atlas has no curated answer; preserve the existing TMDB collection fallback.
    }
  }
  return collection ? collectionRow(collection, self, options) : null;
}

/**
 * The other versions of the title's story from atlas (`/index/versions`): remakes, and other adaptations of the same
 * book, play or character, films and series together, in atlas's order (release, then popularity). A version in a
 * franchise comes with the rest of that franchise, each card captioned with the franchise's label ("Wallander
 * (Sweden)"); a remake outside one says "Remake". Atlas leaves out the title's own curated franchise; whatever the
 * franchise row shows is left out here too, since that row can be TMDB's collection instead. One page: atlas answers
 * with every version at once. Null when there are none, or when the atlas predates the route, so the page never shows
 * the row empty.
 */
export async function versionsRow(
  self: Title,
  atlas: string | null,
  franchise: Promise<RowDef | null>,
  { content }: RelatedOptions,
): Promise<RowDef | null> {
  if (!atlas) return null;
  try {
    const result = await content.query({
      kind: 'atlas.related',
      query: { operation: 'versions', title: { type: self.type, id: self.id } },
    });
    if (result.answer.state !== 'ready' || result.answer.value.operation !== 'versions')
      return null;
    const listed = result.answer.value.versions;
    /** What each card says beside its year: its franchise's label, else "Remake" for a remake. */
    const notes = new Map(
      listed.flatMap(({ title, note }) => (note ? [[keyOf(title), note]] : [])),
    );
    const refs = listed.map(({ title }) => ({ type: title.type, id: title.id }));
    const elsewhere = new Set<string>(
      (await franchise.then((row) => row?.load(1)).catch(() => undefined))?.map(keyOf),
    );
    elsewhere.add(keyOf(self));
    const wanted = refs.filter((ref) => !elsewhere.has(keyOf(ref)));
    if (wanted.length === 0) return null;
    const titles = await drawRefs(
      wanted,
      listed.map(({ title }) => title),
      content,
    );
    if (titles.length === 0) return null;
    return {
      id: 'other-versions',
      title: 'Other versions',
      caption: (t) => {
        const note = notes.get(keyOf(t));
        return note ? [t.year, note].filter(Boolean).join(' · ') : undefined;
      },
      load: async (page) => (page === 1 ? titles : []),
    };
  } catch {
    return null;
  }
}

type Department = 'Directing' | 'Writing' | 'Acting';

/** The most filmography rows one title page shows, and the most of them that are "Starring". */
const MAX_PERSON_ROWS = 5;
const MAX_LEAD_ROWS = 3;

/**
 * The filmography rows a title gets, in display order: its director, creator and writer (one row each), then its
 * leads. Each person gets one row, under their first role in that order, so an auteur who wrote and directed is
 * "More from", not also "Written by". Stops at MAX_PERSON_ROWS, so the leads are what a fully credited title gives
 * up. The TV builds the same rows (DetailModel.personRows).
 */
export function personRows(
  detail: Pick<TitleDetail, 'directors' | 'creators' | 'writers' | 'cast'>,
): { person: { id: number; name: string }; department: Department; before: string }[] {
  const seen = new Set<number>();
  const fresh = (people: { id: number; name: string }[]) => people.filter((p) => !seen.has(p.id));
  const rows: ReturnType<typeof personRows> = [];
  const add = (
    person: { id: number; name: string } | undefined,
    department: Department,
    before: string,
  ) => {
    if (!person || rows.length >= MAX_PERSON_ROWS || seen.has(person.id)) return;
    seen.add(person.id);
    rows.push({ person, department, before });
  };
  add(detail.directors[0], 'Directing', 'More from ');
  add(fresh(detail.creators)[0], 'Writing', 'Created by ');
  add(fresh(detail.writers)[0], 'Writing', 'Written by ');
  for (const lead of fresh(detail.cast).slice(0, MAX_LEAD_ROWS)) add(lead, 'Acting', 'Starring ');
  return rows;
}

/**
 * What a person did in one department ("More from <director>", "Written by <writer>", "Starring <lead>"), the whole
 * of it: the filmography is one fetch, cut into pages so the row keeps going as far as they have worked.
 */
export function personRow(
  person: { id: number; name: string },
  department: Department,
  self: Title,
  { content }: RelatedOptions,
  before = department === 'Directing'
    ? 'More from '
    : department === 'Writing'
      ? 'Written by '
      : 'Starring ',
): RowDef {
  let films: Promise<Title[]> | undefined;
  return {
    id: `${department.toLowerCase()}-${person.id}`,
    title: `${before}${person.name}`,
    headingLink: {
      before,
      label: person.name,
      after: '',
      href: personHref(person.id, person.name),
    },
    filter: (t) => keyOf(t) !== keyOf(self),
    load: async (page) => {
      films ??= content.query({ kind: 'person.filmography', id: person.id }).then(
        ({ credits }) =>
          groupFilmography(credits.state === 'ready' ? credits.value : [])
            .find((g) => g.department === department)
            ?.films.map((c) => c.title) ?? [],
      );
      return (await films).slice((page - 1) * CHUNK, page * CHUNK);
    },
  };
}
