import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import type { RowDef } from './catalog';
import { collectionRow, firstScreen, moreLikeThisRow, personRow } from './relatedRows';

const self: Title = { type: 'movie', id: 550, title: 'Fight Club' };
const named = (id: number): Title => ({ type: 'movie', id, title: `T${id}` });

/** A TMDB and atlas that answer from a table keyed by the request path, recording what was asked. */
function answering(table: Record<string, unknown>, asked: string[] = []) {
  const fetchImpl = (async (input: string) => {
    const url = new URL(input, 'https://den.test');
    const page = url.pathname.includes('recommendations')
      ? `?page=${url.searchParams.get('page')}`
      : '';
    const path = `${url.pathname}${page}${url.pathname.includes('/index/') ? url.search : ''}`;
    asked.push(path);
    const body = table[path];
    return body === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return fetchImpl;
}

const results = (ids: number[]) => ({ results: ids.map((id) => ({ id, title: `T${id}` })) });
const movie = (id: number) => [`/3/movie/${id}`, { id, title: `T${id}` }] as const;
const ids = (row: { load: (page: number) => Promise<Title[]> }, pages: number) =>
  (async () => {
    const out: number[][] = [];
    for (let page = 1; page <= pages; page++) out.push((await row.load(page)).map((t) => t.id));
    return out;
  })();

describe('moreLikeThisRow', () => {
  it('leads with atlas, best match first, then its wider neighbours, and only then pads with TMDB', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/similar/movie/550.json': { ids: [11, 12] },
        '/atlas/index/neighbours/movie/550.json?k=50': { ids: [12, 13, 14] },
        '/3/movie/550/recommendations?page=2': results([21, 12, 22]),
        '/3/movie/550/recommendations?page=3': results([]),
        ...Object.fromEntries([11, 12, 13, 14].map(movie)),
      },
      asked,
    );
    const row = moreLikeThisRow({ title: self, more: [named(20)] }, '/atlas', {
      key: 'k',
      fetchImpl,
    });

    expect(await ids(row, 6)).toEqual([
      [11, 12], //   atlas's closest, in the order it ranked them
      [13, 14], //   atlas's wider neighbours, minus what is already shown (12)
      [20], //       atlas has no more: TMDB pads the end, starting with the page the detail carried
      [21, 22], //   TMDB page 2, minus what is already shown (12)
      [], //         nothing left: the row ends
      [],
    ]);
    // Never interleaved: TMDB is not asked for anything until atlas has given all it has.
    const firstTmdb = asked.findIndex((p) => p.includes('recommendations'));
    expect(firstTmdb).toBeGreaterThan(asked.indexOf('/atlas/index/neighbours/movie/550.json?k=50'));
    // 12 was named twice by atlas and once by TMDB, and drawn once.
    expect(asked.filter((p) => p === '/3/movie/12')).toHaveLength(1);
  });

  it('is more than the one page of recommendations it used to be', async () => {
    const fetchImpl = answering({
      '/3/movie/550/recommendations?page=2': results([21, 22]),
      '/3/movie/550/recommendations?page=3': results([23]),
      '/3/movie/550/recommendations?page=4': results([]),
    });
    const row = moreLikeThisRow({ title: self, more: [named(20)] }, null, { key: 'k', fetchImpl });

    expect(await ids(row, 5)).toEqual([[20], [21, 22], [23], [], []]);
  });

  it('is TMDB’s recommendations alone, and asks atlas nothing, when there is no atlas', async () => {
    const none: string[] = [];
    const row = moreLikeThisRow({ title: self, more: [named(20)] }, null, {
      key: 'k',
      fetchImpl: answering({ '/3/movie/550/recommendations?page=2': results([21]) }, none),
    });
    expect(await ids(row, 3)).toEqual([[20], [21], []]);
    expect(none.some((p) => p.includes('/index/') || p.startsWith('/atlas'))).toBe(false);
  });

  it('falls back to TMDB alone when atlas is down, or has no titles for this one', async () => {
    for (const atlasAnswer of [{}, { ids: [] }] as const) {
      const asked: string[] = [];
      const fetchImpl = answering(
        {
          ...(Object.keys(atlasAnswer).length
            ? { '/atlas/index/similar/movie/550.json': atlasAnswer }
            : {}), // down: the request is refused
          '/3/movie/550/recommendations?page=2': results([21]),
          '/3/movie/550/recommendations?page=3': results([]),
        },
        asked,
      );
      const row = moreLikeThisRow({ title: self, more: [named(20)] }, '/atlas', {
        key: 'k',
        fetchImpl,
      });

      expect(await ids(row, 4)).toEqual([[20], [21], [], []]);
      // An atlas with nothing for the title has no wider neighbours either: it is not asked again.
      expect(asked.some((p) => p.includes('/index/neighbours/'))).toBe(false);
    }
  });

  it('moves on from a page of titles it has already offered rather than ending the row on it', async () => {
    const fetchImpl = answering({
      '/3/movie/550/recommendations?page=2': results([20]), // all seen
      '/3/movie/550/recommendations?page=3': results([23]),
      '/3/movie/550/recommendations?page=4': results([]),
    });
    const row = moreLikeThisRow({ title: self, more: [named(20)] }, null, { key: 'k', fetchImpl });

    expect(await ids(row, 3)).toEqual([[20], [23], []]);
  });

  it('never offers the title itself', async () => {
    const fetchImpl = answering({
      '/atlas/index/similar/movie/550.json': { ids: [550, 11] },
      '/atlas/index/neighbours/movie/550.json?k=50': { ids: [] },
      '/3/movie/550/recommendations?page=2': results([]),
      ...Object.fromEntries([11].map(movie)),
    });
    const row = moreLikeThisRow({ title: self, more: [self] }, '/atlas', { key: 'k', fetchImpl });

    expect((await ids(row, 4)).flat()).toEqual([11]);
  });

  it('keeps every atlas title ahead of every TMDB one, however far it is scrolled', async () => {
    const atlasIds = Array.from({ length: 45 }, (_, i) => 100 + i);
    const fetchImpl = answering({
      '/atlas/index/similar/movie/550.json': { ids: atlasIds.slice(0, 25) },
      '/atlas/index/neighbours/movie/550.json?k=50': { ids: atlasIds },
      '/3/movie/550/recommendations?page=2': results([900, 901]),
      '/3/movie/550/recommendations?page=3': results([]),
      ...Object.fromEntries(atlasIds.map(movie)),
    });
    const row = moreLikeThisRow({ title: self, more: [named(800)] }, '/atlas', {
      key: 'k',
      fetchImpl,
    });

    const all = (await ids(row, 12)).flat();
    expect(all.slice(0, 45)).toEqual(atlasIds); //     atlas: closest first, then the wider ones
    expect(all.slice(45)).toEqual([800, 900, 901]); //  then TMDB, padding the end
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('personRow', () => {
  const acting = Array.from({ length: 45 }, (_, i) => ({
    id: 1000 + i,
    media_type: 'movie',
    title: `Film ${i}`,
    release_date: `${2000 + (i % 20)}-01-01`,
    popularity: 1,
  }));

  it('pages the whole filmography, not the first twenty, and asks for it once', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      { '/3/person/7/combined_credits': { cast: acting, crew: [] } },
      asked,
    );
    const row = personRow({ id: 7, name: 'Brad Pitt' }, 'Acting', self, { key: 'k', fetchImpl });

    const pages = await ids(row, 4);
    expect(pages.map((p) => p.length)).toEqual([20, 20, 5, 0]);
    expect(new Set(pages.flat()).size).toBe(45);
    expect(asked.filter((p) => p.endsWith('combined_credits'))).toHaveLength(1);
    expect(row.title).toBe('Starring Brad Pitt');
    expect(row.headingLink?.label).toBe('Brad Pitt');
  });

  it('keeps a director’s row to what they directed', async () => {
    const fetchImpl = answering({
      '/3/person/9/combined_credits': {
        cast: acting.slice(0, 3),
        crew: [
          {
            id: 1,
            media_type: 'movie',
            title: 'Directed',
            job: 'Director',
            department: 'Directing',
          },
        ],
      },
    });
    const row = personRow({ id: 9, name: 'Ana' }, 'Directing', self, { key: 'k', fetchImpl });

    expect((await row.load(1)).map((t) => t.title)).toEqual(['Directed']);
    expect(row.title).toBe('More from Ana');
  });

  it('leaves the title being viewed out of its own rows', () => {
    const row = personRow({ id: 9, name: 'Ana' }, 'Acting', self, { key: 'k' });
    expect(row.filter?.(self)).toBe(false);
    expect(row.filter?.(named(1))).toBe(true);
  });
});

describe('collectionRow', () => {
  it('is one page: the franchise in release order', async () => {
    const fetchImpl = answering({
      '/3/collection/5': {
        parts: [
          { id: 2, title: 'Two', release_date: '2004-01-01' },
          { id: 1, title: 'One', release_date: '2001-01-01' },
        ],
      },
    });
    const row = collectionRow({ id: 5, name: 'The Saga' }, self, { key: 'k', fetchImpl });

    expect((await row.load(1)).map((t) => t.id)).toEqual([1, 2]);
    expect(await row.load(2)).toEqual([]);
    expect(row.title).toBe('The Saga');
  });
});

describe('firstScreen', () => {
  /** A row that hands out the given pages in order and counts what it was asked for. */
  const pages = (list: Title[][], asked: number[] = []): RowDef => ({
    id: 'r',
    title: 'R',
    load: async (page) => {
      asked.push(page);
      return list[page - 1] ?? [];
    },
  });

  it('serves the pages it read without asking the loader again, and goes on from there', async () => {
    const asked: number[] = [];
    const row = await firstScreen(pages([[named(1)], [named(2)]], asked), () => true);

    expect(row).not.toBeNull();
    expect((await row!.load(1)).map((t) => t.id)).toEqual([1]);
    expect(asked).toEqual([1]);
    expect((await row!.load(2)).map((t) => t.id)).toEqual([2]);
    expect(asked).toEqual([1, 2]);
  });

  it('reads on past a page the hide rules empty, up to a few pages, to find something to show', async () => {
    const hidden = (id: number) => id < 10;
    const row = await firstScreen(
      pages([[named(1)], [named(2)], [named(30)]]),
      (t) => !hidden(t.id),
    );
    expect(row).not.toBeNull();
    expect((await row!.load(3)).map((t) => t.id)).toEqual([30]);

    expect(
      await firstScreen(pages([[named(1)], [named(2)], [named(3)], [named(30)]]), (t) => t.id > 9),
    ).toBeNull();
  });

  it('is nothing for a row with no titles, or one whose loader fails', async () => {
    expect(await firstScreen(pages([]), () => true)).toBeNull();
    const failing: RowDef = {
      id: 'f',
      title: 'F',
      load: () => Promise.reject(new Error('offline')),
    };
    expect(await firstScreen(failing, () => true)).toBeNull();
  });

  it('applies the row’s own filter, so a row of only the title being viewed is not shown', async () => {
    const own: RowDef = { ...pages([[self]]), filter: (t) => t.id !== self.id };
    expect(await firstScreen(own, () => true)).toBeNull();
  });
});
