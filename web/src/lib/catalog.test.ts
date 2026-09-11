import { describe, expect, it } from 'vitest';
import { browseRows, categories, discoverParams, homeRows, interleave, RECIPES, tmdbPages, type Pages } from './catalog';

describe('discover queries, as DenKit builds them', () => {
  it('joins genres AND or OR, keywords and countries OR, and dates by the type’s own field', () => {
    expect(discoverParams({ mediaType: 'movie', genres: [35, 10749], voteCountGte: 100 })).toEqual({
      sort_by: 'popularity.desc',
      include_adult: 'false',
      with_genres: '35,10749',
      'vote_count.gte': '100',
    });
    expect(
      discoverParams({
        mediaType: 'tv',
        genres: [80, 53],
        genreJoin: 'or',
        keywords: [1, 2],
        withoutGenres: [27, 53],
        originalLanguage: 'ko',
        originCountry: ['KR', 'JP'],
        releaseDateGte: '1990-01-01',
        releaseDateLte: '1999-12-31',
        sortBy: 'vote_average.desc',
      }),
    ).toEqual({
      sort_by: 'vote_average.desc',
      include_adult: 'false',
      with_genres: '80|53',
      with_keywords: '1|2',
      without_genres: '27,53',
      with_original_language: 'ko',
      with_origin_country: 'KR|JP',
      'first_air_date.gte': '1990-01-01',
      'first_air_date.lte': '1999-12-31',
    });
  });
});

describe('the endless tail', () => {
  it('interleaves one of each kind in turn', () => {
    expect(interleave<number | string | boolean>([[1, 2, 3], ['a'], [true, false]])).toEqual([1, 'a', true, 2, false, 3]);
  });

  it('leads with a genre, then a recipe, a decade and a country, and ends Critically Acclaimed', () => {
    const rows = categories('movie', 2026);
    expect(rows.slice(0, 4).map((c) => c.id)).toEqual(['genre-28-movie', 'recipe-romantic-comedy-movie', 'decade-2020-movie', 'country-KR-movie']);
    expect(rows.at(-1)).toMatchObject({ id: 'acclaimed-movie', title: 'Critically Acclaimed' });
    expect(rows.find((c) => c.id === 'genre-28-movie')?.title).toBe('Action Movies');
    expect(rows.some((c) => c.id === 'recipe-k-drama-movie'), 'K-Drama is a series recipe').toBe(false);
    expect(categories('tv', 2026).some((c) => c.id === 'recipe-k-drama-tv')).toBe(true);
  });

  it('puts preferred genres first, and drops decades wholly under the year floor', () => {
    expect(categories('tv', 2026, { preferredGenres: [99] })[0]?.id).toBe('genre-99-tv');
    const floored = categories('movie', 2026, { minYear: 1985 });
    const decades = floored.filter((c) => c.id.startsWith('decade-'));
    expect(decades.map((c) => c.id).at(-1)).toBe('decade-1980-movie');
    expect(decades.at(-1)?.query.releaseDateGte).toBe('1985-01-01');
    expect(floored.find((c) => c.id === 'genre-28-movie')?.query.releaseDateGte).toBe('1985-01-01');
  });

  it('carries every recipe the TV has', () => {
    expect(RECIPES).toHaveLength(39);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(39);
  });
});

describe('the screens', () => {
  const pages: Pages = async () => [];

  it("Home: the TV's spine and recipe rows, then a tail without them", () => {
    const rows = homeRows(pages, { now: new Date('2026-09-11T12:00:00Z') });
    expect(rows.slice(0, 7).map((r) => r.id)).toEqual([
      'trending',
      'new-releases',
      'top-series',
      'upcoming',
      'recipe-romantic-comedy',
      'recipe-nordic-noir',
      'recipe-police-procedural',
    ]);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('recipe-romantic-comedy-movie');
    expect(ids).not.toContain('acclaimed-tv');
    expect(ids).toContain('acclaimed-movie');
  });

  it('Movies: Popular, three genres the viewer hasn’t hidden, then a tail that doesn’t repeat them', () => {
    const rows = browseRows('movie', pages, { hiddenGenres: new Set([35]) });
    expect(rows.slice(0, 4).map((r) => [r.id, r.title])).toEqual([
      ['popular', 'Popular on TMDB'],
      ['genre-28', 'Action'],
      ['genre-18', 'Drama'],
      ['genre-27', 'Horror'],
    ]);
    const ids = rows.map((r) => r.id);
    for (const gone of ['genre-28-movie', 'genre-35-movie']) expect(ids).not.toContain(gone);
    expect(ids).toContain('genre-878-movie');
  });

  it('loads a row a page at a time from TMDB, and asks for no page past 500', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ results: [{ id: 550, title: 'Fight Club', poster_path: '/f.jpg' }, { id: 'x' }] }));
    }) as typeof fetch;
    const [trending] = homeRows(tmdbPages('k', fetchImpl));
    expect(await trending!.load(2)).toMatchObject([{ type: 'movie', id: 550, title: 'Fight Club' }]);
    const url = new URL(asked[0]!);
    expect([url.pathname, url.searchParams.get('page')]).toEqual(['/3/trending/movie/week', '2']);
    expect(await trending!.load(501)).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
