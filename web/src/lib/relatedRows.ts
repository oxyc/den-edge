// The rows under a title (More like this, the franchise, More from / Starring), each a `RowDef` so `BrowseRow` loads
// it a page at a time as the viewer scrolls: the more they slide, the more appears. None of them is a fixed slice.

import { tmdbPages, type RowDef } from './catalog';
import { fetchCollection, fetchFilmography, groupFilmography, type TitleDetail } from './detail';
import type { Title } from './library';
import { likeId, personHref, searchHref } from './route';
import { fetchTitle } from './tmdb';
import { tmdbFetch } from './tmdbCache';

/** Titles a page adds: a screenful and a bit, the size TMDB's own pages come in. */
const CHUNK = 20;
/** How many plot neighbours atlas is asked for once the closer ones and TMDB's recommendations run out (its cap). */
const NEIGHBOURS = 50;

const keyOf = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

export interface RelatedOptions {
  /** TMDB's key, or the empty string where den-edge lends its own (`/tmdb`). */
  key: string;
  fetchImpl?: typeof fetch;
  /**
   * How many of atlas's closest titles to ask for at once. Its first screenful (20) is what a detail page's row
   * needs; a whole feed of them — Search's "Like" — asks for as many as atlas keeps (200).
   */
  similarLimit?: number;
}

/**
 * "More like this", without an end short of what is known. atlas leads, because its index judges better than TMDB's
 * co-viewing: its closest titles first (premise neighbours, gated by animation, genre and plot agreement), then its
 * wider plot neighbours. Only when atlas has nothing more does TMDB pad the end of the row with its recommendations,
 * page after page. The two are never interleaved, and a title is offered once, whichever source names it first.
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
  { key, fetchImpl = tmdbFetch, similarLimit }: RelatedOptions,
): RowDef {
  const self = detail.title;
  const kind = self.type === 'tv' ? 'series' : 'movie';
  const seen = new Set<string>([keyOf(self)]);
  const recommendations = tmdbPages(key, fetchImpl);

  const similarPath = `/index/similar/${kind}/${self.id}.json${similarLimit ? `?limit=${similarLimit}` : ''}`;
  const neighboursPath = `/index/neighbours/${kind}/${self.id}.json?k=${NEIGHBOURS}`;

  /** `unknown` is atlas not yet asked; whether it has anything for this title decides which way the row goes. */
  type Source = 'unknown' | 'similar' | 'neighbours' | 'recommended' | 'done';
  let source: Source = atlas === null ? 'recommended' : 'unknown';
  /** The TMDB page the detail already carried (page 1) is served first, then page 2 on. */
  let recommendedPage = 1;
  let queue: number[] | undefined;

  async function idsFrom(path: string): Promise<number[]> {
    try {
      const res = await fetchImpl(`${atlas}${path}`);
      if (!res.ok) return [];
      const ids = ((await res.json()) as { ids?: unknown }).ids;
      return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : [];
    } catch {
      return [];
    }
  }

  /** The next chunk of a queued atlas source, drawn; `undefined` once it has none left to give. */
  async function drawQueued(path: string): Promise<Title[] | undefined> {
    queue ??= await idsFrom(path);
    const wanted = queue.filter((id) => !seen.has(keyOf({ type: self.type, id }))).slice(0, CHUNK);
    queue = queue.slice(queue.indexOf(wanted[wanted.length - 1] ?? -1) + 1);
    if (wanted.length === 0) return undefined;
    const drawn = await Promise.all(
      wanted.map((id) => fetchTitle({ type: self.type, id }, key, fetchImpl)),
    );
    return drawn.filter((t): t is Title => t !== null);
  }

  async function step(): Promise<Title[]> {
    if (source === 'unknown') {
      queue = await idsFrom(similarPath);
      source = queue.length > 0 ? 'similar' : 'recommended';
      if (source === 'recommended') queue = undefined; // atlas has nothing for this title: TMDB alone
    }
    if (source === 'similar') {
      const found = await drawQueued(similarPath);
      if (found) return found;
      source = 'neighbours';
      queue = undefined;
    }
    if (source === 'neighbours') {
      const found = await drawQueued(neighboursPath);
      if (found) return found;
      source = 'recommended'; // atlas is exhausted: TMDB pads the end
    }
    if (source === 'recommended') {
      if (recommendedPage === 1 && detail.more) {
        recommendedPage = 2;
        return detail.more;
      }
      try {
        const page = await recommendations(
          `/${self.type}/${self.id}/recommendations`,
          self.type,
          {},
          recommendedPage++,
        );
        if (page.length > 0) return page;
      } catch {
        // TMDB has nothing deeper, or isn't answering: the row is as long as it gets.
      }
      source = 'done';
    }
    return [];
  }

  return {
    id: 'more-like-this',
    title: 'More like this',
    // The same titles as a whole page to browse and narrow: Search with this title as its "Like".
    aside: {
      label: 'Explore similar',
      href: searchHref('', {
        type: self.type === 'tv' ? 'tv' : undefined,
        chips: [likeId(self)],
      }),
    },
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

/** The franchise a film belongs to, in release order: one fetch, one page. */
export function collectionRow(
  collection: { id: number; name: string },
  self: Title,
  { key, fetchImpl = tmdbFetch }: RelatedOptions,
): RowDef {
  return {
    id: `collection-${collection.id}`,
    title: collection.name,
    filter: (t) => keyOf(t) !== keyOf(self),
    load: async (page) => (page === 1 ? await fetchCollection(collection.id, key, fetchImpl) : []),
  };
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
  { key, fetchImpl = tmdbFetch }: RelatedOptions,
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
      films ??= fetchFilmography(person.id, key, fetchImpl).then(
        (credits) =>
          groupFilmography(credits ?? [])
            .find((g) => g.department === department)
            ?.films.map((c) => c.title) ?? [],
      );
      return (await films).slice((page - 1) * CHUNK, page * CHUNK);
    },
  };
}
