import { describe, expect, it } from 'vitest';
// A copy of den-atlas's tests/fixtures/facets-canonical.json (den-atlas 494c74b): both ends hold to the same pairs.
import fixture from './facets-canonical.json';
import {
  canonicalFilterPath,
  fetchFilterCounts,
  filterTitles,
  FilterUnavailable,
  filterUrl,
  searchFilterValues,
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
  });
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
  });
});
