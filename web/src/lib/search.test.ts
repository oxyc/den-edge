import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { foldedTitle, hitKey, normalizeQuery, pluralVariant, searchStream, type Hit, type SearchSources } from './search';
import { searchSources } from './searchSources';

// The TV's DiscoverySearchFusionTests, over the same stub answers: TMDB's multi search knows The Matrix and its
// sequel, and Brad Pitt.
const movie = (id: number, title: string, rating?: number): Title => ({ type: 'movie', id, title, rating });
const matrix = movie(603, 'The Matrix');
const reloaded = movie(604, 'The Matrix Reloaded');
const pitt: Hit = { kind: 'person', person: { id: 287, name: 'Brad Pitt' } };
const catalog: Record<string, Title> = {
  'movie-603': matrix,
  'movie-604': reloaded,
  'movie-605': movie(605, 'The Matrix Revolutions'),
  'movie-157336': movie(157336, 'Interstellar'),
  'movie-550': movie(550, 'Fight Club'),
  'movie-807': movie(807, 'Se7en'),
  'tv-1': { type: 'tv', id: 1, title: 'La casa de papel' },
  'tv-2': { type: 'tv', id: 2, title: 'Élite' },
};

function sources(overrides: Partial<SearchSources> = {}): SearchSources {
  return {
    async multi(query) {
      if (query.toLowerCase().includes('pitt')) return [pitt];
      return [matrix, reloaded].map((title) => ({ kind: 'title' as const, title }));
    },
    titles: async () => [],
    byYear: async () => [],
    notableFilms: async (id) => (id === 287 ? [catalog['movie-550']!, catalog['movie-807']!] : []),
    semantic: async () => [],
    facets: async () => ({ facet: null, titles: [] }),
    similar: async () => [],
    title: async (ref) => catalog[`${ref.type}-${ref.id}`] ?? null,
    ...overrides,
  };
}

async function final(query: string, s: SearchSources): Promise<string[]> {
  let last: Hit[] = [];
  for await (const batch of searchStream(query, s)) last = batch;
  return last.map(hitKey);
}

describe('query hygiene', () => {
  it('takes a trailing (year) out of the text, and leaves a year that is part of the title', () => {
    expect(normalizeQuery('Dune (2021)')).toEqual({ text: 'Dune', year: 2021 });
    expect(normalizeQuery('Fargo (1996)  ')).toEqual({ text: 'Fargo', year: 1996 });
    expect(normalizeQuery('Blade Runner 2049')).toEqual({ text: 'Blade Runner 2049' });
    expect(normalizeQuery('2001: A Space Odyssey')).toEqual({ text: '2001: A Space Odyssey' });
    expect(normalizeQuery('Thing (1234)')).toEqual({ text: 'Thing' });
  });

  it('toggles the last word’s plural, and folds titles the way the TV compares them', () => {
    expect([pluralVariant('the avenger'), pluralVariant('heists'), pluralVariant('up')]).toEqual([
      'the avengers',
      'heist',
      undefined,
    ]);
    expect(foldedTitle('  The Matrix')).toBe('matrix');
    expect(foldedTitle('Amélie')).toBe('amelie');
  });
});

describe('the title index', () => {
  it('reads both of atlas’s catalogs, interleaved, a series as tv', async () => {
    const fetchImpl = (async (input: string) => {
      const url = String(input);
      const metas = url.startsWith('/atlas/catalog/movie/den-titles/search=blade%20runer.json')
        ? [{ moviedb_id: 78, type: 'movie' }, { moviedb_id: 335984, type: 'movie' }]
        : url.startsWith('/atlas/catalog/series/den-titles/')
          ? [{ moviedb_id: 84553, type: 'series' }]
          : [];
      return new Response(JSON.stringify({ metas }), { status: 200 });
    }) as typeof fetch;
    expect(await searchSources('key', fetchImpl).titles('blade runer')).toEqual([
      { type: 'movie', id: 78 },
      { type: 'tv', id: 84553 },
      { type: 'movie', id: 335984 },
    ]);
  });
});

describe('searchStream, as the TV fuses it', () => {
  it('paints TMDB first, then appends the semantic tail deduped', async () => {
    const s = sources({ semantic: async () => [{ type: 'movie', id: 157336 }, { type: 'movie', id: 604 }] });
    const batches: string[][] = [];
    for await (const batch of searchStream('mind-bending space travel', s)) batches.push(batch.map(hitKey));
    expect(batches[0]).toEqual(['movie-603', 'movie-604']);
    expect(batches[1]).toEqual(['movie-603', 'movie-604', 'movie-157336']);
  });

  it('leads with the exact title, then the titles most like it', async () => {
    const s = sources({
      multi: async () => [reloaded, matrix].map((title) => ({ kind: 'title' as const, title })),
      similar: async (ref) => (ref.id === 603 ? [{ type: 'movie', id: 605 }] : []),
    });
    expect(await final('the matrix', s)).toEqual(['movie-603', 'movie-605', 'movie-604']);
  });

  it('expands a person at the top into their films', async () => {
    expect(await final('brad pitt', sources())).toEqual(['person-287', 'movie-550', 'movie-807']);
  });

  it('routes a trailing year to the year-scoped search; the exact title still leads', async () => {
    let asked: [string, number] | undefined;
    const s = sources({
      byYear: async (query, year) => {
        asked = [query, year];
        return year === 2003 ? [reloaded] : [];
      },
    });
    expect(await final('The Matrix Reloaded (2003)', s)).toEqual(['movie-604', 'movie-603']);
    expect(asked).toEqual(['The Matrix Reloaded', 2003]);
  });

  it('still answers from the semantic tail when TMDB is down, and fails only when nothing answers', async () => {
    const down = { multi: () => Promise.reject(new Error('TMDB down')) };
    const s = sources({ ...down, semantic: async () => [{ type: 'movie', id: 157336 }] });
    expect(await final('space travel', s)).toEqual(['movie-157336']);
    await expect(final('space travel', sources(down))).rejects.toThrow('TMDB down');
  });

  it('leads the first paint with the title index, typos forgiven, the franchise grouped under its top hit', async () => {
    const indexed: Record<string, Title> = {
      'movie-78': { ...movie(78, 'Blade Runner'), collectionId: 422837 },
      'movie-9999': movie(9999, 'Blade'),
      'movie-335984': { ...movie(335984, 'Blade Runner 2049'), collectionId: 422837 },
    };
    const s = sources({
      titles: async () => [78, 9999, 335984].map((id) => ({ type: 'movie' as const, id })),
      title: async (ref) => indexed[`${ref.type}-${ref.id}`] ?? catalog[`${ref.type}-${ref.id}`] ?? null,
    });
    const batches: string[][] = [];
    for await (const batch of searchStream('blade runer', s)) batches.push(batch.map(hitKey));
    expect(batches[0]).toEqual(['movie-78', 'movie-335984', 'movie-9999', 'movie-603', 'movie-604']);
  });

  it('answers from the title index when TMDB is down', async () => {
    const s = sources({ multi: () => Promise.reject(new Error('TMDB down')), titles: async () => [{ type: 'tv', id: 1 }] });
    expect(await final('casa de papel', s)).toEqual(['tv-1']);
  });

  it('browses the facet lane for a country or decade, and a leftover naming a person leads with their work', async () => {
    const spanish = {
      facets: async () => ({
        facet: { mediaType: 'tv' as const, country: 'ES', decade: null, leftover: '' },
        titles: [{ type: 'tv' as const, id: 1 }, { type: 'tv' as const, id: 2 }],
      }),
    };
    expect(await final('spanish series', sources(spanish))).toEqual(['tv-1', 'tv-2']);

    const withPerson = sources({
      facets: async () => ({ facet: { mediaType: 'movie', country: 'US', decade: null, leftover: 'brad pitt' }, titles: [] }),
    });
    expect(await final('american movies brad pitt', withPerson)).toEqual(['movie-550', 'movie-807']);
  });

  it('treats a bare media type as a title search, not a facet', async () => {
    const s = sources({ facets: async () => ({ facet: { mediaType: 'movie', country: null, decade: null, leftover: 'matrix' }, titles: [] }) });
    expect(await final('matrix movies', s)).toEqual(['movie-603', 'movie-604']);
  });
});

describe('searchSources', () => {
  const answer = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });

  it("ranks a person's films by notability and leaves out cameos, as the TV's notableFilms does", async () => {
    const credits = {
      cast: [
        { media_type: 'movie', id: 550, title: 'Fight Club', popularity: 80, vote_count: 30000, character: 'The Narrator' },
        { media_type: 'movie', id: 807, title: 'Se7en', popularity: 60, vote_count: 20000, character: 'Mills' },
        { media_type: 'tv', id: 1668, name: 'Friends', popularity: 300, character: 'Will Colbert', episode_count: 1 },
        { media_type: 'tv', id: 2224, name: 'The Daily Show', popularity: 250, character: 'Self' },
      ],
      crew: [],
    };
    const films = await searchSources('k', answer(credits)).notableFilms(287);
    expect(films.map((t) => t.id)).toEqual([550, 807]);
  });

  it('reads atlas’s semantic and facet answers, series named the Den way', async () => {
    const s = searchSources(
      'k',
      answer({
        titles: [{ type: 'series', id: 1 }, { type: 'movie', id: 2 }],
        facet: { mediaType: 'series', country: 'ES', decade: null, leftover: 'heist' },
      }),
    );
    expect(await s.semantic('heist')).toEqual([{ type: 'tv', id: 1 }, { type: 'movie', id: 2 }]);
    expect((await s.facets('spanish heist series')).facet).toEqual({
      mediaType: 'tv',
      country: 'ES',
      decade: null,
      leftover: 'heist',
    });
  });
});
