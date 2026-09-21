import { describe, expect, it } from 'vitest';
import {
  appendUniqueTitles,
  browseRows,
  categories,
  discoverParams,
  homeRows,
  interleave,
  matchesPrimaryGenre,
  personalRows,
  primaryGenre,
  RECIPES,
  shelfGenre,
  tmdbPages,
  type Pages,
} from './catalog';
import type { Title } from './library';

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

describe('primary genre shelves', () => {
  it('uses the most specific genre rather than admitting every secondary TMDB label', () => {
    expect(primaryGenre([12, 35, 10751, 16]), 'Adventure · Comedy · Family · Animation').toBe(16);
    expect(primaryGenre([18, 35]), 'Comedy is more specific than Drama').toBe(35);
    expect(primaryGenre([18, 80]), 'Crime is more specific than Drama').toBe(80);
    expect(primaryGenre([10751, 14]), 'equal rarity keeps TMDB order').toBe(10751);
    expect(primaryGenre([14, 10751]), 'equal rarity stays deterministic in reverse').toBe(14);
    expect(primaryGenre([])).toBeUndefined();
  });

  it('prefers the corpus label over the rarity heuristic, and falls back when there is none', () => {
    // Moana is Adventure · Comedy · Family · Animation in TMDB. The heuristic picks Animation because it
    // is the rarest label; atlas says what it IS.
    const moana = {
      type: 'movie',
      id: 277834,
      title: 'Moana',
      genreIds: [12, 35, 10751, 16],
    } as Title;
    expect(shelfGenre(moana), 'no corpus label: the heuristic decides').toBe(16);
    expect(shelfGenre({ ...moana, primaryGenreName: 'Adventure' })).toBe(12);
    expect(matchesPrimaryGenre({ ...moana, primaryGenreName: 'Adventure' }, 12)).toBe(true);
    expect(matchesPrimaryGenre({ ...moana, primaryGenreName: 'Adventure' }, 16)).toBe(false);

    // The taxonomy is not TMDB's: a label naming no TMDB genre for this type falls through to the
    // heuristic rather than excluding the title from every shelf.
    expect(shelfGenre({ ...moana, primaryGenreName: 'Coming-of-Age' })).toBe(16);

    // Genre ids are per media type. "Crime" is 80 for both, but a series' table is a different one, and a
    // film label must not be resolved against it.
    const series = { type: 'tv', id: 1438, title: 'The Wire', genreIds: [18] } as Title;
    expect(shelfGenre({ ...series, primaryGenreName: 'Crime' })).toBe(80);
    expect(shelfGenre({ ...series, primaryGenreName: 'Science Fiction' }), 'films only').toBe(18);
  });

  it('marks only plain genre rows for primary-genre filtering', () => {
    const rows = browseRows('movie', async () => []);
    const comedy = rows.find((row) => row.id === 'genre-35');
    const popular = rows.find((row) => row.id === 'popular');
    expect(
      comedy?.filter?.({
        type: 'movie',
        id: 277834,
        title: 'Moana',
        genreIds: [12, 35, 10751, 16],
      }),
    ).toBe(false);
    expect(comedy?.filter?.({ type: 'movie', id: 1, title: 'A comedy', genreIds: [18, 35] })).toBe(
      true,
    );
    expect(popular?.filter).toBeUndefined();
    expect(rows.find((row) => row.id.startsWith('recipe-'))?.filter).toBeUndefined();
  });

  it('deduplicates pages by typed identity, including duplicates inside one page', () => {
    const movie = { type: 'movie' as const, id: 1, title: 'Movie' };
    const series = { type: 'tv' as const, id: 1, title: 'Series' };
    expect(appendUniqueTitles([movie], [movie, movie, series])).toEqual([movie, series]);
  });
});

describe('the endless tail', () => {
  it('interleaves one of each kind in turn', () => {
    expect(interleave<number | string | boolean>([[1, 2, 3], ['a'], [true, false]])).toEqual([
      1,
      'a',
      true,
      2,
      false,
      3,
    ]);
  });

  it('leads with a genre, then a recipe, a decade and a country, and ends Critically Acclaimed', () => {
    const rows = categories('movie', 2026);
    expect(rows.slice(0, 4).map((c) => c.id)).toEqual([
      'genre-28-movie',
      'recipe-romantic-comedy-movie',
      'decade-2020-movie',
      'country-KR-movie',
    ]);
    expect(rows.at(-1)).toMatchObject({ id: 'acclaimed-movie', title: 'Critically Acclaimed' });
    expect(rows.find((c) => c.id === 'genre-28-movie')?.title).toBe('Action Movies');
    expect(
      rows.some((c) => c.id === 'recipe-k-drama-movie'),
      'K-Drama is a series recipe',
    ).toBe(false);
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

  it("Home's personal rows: TMDB's recommendations for your latest titles, less what you already have", async () => {
    const asked: string[] = [];
    const recs: Pages = async (path) => {
      asked.push(path);
      return [
        { type: 'movie', id: 1, title: 'Owned' },
        { type: 'movie', id: 2, title: 'New to you' },
      ];
    };
    const arrival = { type: 'movie' as const, id: 329865, title: 'Arrival' };
    const dune = { type: 'tv' as const, id: 693134, title: 'Dune: Prophecy' };
    const rows = personalRows(recs, {
      watched: [arrival],
      watchlisted: [dune],
      owned: new Set(['movie:1']),
    });
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ['byw-movie-329865', 'Because you watched Arrival'],
      ['wl-tv-693134', 'Because you added Dune: Prophecy to your Watchlist'],
    ]);
    expect(rows.map((r) => r.headingLink)).toEqual([
      {
        before: 'Because you watched ',
        label: 'Arrival',
        after: '',
        href: '/movie/329865-arrival',
      },
      {
        before: 'Because you added ',
        label: 'Dune: Prophecy',
        after: ' to your Watchlist',
        href: '/tv/693134-dune-prophecy',
      },
    ]);
    expect((await rows[0]!.load(1)).map((t) => t.title)).toEqual(['New to you']);
    expect(asked).toEqual(['/movie/329865/recommendations']);
  });

  it('loads a row a page at a time from TMDB, and asks for no page past 500', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          results: [{ id: 550, title: 'Fight Club', poster_path: '/f.jpg' }, { id: 'x' }],
        }),
      );
    }) as typeof fetch;
    const [trending] = homeRows(tmdbPages('k', fetchImpl));
    expect(await trending!.load(2)).toMatchObject([
      { type: 'movie', id: 550, title: 'Fight Club' },
    ]);
    const url = new URL(asked[0]!);
    expect([url.pathname, url.searchParams.get('page')]).toEqual(['/3/trending/movie/week', '2']);
    expect(await trending!.load(501)).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});

describe('rows about a language the viewer has excluded', () => {
  const ids = (excludedLanguages?: Set<string>) =>
    categories('tv', 2026, excludedLanguages ? { excludedLanguages } : {}).map((c) => c.id);

  it('are not offered at all, whether they say so by language or by country', () => {
    expect(ids()).toEqual(
      expect.arrayContaining(['recipe-k-drama-tv', 'recipe-turkish-drama-tv', 'country-TR-tv']),
    );

    // Hidden cards under a heading is the symptom: the row is about nothing else, so it can only ever draw
    // a shelf of what the hide rules take straight back out.
    expect(ids(new Set(['ko']))).not.toContain('recipe-k-drama-tv');

    // Turkey is the harder case. "Turkish Drama" names no language at all, only `originCountry`, and TMDB
    // tags many titles it files under Turkey as Urdu — so nothing hid them and the row filled with exactly
    // what had been excluded.
    const turkish = ids(new Set(['tr']));
    expect(turkish).not.toContain('recipe-turkish-drama-tv');
    expect(turkish).not.toContain('country-TR-tv');

    // India stands for no single language, so excluding one never suppresses it.
    expect(ids(new Set(['hi']))).toContain('country-IN-tv');
    // And an unrelated exclusion leaves everything else alone.
    expect(ids(new Set(['ko']))).toContain('country-TR-tv');
  });

  it('keeps a row about several languages when only one of them is excluded', () => {
    const many = RECIPES.find((r) => r.query.originalLanguage?.includes('|'));
    if (!many) throw new Error('no multi-language recipe to check');
    const type = many.query.mediaType;
    expect(
      categories(type, 2026, { excludedLanguages: new Set(['sv']) }).map((c) => c.id),
    ).toContain(`recipe-${many.id}-${type}`);
  });
});
