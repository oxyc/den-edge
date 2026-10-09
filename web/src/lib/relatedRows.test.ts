import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import type { RowDef } from './catalog';
import {
  authorRow,
  collectionRow as collectionRowImpl,
  countryRow,
  firstScreen,
  franchiseRow as franchiseRowImpl,
  homeCountry,
  languageRow,
  moodRow,
  moreLikeThisRow as moreLikeThisRowImpl,
  personRow as personRowImpl,
  personRows,
  producerRows,
  studioRow,
  themeRows,
  versionsRow as versionsRowImpl,
  withPosters as withPostersImpl,
  type RelatedOptions,
} from './relatedRows';
import { NO_FACTS } from './titleFacts';
import { ContentAuthority } from './contentAuthority';
import type { ContentServiceClientPort } from './libraryServiceFactory';

const self: Title = { type: 'movie', id: 550, title: 'Fight Club' };
const named = (id: number): Title => ({ type: 'movie', id, title: `T${id}` });

const fixtureContentPort = (
  key = '',
  fetchImpl: typeof fetch = fetch,
): ContentServiceClientPort => {
  const authority = new ContentAuthority(
    {
      tmdb: () => key,
      omdb: () => undefined,
      contentWarnings: () => undefined,
      atlas: () => undefined,
    },
    { tmdbFetch: fetchImpl, providerFetch: fetchImpl },
  );
  return {
    query: (request, signal) =>
      authority.query(request, signal ?? new AbortController().signal) as never,
    onStatus: () => () => {},
  };
};

type FixtureOptions = Omit<RelatedOptions, 'content'> & { key?: string };

const fixtureOptions = (value: FixtureOptions = {}): RelatedOptions => {
  const { key, ...options } = value;
  return { ...options, content: fixtureContentPort(key, options.fetchImpl) };
};

const moreLikeThisRow = (
  detail: Parameters<typeof moreLikeThisRowImpl>[0],
  atlas: Parameters<typeof moreLikeThisRowImpl>[1],
  options: FixtureOptions,
) => moreLikeThisRowImpl(detail, atlas, fixtureOptions(options));
const collectionRow = (
  collection: Parameters<typeof collectionRowImpl>[0],
  title: Parameters<typeof collectionRowImpl>[1],
  options: FixtureOptions,
) => collectionRowImpl(collection, title, fixtureOptions(options));
const franchiseRow = (
  collection: Parameters<typeof franchiseRowImpl>[0],
  title: Parameters<typeof franchiseRowImpl>[1],
  atlas: Parameters<typeof franchiseRowImpl>[2],
  options: FixtureOptions,
) => franchiseRowImpl(collection, title, atlas, fixtureOptions(options));
const versionsRow = (
  title: Parameters<typeof versionsRowImpl>[0],
  atlas: Parameters<typeof versionsRowImpl>[1],
  franchise: Parameters<typeof versionsRowImpl>[2],
  options: FixtureOptions,
) => versionsRowImpl(title, atlas, franchise, fixtureOptions(options));
const personRow = (
  person: Parameters<typeof personRowImpl>[0],
  department: Parameters<typeof personRowImpl>[1],
  title: Parameters<typeof personRowImpl>[2],
  options: FixtureOptions,
  before?: Parameters<typeof personRowImpl>[4],
) => personRowImpl(person, department, title, fixtureOptions(options), before);
const withPosters = (row: RowDef, options: FixtureOptions) =>
  withPostersImpl(row, fixtureOptions(options));

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
    // Its "Explore" opens Search with this title's "Fans of", under All.
    expect(row.aside).toEqual({ label: 'Explore', href: '/search?c=fans-movie-550' });
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

  it('offers a title once across rows that share what they have offered', async () => {
    const fetchImpl = answering({
      '/atlas/index/similar/movie/550.json?limit=200': {
        mixed: [
          { type: 'movie', id: 11 },
          { type: 'movie', id: 12 },
        ],
      },
      '/atlas/index/suggest/movie/550.json?skip=0&limit=20': {
        mixed: [
          { type: 'movie', id: 12 },
          { type: 'movie', id: 13 },
        ],
        titles: [12, 13].map((id) => ({
          type: 'movie',
          id,
          title: `T${id}`,
          posterPath: '/p.jpg',
        })),
      },
      ...Object.fromEntries([11, 12].map(movie)),
    });
    const seen = new Set<string>();
    const options = { key: 'k', fetchImpl, mixed: true, similarLimit: 200, seen };
    const similar = moreLikeThisRow({ title: self, more: [] }, '/atlas', options);
    const suggested = moreLikeThisRow({ title: self, more: [] }, '/atlas', {
      ...options,
      affinity: true,
    });

    expect(similar.id).not.toBe(suggested.id);
    expect((await similar.load(1)).map((t) => t.id)).toEqual([11, 12]);
    expect((await suggested.load(1)).map((t) => t.id)).toEqual([13]);
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
            { type: 'movie', id: 550, title: 'Fight Club', posterPath: '/f.jpg' },
            { type: 'series', id: 7, title: 'Fight Club: The Series', posterPath: '/s.jpg' },
            { type: 'movie', id: 8, title: 'Fight Again', posterPath: '/a.jpg' },
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
      'tv:7',
      'movie:8',
    ]);
    expect((await firstScreen(row!, (title) => title.id !== 550))?.load).toBeDefined();
    // Cards with posters are drawn as they are: nothing else is asked.
    expect(asked.filter((path) => path !== '/metadata/title/query')).toEqual([
      '/atlas/index/franchise/movie/550.json',
    ]);
  });

  it('draws poster-less members, in atlas’s era order, so the row is not hidden as blank', async () => {
    const asked: string[] = [];
    const table = answering(
      {
        '/atlas/index/franchise/movie/557.json': {
          franchise: { id: 'Q2307877', name: 'Spider-Man in film' },
          // Seed era first, then the other eras; neither id nor year order.
          members: [
            { type: 'movie', id: 557, title: 'Spider-Man', year: 2002, posterPath: null },
            { type: 'movie', id: 558, title: 'Spider-Man 2', year: 2004, posterPath: null },
            { type: 'movie', id: 225914, title: 'Spider-Man', year: 1977, posterPath: null },
            { type: 'movie', id: 1930, title: 'The Amazing', year: 2012, posterPath: null },
          ],
        },
        '/3/movie/558': { id: 558, title: 'Spider-Man 2', poster_path: '/p558.jpg' },
        '/3/movie/225914': { id: 225914, title: 'Spider-Man', poster_path: '/p225914.jpg' },
        '/3/movie/1930': { id: 1930, title: 'The Amazing', poster_path: '/p1930.jpg' },
      },
      asked,
    );
    const seed: Title = { type: 'movie', id: 557, title: 'Spider-Man' };
    const row = await franchiseRow(undefined, seed, '/atlas', { key: 'k', fetchImpl: table });
    const withPoster = (t: Title) => Boolean(t.posterPath);

    const shown = await firstScreen(row!, withPoster);
    expect(shown).not.toBeNull();
    const titles = await shown!.load(1);
    expect(titles.map((t) => t.id)).toEqual([558, 225914, 1930]);
    expect(titles.every(withPoster)).toBe(true);
    // The Worker normalizes every poster-less atlas card in one typed batch.
    expect(asked.filter((path) => path.startsWith('/3/'))).toEqual([
      '/3/movie/558',
      '/3/movie/225914',
      '/3/movie/1930',
    ]);
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

  it('captions a franchise’s members with its label, in atlas’s order', async () => {
    const group = { id: 'Q1784319', name: 'Wallander', label: 'Wallander (Sweden)', era: null };
    const fetchImpl = answering({
      [versionsPath]: {
        versions: [
          {
            type: 'movie',
            id: 40,
            title: 'Mastermind',
            year: 2005,
            posterPath: '/m.jpg',
            kind: 'remake',
            group,
          },
          {
            type: 'series',
            id: 41,
            title: 'Wallander',
            year: 2007,
            posterPath: '/w.jpg',
            kind: 'source',
            group,
          },
          {
            type: 'series',
            id: 42,
            title: 'Young Wallander',
            year: 2020,
            posterPath: '/y.jpg',
            kind: 'source',
          },
        ],
      },
    });
    const row = await versionsRow(self, '/atlas', none, { key: 'k', fetchImpl });
    const titles = await row!.load(1);

    expect(keys(titles)).toEqual(['movie:40', 'tv:41', 'tv:42']);
    expect(titles.map((t) => row!.caption?.(t))).toEqual([
      '2005 · Wallander (Sweden)',
      '2007 · Wallander (Sweden)',
      undefined,
    ]);
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

describe('withPosters', () => {
  it('asks TMDB only for the cards that came without a poster', async () => {
    const asked: string[] = [];
    const row = withPosters(
      {
        id: 'r',
        title: 'R',
        load: async () => [
          { type: 'movie', id: 1, title: 'Has one', posterPath: '/one.jpg' },
          { type: 'movie', id: 2, title: 'Needs one' },
          { type: 'movie', id: 3, title: 'TMDB has none either' },
        ],
      },
      {
        key: '',
        fetchImpl: answering(
          { '/3/movie/2': { id: 2, title: 'Needs one', poster_path: '/two.jpg' } },
          asked,
        ),
      },
    );
    expect((await row.load(1)).map((title) => title.posterPath)).toEqual([
      '/one.jpg',
      '/two.jpg',
      undefined,
    ]);
    expect(asked).toEqual(['/3/movie/2', '/3/movie/3']);
  });
});

describe('homeCountry', () => {
  it('picks the first country where the language is at home, and none where it is not', () => {
    // The Bridge: Wikidata names the German co-producer first.
    expect(homeCountry('sv', ['DE', 'DK', 'SE'])).toBe('SE');
    // Pan's Labyrinth: atlas's Spain before TMDB's Mexico.
    expect(homeCountry('es', ['ES', 'MX'])).toBe('ES');
    expect(homeCountry('es', ['US'])).toBeUndefined();
    expect(homeCountry('xx', ['FR'])).toBeUndefined();
  });
});

describe('countryRow', () => {
  it('asks for the country in its language, films and series together, and keeps only that original language', async () => {
    const asked: string[] = [];
    const spain = {
      type: 'movie',
      id: 1417,
      title: "Pan's Labyrinth",
      originalLanguage: 'es',
    } as const;
    const row = countryRow(
      { id: 'ES', name: 'Spain' },
      'es',
      spain,
      '/atlas',
      answering(
        {
          '/atlas/index/filter/all/titles.json?sel=country:ES,language:es': {
            order: 'votes',
            titles: [
              { type: 'series', id: 71446, title: 'Money Heist', originalLanguage: 'es' },
              { type: 'movie', id: 121856, title: "Assassin's Creed", originalLanguage: 'en' },
            ],
          },
        },
        asked,
      ),
    );

    expect(row.title).toBe('More from Spain');
    expect(row.headingLink?.href).toBe('/search?c=country-ES,lang-es');
    const loaded = await row.load(1);
    expect(loaded.filter((title) => row.filter?.(title)).map((title) => title.title)).toEqual([
      'Money Heist',
    ]);
    expect(row.filter?.(spain)).toBe(false);
    expect(countryRow({ id: 'NL', name: 'Netherlands' }, 'nl', spain, '/atlas').title).toBe(
      'More from the Netherlands',
    );
  });
});

describe('producerRows', () => {
  const series: Title = { type: 'tv', id: 1405, title: 'Dexter' };
  const value = (id: string, name: string, titles: number) => ({ id, name, titles });

  it('gives the network, then the largest company, each only at a size that says something', () => {
    const rows = producerRows(
      {
        ...NO_FACTS,
        networks: [value('Q1', 'Tiny', 3), value('Q23589', 'Showtime', 59)],
        companies: [
          value('Q2', 'Warner Bros.', 2400),
          value('Q3', 'Small Films', 12),
          value('Q4', 'Bigger Films', 80),
        ],
      },
      [],
      series,
      '/atlas',
    );
    expect(rows.map((row) => [row.id, row.title, row.headingLink?.href])).toEqual([
      ['network-Q23589', 'More from Showtime', '/search?c=network-Q23589'],
      ['company-Q4', 'More from Bigger Films', '/search?c=company-Q4'],
    ]);
  });

  it('leaves out what a curated studio row or the network already shows', () => {
    const rows = producerRows(
      {
        ...NO_FACTS,
        networks: [value('Q23633', 'HBO', 155)],
        companies: [value('Q23633', 'HBO', 73), value('Q9', 'Showtime', 20)],
      },
      [{ id: 'Q23633', name: 'HBO' }],
      series,
      '/atlas',
    );
    expect(rows.map((row) => row.id)).toEqual(['company-Q9']);
    expect(
      producerRows(
        { ...NO_FACTS, networks: [value('Q23589', 'Showtime', 59)] },
        [],
        series,
        '/atlas',
      ).length,
    ).toBe(1);
    expect(
      producerRows(
        {
          ...NO_FACTS,
          networks: [value('Q23589', 'Showtime', 59)],
          companies: [value('Q7503313', 'Showtime', 10)],
        },
        [],
        series,
        '/atlas',
      ).map((row) => row.id),
    ).toEqual(['network-Q23589']);
  });
});

describe('themeRows', () => {
  const value = (id: string, name: string, titles: number) => ({ id, name, titles });

  it('gives the first subject and place the right size to say something, and no place the country row names', () => {
    const rows = themeRows(
      {
        ...NO_FACTS,
        subjects: [value('Q1', 'messiah', 1), value('Q124734', 'rebellion', 14)],
        places: [
          value('Q884', 'South Korea', 77),
          value('Q60', 'New York City', 1857),
          value('Q5092', 'Baltimore', 42),
        ],
      },
      self,
      '/atlas',
      'South Korea',
    );
    expect(rows.map((row) => [row.id, row.title, row.headingLink?.href])).toEqual([
      ['subject-Q124734', 'More about rebellion', '/search?c=subject-Q124734'],
      ['place-Q5092', 'Set in Baltimore', '/search?c=place-Q5092'],
    ]);
    expect(rows[0]?.filter?.(self)).toBe(false);
    expect(themeRows(NO_FACTS, self, '/atlas')).toEqual([]);
  });
});

describe('authorRow', () => {
  it("asks for every other adaptation of the author's work, and needs only one", async () => {
    const row = authorRow(
      { ...NO_FACTS, authors: [{ id: 'Q7934', name: 'Frank Herbert', titles: 5 }] },
      self,
      '/atlas',
      answering({
        '/atlas/index/filter/all/titles.json?sel=author:Q7934': {
          order: 'votes',
          titles: [
            { type: 'movie', id: 438631, title: 'Dune' },
            { type: 'movie', id: 550, title: 'Fight Club' },
            { type: 'movie', id: 841, title: 'Dune' },
          ],
        },
      }),
    );
    expect(row?.title).toBe('More adapted from Frank Herbert');
    expect(row?.headingLink).toMatchObject({ label: 'Frank Herbert' });
    expect(row?.headingLink?.href).toContain('author-Q7934');
    const loaded = await row!.load(1);
    expect(loaded.filter((title) => row!.filter?.(title)).map((title) => title.id)).toEqual([
      438631, 841,
    ]);
    const twice = { ...NO_FACTS, authors: [{ id: 'Q1', name: 'Twice', titles: 2 }] };
    expect(authorRow(twice, self, '/atlas')?.id).toBe('author-Q1');
    const once = { ...NO_FACTS, authors: [{ id: 'Q2', name: 'Once', titles: 1 }] };
    expect(authorRow(once, self, '/atlas')).toBeNull();
  });
});

describe('moodRow', () => {
  const wire: Title = { type: 'tv', id: 1438, title: 'The Wire' };

  it('names the strongest feeling, waits for More like this, and never repeats what it showed', async () => {
    const asked: string[] = [];
    let release = () => {};
    const after = new Promise<void>((resolve) => (release = resolve));
    const seen = new Set(['tv:125949']);
    const row = moodRow(['Bingeable', 'Dark & Gritty'], wire, '/atlas', {
      seen,
      after,
      fetchImpl: answering(
        {
          '/atlas/index/filter/all/titles.json?sel=like:series-1438,mood:Dark%20%26%20Gritty': {
            order: 'like:series-1438',
            titles: [{ type: 'series', id: 125949, title: 'We Own This City' }],
          },
          '/atlas/index/filter/all/titles.json?sel=like:series-1438,mood:Dark%20%26%20Gritty&skip=24':
            {
              order: 'like:series-1438',
              titles: [{ type: 'series', id: 14531, title: 'The Corner' }],
            },
        },
        asked,
      ),
    });

    expect(row?.title).toBe('More dark and gritty like this');
    const loading = row!.load(1);
    await Promise.resolve();
    expect(asked).toEqual([]);
    release();
    // Its first page was all shown above, so the row reads on rather than ending.
    expect((await loading).map((title) => title.title)).toEqual(['The Corner']);
    expect(seen.has('tv:14531')).toBe(true);
  });

  it('is no row for a title whose moods say only how it is watched', () => {
    const none = { seen: new Set<string>(), after: Promise.resolve() };
    expect(moodRow(['Bingeable', 'Twist-ending'], wire, '/atlas', none)).toBeNull();
    expect(moodRow([], wire, '/atlas', none)).toBeNull();
    expect(moodRow(['Tense/Edge-of-seat'], wire, '/atlas', none)?.title).toBe(
      'More tense like this',
    );
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
