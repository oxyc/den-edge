import { describe, expect, it, vi } from 'vitest';
import {
  appendUniqueTitles,
  browseRows,
  categories,
  discoverParams,
  equivalentGenre,
  EXPLORE,
  GENRES,
  homeRows,
  interleave,
  matchesPrimaryGenre,
  personalRows,
  primaryGenre,
  RECIPES,
  retargeted,
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

describe('rows atlas’s filter answers', () => {
  const itemsOf = (type: 'movie' | 'tv') =>
    Object.fromEntries(categories(type, 2026).map((c) => [c.id, c.atlas]));

  it('says a genre by its primary label, a recipe by its subgenre or parts, a decade and a country as themselves', () => {
    const movie = itemsOf('movie');
    expect(movie['genre-28-movie']).toEqual([{ kind: 'primary', id: 'Action' }]);
    expect(movie['recipe-romantic-comedy-movie']).toEqual([
      { kind: 'subgenre', id: 'Romantic Comedy' },
    ]);
    expect(movie['recipe-french-cinema-movie']).toEqual([
      { kind: 'language', id: 'fr' },
      { kind: 'country', id: 'FR' },
    ]);
    expect(movie['decade-1990-movie']).toEqual([{ kind: 'decade', id: '1990' }]);
    expect(movie['country-KR-movie']).toEqual([{ kind: 'country', id: 'KR' }]);
    const tv = itemsOf('tv');
    expect(tv['recipe-k-drama-tv']).toEqual([
      { kind: 'genre', id: '18' },
      { kind: 'language', id: 'ko' },
      { kind: 'country', id: 'KR' },
    ]);
    expect(tv['recipe-turkish-drama-tv']).toEqual([
      { kind: 'genre', id: '18' },
      { kind: 'country', id: 'TR' },
    ]);
  });

  it('leaves TMDB the rows atlas can’t say: keywords, several languages, genres left out, a rating order', () => {
    const movie = itemsOf('movie');
    for (const id of [
      'recipe-nordic-noir-movie',
      'recipe-korean-thriller-movie',
      'recipe-latin-american-movie',
      'recipe-pure-drama-movie',
      'acclaimed-movie',
    ])
      expect(movie[id], id).toBeUndefined();
  });

  /** atlas's filter and den-edge's shared metadata, as a fake: `titles` answers each titles.json by its `skip`. */
  function atlasFake(titles: (skip: number, sel: string) => Response) {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/metadata/title/query'))
        return new Response(JSON.stringify({ entries: [] }));
      asked.push(url);
      const params = new URL(url, 'https://x').searchParams;
      return titles(Number(params.get('skip') ?? 0), params.get('sel') ?? '');
    }) as typeof fetch;
    return { asked, fetchImpl };
  }
  const card = (id: number, extra: Record<string, unknown> = {}) => ({
    type: 'movie',
    id,
    title: `Atlas ${id}`,
    posterPath: '/a.jpg',
    ...extra,
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  /** TMDB's pages, recording each path and page asked. */
  function tmdbFake() {
    const asked: string[] = [];
    const pages: Pages = async (path, type, params, page) => {
      asked.push(`${path}?${params.with_genres ?? params.with_origin_country ?? ''}#${page}`);
      return [{ type, id: 9000 + page, title: `TMDB ${page}`, posterPath: '/t.jpg' }];
    };
    return { asked, pages };
  }

  it('loads the Movies tab’s genre rows from atlas, and TMDB is not asked', async () => {
    const atlas = atlasFake((skip) =>
      json({ titles: [card(skip + 1, { primaryGenre: 'Action' })], order: 'o', ignored: [] }),
    );
    const tmdb = tmdbFake();
    const rows = browseRows('movie', tmdb.pages, {
      atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl },
    });
    // A row of its own to the screen, so one loaded from TMDB before atlas was found starts over.
    expect(rows.map((r) => r.id)).not.toContain('genre-28');
    const action = rows.find((r) => r.id === 'genre-28-atlas')!;
    expect((await action.load(1)).map((t) => t.id)).toEqual([1]);
    expect((await action.load(2)).map((t) => t.id)).toEqual([25]);
    expect(atlas.asked).toEqual([
      '/atlas/index/filter/movie/titles.json?sel=primary:Action',
      '/atlas/index/filter/movie/titles.json?sel=primary:Action&skip=24',
    ]);
    expect(tmdb.asked).toEqual([]);
    // atlas's answer is the shelf: TMDB's rarity guess (Animation, here) doesn't take a card out of it.
    expect(action.filter?.({ type: 'movie', id: 5, title: 'Moana', genreIds: [28, 16] })).toBe(
      true,
    );
    // Popular is TMDB's own chart either way.
    await rows.find((r) => r.id === 'popular')!.load(1);
    expect(tmdb.asked).toEqual(['/movie/popular?#1']);
  });

  it('is TMDB discover page for page where atlas has no filter routes', async () => {
    const atlas = atlasFake(() => json({}, 404));
    const tmdb = tmdbFake();
    const [row] = browseRows('movie', tmdb.pages, {
      atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl },
    }).filter((r) => r.id === 'genre-28-atlas');
    expect((await row!.load(1)).map((t) => t.id)).toEqual([9001]);
    expect((await row!.load(2)).map((t) => t.id)).toEqual([9002]);
    // Asked once; TMDB's from then on, with its shelf filter back.
    expect(atlas.asked).toHaveLength(1);
    expect(tmdb.asked).toEqual(['/discover/movie?28#1', '/discover/movie?28#2']);
    expect(row!.filter?.({ type: 'movie', id: 5, title: 'Moana', genreIds: [28, 16] })).toBe(false);
  });

  it('is TMDB’s where atlas has no such value, as for a genre it has no primary label for', async () => {
    const atlas = atlasFake(() =>
      json({ titles: [], ignored: [], unknownValues: ['primary:Animation'], order: 'o' }),
    );
    const tmdb = tmdbFake();
    const animation = categories('movie', 2026).find((c) => c.id === 'genre-16-movie')!;
    const [row] = homeRows(tmdb.pages, {
      atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl },
    }).filter((r) => r.id === `${animation.id}-atlas`);
    expect((await row!.load(1)).map((t) => t.id)).toEqual([9001]);
    expect(atlas.asked).toEqual(['/atlas/index/filter/movie/titles.json?sel=primary:Animation']);
  });

  it('goes on with TMDB once atlas’s titles run out, so the row stays endless', async () => {
    const atlas = atlasFake((skip) =>
      json({ titles: skip ? [] : [card(1)], order: 'o', ignored: [] }),
    );
    const tmdb = tmdbFake();
    const [row] = homeRows(tmdb.pages, {
      atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl },
    }).filter((r) => r.id === 'country-KR-movie-atlas');
    expect((await row!.load(1)).map((t) => t.id)).toEqual([1]);
    expect((await row!.load(2)).map((t) => t.id)).toEqual([9001]);
    expect((await row!.load(3)).map((t) => t.id)).toEqual([9002]);
    expect(atlas.asked).toEqual([
      '/atlas/index/filter/movie/titles.json?sel=country:KR',
      '/atlas/index/filter/movie/titles.json?sel=country:KR&skip=24',
    ]);
    expect(tmdb.asked).toEqual(['/discover/movie?KR#1', '/discover/movie?KR#2']);
  });

  it('is TMDB’s when atlas fails, and says so', async () => {
    const atlas = atlasFake(() => json({}, 500));
    const tmdb = tmdbFake();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [row] = homeRows(tmdb.pages, {
      atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl },
    }).filter((r) => r.id === 'decade-2020-movie-atlas');
    expect((await row!.load(1)).map((t) => t.id)).toEqual([9001]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('draws a card atlas has no poster for from TMDB', async () => {
    const atlas = atlasFake(() =>
      json({ titles: [card(7, { posterPath: null })], order: 'o', ignored: [] }),
    );
    const [row] = homeRows(tmdbFake().pages, {
      atlas: {
        base: '/atlas',
        fetchImpl: atlas.fetchImpl,
        title: async (ref) => ({ ...ref, title: 'Drawn', posterPath: '/drawn.jpg' }),
      },
    }).filter((r) => r.id === 'recipe-romantic-comedy-atlas');
    expect(await row!.load(1)).toMatchObject([{ id: 7, posterPath: '/drawn.jpg' }]);
    expect(atlas.asked).toEqual([
      '/atlas/index/filter/movie/titles.json?sel=subgenre:Romantic%20Comedy',
    ]);
  });

  it('keeps TMDB for the spine, Nordic Noir and Critically Acclaimed, and asks atlas nothing without it', async () => {
    const atlas = atlasFake(() => json({ titles: [card(1)], order: 'o', ignored: [] }));
    const tmdb = tmdbFake();
    const rows = homeRows(tmdb.pages, { atlas: { base: '/atlas', fetchImpl: atlas.fetchImpl } });
    for (const id of ['new-releases', 'recipe-nordic-noir', 'acclaimed-movie'])
      await rows.find((r) => r.id === id)!.load(1);
    expect(atlas.asked).toEqual([]);
    expect(tmdb.asked).toHaveLength(3);
    const plain = homeRows(tmdb.pages).find((r) => r.id === 'country-KR-movie')!;
    await plain.load(1);
    expect(atlas.asked).toEqual([]);
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

describe('Movies ⇄ Series, as the TV switches them', () => {
  it('keeps a shared genre, folds a split one, and finds nothing only where there is nothing', () => {
    // Ids both types carry pass straight through.
    for (const id of [16, 18, 35, 37, 80, 99, 9648, 10751]) {
      expect(equivalentGenre(id, 'movie', 'tv')).toBe(id);
      expect(equivalentGenre(id, 'tv', 'movie')).toBe(id);
    }
    // GenreCatalog.movieToTV.
    expect(equivalentGenre(28, 'movie', 'tv')).toBe(10759);
    expect(equivalentGenre(12, 'movie', 'tv')).toBe(10759);
    expect(equivalentGenre(878, 'movie', 'tv')).toBe(10765);
    expect(equivalentGenre(27, 'movie', 'tv')).toBe(10765);
    expect(equivalentGenre(53, 'movie', 'tv')).toBe(9648);
    expect(equivalentGenre(10749, 'movie', 'tv')).toBe(18);
    expect(equivalentGenre(10752, 'movie', 'tv')).toBe(10768);
    // GenreCatalog.tvToMovie.
    expect(equivalentGenre(10759, 'tv', 'movie')).toBe(28);
    expect(equivalentGenre(10765, 'tv', 'movie')).toBe(878);
    expect(equivalentGenre(10762, 'tv', 'movie')).toBe(10751);
    expect(equivalentGenre(10764, 'tv', 'movie')).toBe(99);
    // Same type is a no-op; an id neither table knows has no counterpart.
    expect(equivalentGenre(27, 'movie', 'movie')).toBe(27);
    expect(equivalentGenre(1, 'movie', 'tv')).toBeUndefined();
  });

  it('lands every Explore genre of one type on an Explore-able genre of the other', () => {
    for (const [from, to] of [
      ['movie', 'tv'],
      ['tv', 'movie'],
    ] as const) {
      for (const id of EXPLORE[from]) {
        const mapped = equivalentGenre(id, from, to);
        expect(mapped, `${from} ${id}`).toBeDefined();
        expect(GENRES[to][mapped!], `${from} ${id} → ${mapped}`).toBeDefined();
      }
    }
  });

  // DiscoverRecipeTests.test_retargeted_movieToTV.
  it('retargets movie recipes to series and refuses the ones with no series form', () => {
    // Heist: OR [Crime, Thriller] + keyword → series drops Thriller, keeps Crime and the keyword.
    const heist = retargeted(
      { mediaType: 'movie', genres: [80, 53], genreJoin: 'or', keywords: [10051] },
      'tv',
    );
    expect(heist?.mediaType).toBe('tv');
    expect(heist?.genres).toEqual([80]);
    expect(heist?.keywords).toEqual([10051]);
    expect(heist?.primaryGenre, 'recipe rows keep their inclusive semantics').toBeUndefined();

    // Superhero: OR [Action, Adventure, Sci-Fi] folds to [Action & Adventure, Sci-Fi & Fantasy].
    const supes = retargeted(
      { mediaType: 'movie', genres: [28, 12, 878], genreJoin: 'or', keywords: [9715] },
      'tv',
    );
    expect(supes?.genres).toEqual([10759, 10765]);

    // A plain genre shelf carries its primary-genre constraint through the same mapping.
    const action = retargeted({ mediaType: 'movie', genres: [28], primaryGenre: 28 }, 'tv');
    expect(action?.genres).toEqual([10759]);
    expect(action?.primaryGenre).toBe(10759);

    // AND genres with a member that has no series form: Sci-Fi Horror, Romantic Comedy.
    expect(retargeted({ mediaType: 'movie', genres: [878, 27] }, 'tv')).toBeUndefined();
    expect(retargeted({ mediaType: 'movie', genres: [35, 10749] }, 'tv')).toBeUndefined();

    // Same type is a no-op.
    const romcom = { mediaType: 'movie' as const, genres: [35, 10749] };
    expect(retargeted(romcom, 'movie')).toBe(romcom);
  });

  it('keeps a service query when its genres all drop, since the providers still narrow it', () => {
    // WatchServiceTests: "everything on HBO Max" must survive the switch.
    const series = retargeted(
      {
        mediaType: 'movie',
        genres: [27],
        genreJoin: 'or',
        watchProviders: [1899],
        watchRegion: 'US',
      },
      'tv',
    );
    expect(series?.mediaType).toBe('tv');
    expect(series?.genres).toEqual([]);
    expect(series?.watchProviders).toEqual([1899]);
    expect(retargeted({ mediaType: 'movie', genres: [27], genreJoin: 'or' }, 'tv')).toBeUndefined();
  });

  it('offers under Series only the TV Explore recipes that have a series form', () => {
    const ids = [
      'romantic-comedy',
      'crime-thriller',
      'sci-fi-horror',
      'horror-comedy',
      'heist',
      'superhero',
      'k-drama',
    ];
    const series = ids.filter((id) => {
      const recipe = RECIPES.find((r) => r.id === id);
      return recipe && retargeted(recipe.query, 'tv');
    });
    expect(series).toEqual(['heist', 'superhero', 'k-drama']);
  });
});
