import { afterEach, describe, expect, it, vi } from 'vitest';
// A copy of den-atlas's tests/fixtures/facets-canonical.json (den-atlas 4cd3e09): both ends hold to the same pairs.
import fixture from './facets-canonical.json';
import {
  canonicalFilterPath,
  fetchFilterCounts,
  fetchPeopleCounts,
  filterPeople,
  filterTitles,
  FilterUnavailable,
  filterUrl,
  likeValue,
  mergeFilterValues,
  searchFilterValues,
  searchTraitValues,
} from './filterRoutes';

describe('canonical filter addresses', () => {
  it.each(fixture.cases)('spells $url as atlas does', ({ url, canonical }) => {
    expect(canonicalFilterPath(url)).toBe(canonical);
  });

  it.each(fixture.refused)('asks nothing atlas refuses: %s', (url) => {
    expect(canonicalFilterPath(url)).toBeUndefined();
  });

  it('builds the canonical address from items in any order', () => {
    expect(
      filterUrl('/atlas', 'tv', 'titles', {
        items: [
          { kind: 'genre', id: '18' },
          { kind: 'country', id: 'kr' },
          { kind: 'language', id: 'KO' },
        ],
        skip: 48,
      }),
    ).toBe('/atlas/index/filter/series/titles.json?sel=country:KR,genre:18,language:ko&skip=48');
    expect(
      filterUrl('/atlas', 'movie', 'titles', {
        items: [
          { kind: 'region', id: 'Nordic' },
          { kind: 'genre', id: '28' },
        ],
      }),
    ).toBe('/atlas/index/filter/movie/titles.json?sel=genre:28,region:nordic');
  });

  it('asks for films and series together at `all`, a "Like" there by its typed id', () => {
    expect(likeValue({ type: 'tv', id: 1396 }, 'all')).toBe('series-1396');
    expect(likeValue({ type: 'movie', id: 550 }, 'all')).toBe('movie-550');
    expect(likeValue({ type: 'tv', id: 1396 }, 'tv')).toBe('1396');
    expect(
      filterUrl('/atlas', 'all', 'titles', {
        items: [
          { kind: 'like', id: likeValue({ type: 'tv', id: 1396 }, 'all') },
          { kind: 'genre', id: '35' },
        ],
        skip: 24,
      }),
    ).toBe('/atlas/index/filter/all/titles.json?sel=genre:35,like:series-1396&skip=24');
    // The same builder reads an `all` address back, as it reads either type's.
    expect(
      canonicalFilterPath('/index/filter/all/counts.json?sel=like:SERIES-01396,genre:35'),
    ).toBe('/index/filter/all/counts.json?sel=genre:35,like:series-1396');
    expect(canonicalFilterPath('/index/filter/all/values/person.json?q=Nolan')).toBe(
      '/index/filter/all/values/person.json?q=nolan',
    );
    expect(canonicalFilterPath('/index/filter/all/counts.json?sel=like:person-1')).toBeUndefined();
    expect(canonicalFilterPath('/index/filter/both/counts.json')).toBeUndefined();
  });

  it('asks the people routes with the traits after the selection, then the order, then the page', () => {
    expect(
      filterUrl('/atlas', 'tv', 'people', {
        items: [{ kind: 'genre', id: '18' }],
        traits: [
          { kind: 'role', id: 'Director' },
          { kind: 'citizenship', id: 'q34' },
        ],
        order: 'Born_Desc',
        skip: 48,
      }),
    ).toBe(
      '/atlas/index/filter/series/people.json?sel=genre:18&traits=citizenship:Q34,role:director&order=born_desc&skip=48',
    );
    // The default order, and a counts route, say nothing of it.
    expect(filterUrl('/atlas', 'all', 'people', { order: 'prominence' })).toBe(
      '/atlas/index/filter/all/people.json',
    );
    expect(
      filterUrl('/atlas', 'movie', 'peopleCounts', {
        traits: [{ kind: 'born', id: '1974' }],
        order: 'name',
        skip: 24,
      }),
    ).toBe('/atlas/index/filter/movie/people/counts.json?traits=born:1970');
    expect(filterUrl('/atlas', 'all', { peopleValues: 'occupation' }, { q: 'Film Dir' })).toBe(
      '/atlas/index/filter/all/people/values/occupation.json?q=film%20dir',
    );
    // Traits mean nothing to a title route; a trait atlas can't read is refused.
    expect(filterUrl('/atlas', 'movie', 'titles', { traits: [{ kind: 'role', id: 'cast' }] })).toBe(
      '/atlas/index/filter/movie/titles.json',
    );
    expect(
      filterUrl('/atlas', 'movie', 'people', { traits: [{ kind: 'gender', id: 'male' }] }),
    ).toBeUndefined();
    expect(filterUrl('/atlas', 'movie', 'people', { order: 'popularity' })).toBeUndefined();
    expect(canonicalFilterPath('/index/filter/movie/people/values/role.json')).toBeUndefined();
  });
});

describe('merging values from more than one answer', () => {
  it('lists a value once, its counts added, most titles first', () => {
    expect(
      mergeFilterValues([
        [
          { id: 'Q1', name: 'Ann', count: 2 },
          { id: 'Q2', name: 'Bob', count: 3 },
        ],
        null,
        [{ id: 'Q1', name: 'Ann', count: 4 }],
      ]),
    ).toEqual([
      { id: 'Q1', name: 'Ann', count: 6 },
      { id: 'Q2', name: 'Bob', count: 3 },
    ]);
  });
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('saying why nothing came back', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failure, a bad body or an unexpected status, with the address; a 404 or a cancel stays quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const status = (code: number) => (async () => answer({}, code)) as unknown as typeof fetch;
    await fetchFilterCounts('/atlas', 'movie', [], { fetchImpl: status(404) });
    await fetchFilterCounts('/atlas', 'movie', [], {
      fetchImpl: (async () => {
        throw new DOMException('replaced', 'AbortError');
      }) as unknown as typeof fetch,
    });
    expect(warn).not.toHaveBeenCalled();

    await fetchFilterCounts('/atlas', 'movie', [], { fetchImpl: status(500) });
    expect(warn).toHaveBeenLastCalledWith(
      'atlas filter:',
      'answered 500',
      '/atlas/index/filter/movie/counts.json',
    );
    await searchFilterValues('/atlas', 'movie', 'person', 'nolan', [], {
      fetchImpl: (async () => new Response('not json')) as unknown as typeof fetch,
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[2]).toBe('/atlas/index/filter/movie/values/person.json?q=nolan');
  });
});

describe('fetching', () => {
  it('reads the counts, and has none where atlas has no such route', async () => {
    const counts = await fetchFilterCounts('/atlas', 'movie', [{ kind: 'genre', id: '28' }], {
      fetchImpl: async () =>
        answer({
          total: 3,
          kinds: { genre: { mode: 'and', complete: true, values: { '28': 3 } } },
          ignored: [],
        }),
    });
    expect(counts?.kinds.genre?.values).toEqual({ '28': 3 });
    expect(
      await fetchFilterCounts('/atlas', 'movie', [], { fetchImpl: async () => answer({}, 404) }),
    ).toBeNull();
  });

  it('pages titles by skip, starting again when atlas’s order changes', async () => {
    const asked: string[] = [];
    let order = 'a';
    const load = filterTitles('/atlas', 'movie', [{ kind: 'genre', id: '28' }], {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/metadata')) return answer({ titles: [] });
        asked.push(url);
        const skip = Number(new URL(url, 'https://x').searchParams.get('skip') ?? 0);
        return answer({
          titles: [
            { type: 'movie', id: skip + 1, title: 'A', posterPath: '/a.jpg' },
            { type: 'movie', id: 1, title: 'First', posterPath: '/a.jpg' },
          ],
          order,
          ignored: [],
        });
      }) as typeof fetch,
    });
    expect((await load(1)).map((t) => t.id)).toEqual([1]);
    expect((await load(2)).map((t) => t.id)).toEqual([25]);
    order = 'b';
    // A new order: from the top again, reading past what was already given rather than ending the row.
    expect((await load(3)).map((t) => t.id)).toEqual([49]);
    expect(asked).toEqual([
      '/atlas/index/filter/movie/titles.json?sel=genre:28',
      '/atlas/index/filter/movie/titles.json?sel=genre:28&skip=24',
      '/atlas/index/filter/movie/titles.json?sel=genre:28&skip=48',
      '/atlas/index/filter/movie/titles.json?sel=genre:28',
      '/atlas/index/filter/movie/titles.json?sel=genre:28&skip=24',
      '/atlas/index/filter/movie/titles.json?sel=genre:28&skip=48',
    ]);
  });

  it('gives way where atlas has no route, or left a picked kind out', async () => {
    const missing = filterTitles('/atlas', 'movie', [], {
      fetchImpl: async () => answer({}, 404),
    });
    await expect(missing(1)).rejects.toBeInstanceOf(FilterUnavailable);
    const ignored = filterTitles('/atlas', 'movie', [{ kind: 'rating', id: '7' }], {
      fetchImpl: async () =>
        answer({ titles: [], ignored: ['rating'], kindsUnavailable: ['rating'] }),
    });
    await expect(ignored(1)).rejects.toBeInstanceOf(FilterUnavailable);
    // atlas reads the kind but has no such value: an empty answer that says nothing about the selection.
    const unknown = filterTitles('/atlas', 'tv', [{ kind: 'primary', id: 'Action & Adventure' }], {
      fetchImpl: async () =>
        answer({
          titles: [],
          ignored: [],
          unknownValues: ['primary:Action%20%26%20Adventure'],
        }),
    });
    await expect(unknown(1)).rejects.toBeInstanceOf(FilterUnavailable);
  });

  it('starts a page asked out of turn at its own skip, as a rebuilt row asks it', async () => {
    const asked: string[] = [];
    const load = filterTitles('/atlas', 'movie', [{ kind: 'decade', id: '1990' }], {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/metadata')) return answer({ titles: [] });
        asked.push(url);
        const skip = Number(new URL(url, 'https://x').searchParams.get('skip') ?? 0);
        return answer({
          titles: [{ type: 'movie', id: skip + 1, title: 'A', posterPath: '/a.jpg' }],
          order: 'a',
          ignored: [],
        });
      }) as typeof fetch,
    });
    expect((await load(3)).map((t) => t.id)).toEqual([49]);
    expect((await load(4)).map((t) => t.id)).toEqual([73]);
    expect(asked).toEqual([
      '/atlas/index/filter/movie/titles.json?sel=decade:1990&skip=48',
      '/atlas/index/filter/movie/titles.json?sel=decade:1990&skip=72',
    ]);
  });

  it('pages people by skip, with the titles they are known for and nothing TMDB scores', async () => {
    const asked: string[] = [];
    const load = filterPeople(
      '/atlas',
      'all',
      [{ kind: 'genre', id: '27' }],
      [{ kind: 'role', id: 'director' }],
      'credits',
      {
        fetchImpl: (async (input: RequestInfo | URL) => {
          asked.push(String(input));
          return answer({
            people: [
              {
                id: 'Q1',
                name: 'Ann',
                tmdbId: 7,
                credits: 3,
                roles: ['director'],
                knownFor: [
                  { type: 'series', id: 5, title: 'A Show', year: 2020 },
                  { type: 'movie', id: 6, title: 'A Film' },
                ],
              },
              { id: 'Q2', name: 'Bob' },
            ],
            total: 50,
            order: 'credits',
            ignored: [],
          });
        }) as typeof fetch,
      },
    );
    expect(await load(1)).toEqual({
      people: [
        {
          id: 'Q1',
          name: 'Ann',
          tmdbId: 7,
          knownFor: [
            { type: 'tv', id: 5, title: 'A Show', year: 2020 },
            { type: 'movie', id: 6, title: 'A Film' },
          ],
        },
        { id: 'Q2', name: 'Bob', knownFor: [] },
      ],
      total: 50,
    });
    await load(2);
    expect(asked).toEqual([
      '/atlas/index/filter/all/people.json?sel=genre:27&traits=role:director&order=credits',
      '/atlas/index/filter/all/people.json?sel=genre:27&traits=role:director&order=credits&skip=24',
    ]);
  });

  it('gives way where atlas has no people route, or left a picked trait out', async () => {
    const missing = filterPeople('/atlas', 'movie', [], [], undefined, {
      fetchImpl: async () => answer({}, 404),
    });
    await expect(missing(1)).rejects.toBeInstanceOf(FilterUnavailable);
    const ignored = filterPeople(
      '/atlas',
      'movie',
      [],
      [{ kind: 'gender', id: 'Q6581072' }],
      undefined,
      {
        fetchImpl: async () =>
          answer({
            people: [],
            total: 0,
            ignoredTraits: ['gender'],
            traitsUnavailable: ['gender'],
          }),
      },
    );
    await expect(ignored(1)).rejects.toBeInstanceOf(FilterUnavailable);
    const unknown = filterPeople('/atlas', 'movie', [], [{ kind: 'role', id: 'grip' }], undefined, {
      fetchImpl: async () => answer({ people: [], total: 0, unknownTraits: ['role:grip'] }),
    });
    await expect(unknown(1)).rejects.toBeInstanceOf(FilterUnavailable);
  });

  it('reads the traits’ counts, and finds a trait’s values by name', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      return url.includes('/values/')
        ? answer({ values: [{ id: 'Q189', name: 'Iceland', count: 4 }] })
        : answer({
            total: 5,
            traits: { role: { mode: 'and', complete: true, values: { cast: 5 } } },
          });
    }) as typeof fetch;
    const counts = await fetchPeopleCounts('/atlas', 'movie', [], [{ kind: 'role', id: 'cast' }], {
      fetchImpl,
    });
    expect(counts).toEqual({
      total: 5,
      traits: { role: { mode: 'and', complete: true, values: { cast: 5 } } },
    });
    expect(
      await searchTraitValues('/atlas', 'movie', 'citizenship', 'Ice', [], [], { fetchImpl }),
    ).toEqual([{ id: 'Q189', name: 'Iceland', count: 4 }]);
    expect(asked).toEqual([
      '/atlas/index/filter/movie/people/counts.json?traits=role:cast',
      '/atlas/index/filter/movie/people/values/citizenship.json?q=ice',
    ]);
    expect(
      await fetchPeopleCounts('/atlas', 'movie', [], [], {
        fetchImpl: async () => answer({}, 404),
      }),
    ).toBeNull();
  });

  it('finds people by a typed prefix, and asks nothing for too short a one', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return answer({ values: [{ id: 'Q25191', name: 'Christopher Nolan', count: 12 }] });
    }) as typeof fetch;
    expect(
      await searchFilterValues('/atlas', 'movie', 'person', 'Nolan', [], { fetchImpl }),
    ).toEqual([{ id: 'Q25191', name: 'Christopher Nolan', count: 12 }]);
    expect(asked).toEqual(['/atlas/index/filter/movie/values/person.json?q=nolan']);
    expect(await searchFilterValues('/atlas', 'movie', 'person', 'n', [], { fetchImpl })).toEqual(
      [],
    );
    expect(asked).toHaveLength(1);
    // No such route is no answer, not an empty one: the caller may ask elsewhere.
    expect(
      await searchFilterValues('/atlas', 'all', 'person', 'nolan', [], {
        fetchImpl: async () => answer({}, 404),
      }),
    ).toBeNull();
  });
});
