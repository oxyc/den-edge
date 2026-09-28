import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import type { RowDef } from './catalog';
import {
  collectionRow,
  firstScreen,
  franchiseRow,
  languageRow,
  moreLikeThisRow,
  personRow,
  personRows,
  studioRow,
  versionsRow,
} from './relatedRows';

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
  it('uses Atlas structural affinity for You might also like, with the single-seed POST contract', async () => {
    const asked: { path: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'https://den.test').pathname;
      asked.push({ path, init });
      if (path === '/atlas/index/suggest.json') {
        return new Response(
          JSON.stringify({
            perSeed: [
              {
                seed: { type: 'movie', id: 550 },
                ids: [11],
                mixed: [
                  { type: 'series', id: 1396 },
                  { type: 'movie', id: 11 },
                ],
              },
            ],
          }),
        );
      }
      if (path === '/3/tv/1396')
        return new Response(JSON.stringify({ id: 1396, name: 'Breaking Bad' }));
      if (path === '/3/movie/11') return new Response(JSON.stringify({ id: 11, title: 'T11' }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const row = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      key: 'k',
      fetchImpl,
      mixed: true,
      similarLimit: 200,
      affinity: true,
    });

    expect(row.title).toBe('You might also like');
    expect((await row.load(1)).map((t) => `${t.type}:${t.id}`)).toEqual(['tv:1396', 'movie:11']);
    const request = asked.find((entry) => entry.path === '/atlas/index/suggest.json');
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(request?.init?.body as string)).toEqual({
      seeds: [{ type: 'movie', id: 550 }],
      limit: 200,
    });
    expect(asked.some((entry) => entry.path.includes('/index/similar/'))).toBe(false);
  });

  it('falls back to Similar when Atlas predates the affinity endpoint', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/similar/movie/550.json?limit=200': { mixed: [{ type: 'movie', id: 11 }] },
        ...Object.fromEntries([11].map(movie)),
      },
      asked,
    );
    const row = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      key: 'k',
      fetchImpl,
      mixed: true,
      similarLimit: 200,
      affinity: true,
    });

    expect((await row.load(1)).map((t) => t.id)).toEqual([11]);
    expect(asked.slice(0, 3)).toEqual([
      '/atlas/index/suggest/movie/550.json?skip=0&limit=20',
      '/atlas/index/suggest.json',
      '/atlas/index/similar/movie/550.json?limit=200',
    ]);
  });

  it('draws the affinity row from atlas’s paged cards, asking TMDB only for a card with no poster', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/suggest/movie/550.json?skip=0&limit=20': {
          mixed: [
            { type: 'series', id: 1396 },
            { type: 'movie', id: 11 },
          ],
          titles: [
            { type: 'series', id: 1396, title: 'Breaking Bad', posterPath: '/bb.jpg', year: 2008 },
            { type: 'movie', id: 11, title: 'T11', posterPath: null },
          ],
          total: 2,
        },
        '/atlas/index/suggest/movie/550.json?skip=2&limit=20': { mixed: [], titles: [], total: 2 },
        '/3/movie/11': { id: 11, title: 'T11', poster_path: '/11.jpg' },
      },
      asked,
    );
    const row = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      key: 'k',
      fetchImpl,
      mixed: true,
      similarLimit: 200,
      affinity: true,
    });

    const first = await row.load(1);
    expect(first.map((t) => `${t.type}:${t.id}`)).toEqual(['tv:1396', 'movie:11']);
    expect(first[0]?.title).toBe('Breaking Bad');
    expect(asked.filter((path) => path.startsWith('/3/'))).toEqual(['/3/movie/11']);
    expect(asked).not.toContain('/atlas/index/suggest.json');
    // The row's end moves on to the wider neighbours, as any atlas source does.
    await row.load(2);
    expect(asked).toContain('/atlas/index/suggest/movie/550.json?skip=2&limit=20');
    expect(asked).toContain('/atlas/index/neighbours/movie/550.json?k=50');
  });

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

  it('mixed, is atlas’s films and series together, each drawn as its own type', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/similar/movie/550.json': {
          ids: [11],
          mixed: [
            { type: 'movie', id: 11 },
            { type: 'series', id: 11 },
            { type: 'series', id: 1396 },
          ],
        },
        ...Object.fromEntries([movie(11)]),
        '/3/tv/11': { id: 11, name: 'S11' },
        '/3/tv/1396': { id: 1396, name: 'Breaking Bad' },
      },
      asked,
    );
    const row = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      key: 'k',
      fetchImpl,
      mixed: true,
    });
    const first = await row.load(1);
    // A film and a series may share an id: each is its own title, and a series card is a series.
    expect(first.map((t) => `${t.type}:${t.id}`)).toEqual(['movie:11', 'tv:11', 'tv:1396']);
    // Without `mixed` the same answer is the seed's type alone.
    const plain = moreLikeThisRow({ title: self, more: [] }, '/atlas', { key: 'k', fetchImpl });
    expect((await plain.load(1)).map((t) => `${t.type}:${t.id}`)).toEqual(['movie:11']);
    // The detail page's "Explore similar" opens Search's All, where the mixed row is.
    expect(plain.aside?.href).toBe('/search?c=like-movie-550');
  });

  it('pages every id in atlas’s served row before consulting a fallback source', async () => {
    const asked: string[] = [];
    const served = Array.from({ length: 45 }, (_, i) => ({
      type: i % 2 === 0 ? ('movie' as const) : ('series' as const),
      id: 100 + i,
    }));
    const cards = Object.fromEntries(
      served.map((ref) =>
        ref.type === 'movie'
          ? movie(ref.id)
          : [`/3/tv/${ref.id}`, { id: ref.id, name: `S${ref.id}` }],
      ),
    );
    const fetchImpl = answering(
      {
        '/atlas/index/similar/movie/550.json?limit=200': {
          mixed: served,
          mixedTotal: served.length,
        },
        '/atlas/index/neighbours/movie/550.json?k=50': { ids: [900] },
        ...cards,
        ...Object.fromEntries([900].map(movie)),
      },
      asked,
    );
    const row = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      key: 'k',
      fetchImpl,
      mixed: true,
      similarLimit: 200,
    });

    const rendered = (await ids(row, 3)).flat();
    expect(rendered).toEqual(served.map((ref) => ref.id));
    expect(asked).not.toContain('/atlas/index/neighbours/movie/550.json?k=50');

    // Only after the endpoint's complete 45-title fixture has been rendered may the wider fallback begin.
    expect((await row.load(4)).map((title) => title.id)).toEqual([900]);
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

  it('keeps a writer’s row to what they wrote, headed by the role it was asked for', async () => {
    const fetchImpl = answering({
      '/3/person/9/combined_credits': {
        cast: acting.slice(0, 3),
        crew: [
          {
            id: 2,
            media_type: 'movie',
            title: 'Written',
            job: 'Screenplay',
            department: 'Writing',
          },
          {
            id: 3,
            media_type: 'movie',
            title: 'Directed',
            job: 'Director',
            department: 'Directing',
          },
        ],
      },
    });
    const written = personRow({ id: 9, name: 'Ana' }, 'Writing', self, { key: 'k', fetchImpl });
    expect((await written.load(1)).map((t) => t.title)).toEqual(['Written']);
    expect(written.title).toBe('Written by Ana');
    const created = personRow({ id: 9, name: 'Ana' }, 'Writing', self, { key: 'k' }, 'Created by ');
    expect(created.title).toBe('Created by Ana');
    expect(created.headingLink?.before).toBe('Created by ');
  });
});

describe('personRows', () => {
  const p = (id: number) => ({ id, name: `P${id}` });
  const plan = (d: Partial<Parameters<typeof personRows>[0]>) =>
    personRows({ directors: [], creators: [], writers: [], cast: [], ...d }).map(
      (r) => `${r.before}${r.person.name}`,
    );

  it('shows a film’s writer between its director and its leads', () => {
    expect(plan({ directors: [p(1)], writers: [p(2)], cast: [p(3), p(4)] })).toEqual([
      'More from P1',
      'Written by P2',
      'Starring P3',
      'Starring P4',
    ]);
  });

  it('gives a writer-director one row, as director', () => {
    expect(plan({ directors: [p(1)], writers: [p(1)] })).toEqual(['More from P1']);
  });

  it('falls to the next writer when the first also directed', () => {
    expect(plan({ directors: [p(1)], writers: [p(1), p(2)] })).toEqual([
      'More from P1',
      'Written by P2',
    ]);
  });

  it('gives a series with no director its creator, ahead of its writer', () => {
    expect(plan({ creators: [p(5)], writers: [p(5), p(6)], cast: [p(7)] })).toEqual([
      'Created by P5',
      'Written by P6',
      'Starring P7',
    ]);
  });

  it('gives an actor-director one row, and the next lead takes the actor slot', () => {
    expect(plan({ directors: [p(1)], cast: [p(1), p(2), p(3), p(4)] })).toEqual([
      'More from P1',
      'Starring P2',
      'Starring P3',
      'Starring P4',
    ]);
  });

  it('stops at five rows, dropping leads first', () => {
    expect(
      plan({ directors: [p(1)], creators: [p(2)], writers: [p(3)], cast: [p(4), p(5), p(6)] }),
    ).toEqual(['More from P1', 'Created by P2', 'Written by P3', 'Starring P4', 'Starring P5']);
  });

  it('makes no row for missing credits', () => {
    expect(plan({})).toEqual([]);
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

describe('franchiseRow', () => {
  it('prefers atlas’s mixed seed-era-first row over a TMDB movie collection', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/franchise/movie/550.json': {
          franchise: { id: 'fight', name: 'Fight franchise' },
          members: [
            { type: 'movie', id: 550, title: 'Fight Club' },
            { type: 'series', id: 7, title: 'Fight Club: The Series' },
            { type: 'movie', id: 8, title: 'Fight Again' },
          ],
          total: 3,
        },
      },
      asked,
    );
    const row = await franchiseRow({ id: 5, name: 'TMDB collection' }, self, '/atlas', {
      key: 'k',
      fetchImpl,
    });

    expect(row?.id).toBe('franchise-fight');
    expect(row?.title).toBe('Fight franchise');
    expect((await row!.load(1)).map((title) => `${title.type}:${title.id}`)).toEqual([
      'movie:550',
      'tv:7',
      'movie:8',
    ]);
    expect((await firstScreen(row!, (title) => title.id !== 550))?.load).toBeDefined();
    expect(asked).toEqual(['/atlas/index/franchise/movie/550.json']);
  });

  it('uses TMDB only when atlas has no curated primary', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        '/atlas/index/franchise/movie/550.json': { franchise: null, members: [] },
        '/3/collection/5': { parts: [{ id: 2, title: 'Two', release_date: '2004-01-01' }] },
      },
      asked,
    );
    const row = await franchiseRow({ id: 5, name: 'TMDB collection' }, self, '/atlas', {
      key: 'k',
      fetchImpl,
    });

    expect(row?.id).toBe('collection-5');
    expect((await row!.load(1)).map((title) => title.id)).toEqual([2]);
    expect(asked).toEqual(['/atlas/index/franchise/movie/550.json', '/3/collection/5']);
  });

  it('does not replace an authoritative empty atlas franchise with TMDB', async () => {
    const asked: string[] = [];
    const row = await franchiseRow({ id: 5, name: 'TMDB collection' }, self, '/atlas', {
      key: 'k',
      fetchImpl: answering(
        {
          '/atlas/index/franchise/movie/550.json': {
            franchise: { id: 'fight', name: 'Fight franchise' },
            members: [{ type: 'movie', id: 550, title: 'Fight Club' }],
          },
        },
        asked,
      ),
    });

    expect(await firstScreen(row!, () => true)).toBeNull();
    expect(asked).toEqual(['/atlas/index/franchise/movie/550.json']);
  });
});

describe('versionsRow', () => {
  const versionsPath = '/atlas/index/versions/movie/550.json';
  const franchiseOf = (titles: Title[]): Promise<RowDef | null> =>
    Promise.resolve({ id: 'franchise-fight', title: 'Fight', load: async () => titles });
  const none = Promise.resolve(null);
  const keys = (titles: Title[]) => titles.map((t) => `${t.type}:${t.id}`);

  it('draws atlas’s versions in the order it serves them, with a quiet caption on remakes', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      {
        [versionsPath]: {
          seed: { type: 'movie', id: 550 },
          versions: [
            {
              type: 'movie',
              id: 30,
              title: 'Remade',
              year: 1998,
              posterPath: '/r.jpg',
              kind: 'remake',
            },
            {
              type: 'series',
              id: 9,
              title: 'The Book Series',
              year: 1970,
              posterPath: '/s.jpg',
              kind: 'source',
            },
            { type: 'movie', id: 2, kind: 'source' },
          ],
          total: 3,
        },
        '/3/movie/2': { id: 2, title: 'T2' },
      },
      asked,
    );
    const row = await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl });

    expect(row?.title).toBe('Other versions');
    const titles = await row!.load(1);
    // Neither by id nor by year: atlas's order, the card-less version drawn from TMDB in its place.
    expect(keys(titles)).toEqual(['movie:30', 'tv:9', 'movie:2']);
    expect(titles.map((t) => row!.caption?.(t))).toEqual(['1998 · Remake', undefined, undefined]);
    expect(await row!.load(2)).toEqual([]);
    expect(asked).toContain('/3/movie/2');
    expect(asked).not.toContain('/3/movie/30');
  });

  it('leaves out every title the franchise row shows, and the title itself', async () => {
    const fetchImpl = answering({
      [versionsPath]: {
        versions: [
          { type: 'movie', id: 550, title: 'Fight Club', posterPath: '/f.jpg', kind: 'source' },
          { type: 'movie', id: 8, title: 'Fight Again', posterPath: '/a.jpg', kind: 'source' },
          { type: 'movie', id: 31, title: 'Other Fight', posterPath: '/o.jpg', kind: 'remake' },
        ],
      },
    });
    const row = await versionsRow(self, '/atlas', franchiseOf([named(8)]), { key: 'k', fetchImpl });

    expect(keys(await row!.load(1))).toEqual(['movie:31']);
  });

  it('is no row when the franchise row already shows every version', async () => {
    const fetchImpl = answering({
      [versionsPath]: {
        versions: [
          { type: 'movie', id: 8, title: 'Fight Again', posterPath: '/a.jpg', kind: 'source' },
        ],
      },
    });
    expect(
      await versionsRow(self, '/atlas', franchiseOf([named(8)]), { key: 'k', fetchImpl }),
    ).toBeNull();
  });

  it('is no row for a title without versions, and asks nothing more', async () => {
    const asked: string[] = [];
    const fetchImpl = answering(
      { [versionsPath]: { seed: { type: 'movie', id: 550 }, versions: [], total: 0 } },
      asked,
    );
    expect(await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl })).toBeNull();
    expect(asked).toEqual([versionsPath]);
  });

  it('is no row, and no error, from an atlas that predates the route or answers something else', async () => {
    const older = answering({});
    expect(await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl: older })).toBeNull();
    const other = answering({ [versionsPath]: { ids: [8] } });
    expect(await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl: other })).toBeNull();
    const down = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl: down })).toBeNull();
  });

  it('asks nothing without atlas', async () => {
    const asked: string[] = [];
    expect(
      await versionsRow(self, null, none, { key: 'k', fetchImpl: answering({}, asked) }),
    ).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('studioRow', () => {
  it('pages films and series from the curated studio filter and links its heading to Search', async () => {
    const asked: string[] = [];
    const row = studioRow(
      { id: 'Q174811', name: 'Studio Ghibli' },
      self,
      '/atlas',
      answering(
        {
          '/atlas/index/filter/all/titles.json?sel=studio:Q174811': {
            order: 'votes',
            titles: [
              { type: 'movie', id: 550, title: 'Fight Club' },
              { type: 'movie', id: 129, title: 'Spirited Away' },
              { type: 'series', id: 123, title: 'A Series' },
            ],
          },
          '/atlas/index/filter/all/titles.json?sel=studio:Q174811&skip=24': {
            order: 'votes',
            titles: [],
          },
        },
        asked,
      ),
    );

    expect(row.title).toBe('More from Studio Ghibli');
    expect(row.headingLink).toEqual({
      before: 'More from ',
      label: 'Studio Ghibli',
      after: '',
      href: '/search?c=studio-Q174811',
    });
    expect((await row.load(1)).map((title) => `${title.type}:${title.id}`)).toEqual([
      'movie:550',
      'movie:129',
      'tv:123',
    ]);
    expect(row.filter?.(self)).toBe(false);
    expect(row.filter?.({ type: 'tv', id: 123, title: 'A Series' })).toBe(true);
    expect(await row.load(2)).toEqual([]);
    expect(asked).toEqual([
      '/atlas/index/filter/all/titles.json?sel=studio:Q174811',
      '/metadata/title/query',
      '/atlas/index/filter/all/titles.json?sel=studio:Q174811&skip=24',
    ]);
  });
});

describe('languageRow', () => {
  it('keeps the title type, links Search, and excludes the title already open', async () => {
    const asked: string[] = [];
    const row = languageRow(
      { id: 'sv', name: 'Swedish' },
      { type: 'tv', id: 9, title: 'The Series' },
      '/atlas',
      answering(
        {
          '/atlas/index/filter/series/titles.json?sel=language:sv': {
            order: 'votes',
            titles: [
              { type: 'series', id: 9, title: 'The Series', originalLanguage: 'sv' },
              { type: 'series', id: 10, title: 'Another Series', originalLanguage: 'sv' },
              { type: 'series', id: 11, title: 'English Co-production', originalLanguage: 'en' },
            ],
          },
        },
        asked,
      ),
    );

    expect(row.title).toBe('More in Swedish');
    expect(row.headingLink).toEqual({
      before: 'More ',
      label: 'in Swedish',
      after: '',
      href: '/search?type=tv&c=lang-sv',
    });
    expect((await row.load(1)).map((title) => title.id)).toEqual([9, 10, 11]);
    expect(row.filter?.({ type: 'tv', id: 9, title: 'The Series', originalLanguage: 'sv' })).toBe(
      false,
    );
    expect(
      row.filter?.({ type: 'tv', id: 10, title: 'Another Series', originalLanguage: 'sv' }),
    ).toBe(true);
    expect(
      row.filter?.({ type: 'tv', id: 11, title: 'English Co-production', originalLanguage: 'en' }),
    ).toBe(false);
    expect(asked).toEqual([
      '/atlas/index/filter/series/titles.json?sel=language:sv',
      '/metadata/title/query',
    ]);
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
