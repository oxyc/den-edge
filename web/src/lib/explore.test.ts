import { describe, expect, it } from 'vitest';
import { discoverParams, type Pages } from './catalog';
import {
  applyPick,
  chipsOf,
  emptyOptions,
  exploreChips,
  exploreFeed,
  editDistance,
  facetQuery,
  fold,
  FOR_YOU,
  KIND,
  matchChips,
  offered,
  remapChip,
  remapSet,
  browseChips,
  namesExactly,
} from './explore';
import type { MediaType, Title } from './library';

const film = (id: number, type: MediaType = 'movie'): Title => ({ type, id, title: `T${id}` });

describe('Explore chips', () => {
  it('run For You, moods, recipes, then genres, each strongest first', () => {
    const chips = exploreChips('movie', { atlas: true });
    const groups = chips.map((c) => c.group);
    // Each group in one run, in that order; languages, countries and decades last.
    expect([...new Set(groups)]).toEqual([
      'for-you',
      'mood',
      'recipe',
      'genre',
      'language',
      'country',
      'decade',
    ]);
    const of = (group: string) => chips.filter((c) => c.group === group).map((c) => c.id);
    // atlas's own order: its strongest rows lead, moods and plot facets together.
    expect(of('mood').slice(0, 3)).toEqual([
      'mood-mind-bending',
      'plot-bittersweet',
      'mood-feel-good',
    ]);
    // The TV's curated recipes first, then the rest of the catalogue, then atlas's subgenres.
    expect(of('recipe').slice(0, 3)).toEqual([
      'recipe-romantic-comedy',
      'recipe-crime-thriller',
      'recipe-action-thriller',
    ]);
    expect(of('recipe')).toContain('recipe-biopic');
    expect(of('recipe').at(-1)).toMatch(/^subgenre-/);
    // The TV's Explore genres first, then every other genre of the type.
    expect(of('genre').slice(0, 3)).toEqual(['genre-28', 'genre-35', 'genre-18']);
    expect(of('genre')).toContain('genre-37');
    // Labels drop the type the toggle already names.
    expect(chips.find((c) => c.id === 'mood-feel-good')?.label).toBe('Feel-Good');
  });

  it('offer under Series only what has a series form, and no subgenre a recipe already names', () => {
    const series = exploreChips('tv', { atlas: true });
    const ids = series.map((c) => c.id);
    expect(ids).not.toContain('recipe-sci-fi-horror');
    expect(ids).not.toContain('recipe-romantic-comedy');
    expect(ids).toContain('recipe-heist');
    expect(ids).toContain('mood-bingeable');
    // atlas's "Serial Killers" is the recipe "Serial Killer"; "Whodunits" has no recipe and stays.
    expect(ids).not.toContain('subgenre-serial-killer');
    expect(ids).toContain('subgenre-whodunit');
  });

  it('leave out hidden genres, and the moods where atlas can’t be reached', () => {
    const ids = exploreChips('movie', { hiddenGenres: new Set([27]) }).map((c) => c.id);
    expect(ids).not.toContain('genre-27');
    expect(ids.some((id) => /^(mood|plot|subgenre)-/.test(id))).toBe(false);
  });

  it('name a selection’s chips, leaving out an id the type has none for', () => {
    const chips = exploreChips('movie');
    expect(chipsOf(['genre-27', 'genre-999', 'country-SE'], chips).map((c) => c.label)).toEqual([
      'Horror',
      'Sweden',
    ]);
  });
});

describe('editDistance', () => {
  it('counts a swap as one edit, and stops counting past the limit', () => {
    expect(editDistance('sweidsh', 'swedish', 2)).toBe(1);
    expect(editDistance('acton', 'action', 2)).toBe(1);
    expect(editDistance('same', 'same', 1)).toBe(0);
    expect(editDistance('heist', 'horror', 1)).toBe(2);
  });
});

describe('matching typed text to chips', () => {
  const chips = exploreChips('movie', { atlas: true });
  const labels = (found: { label: string }[]) => found.map((c) => c.label);

  it('matches a label’s start or any word’s start, ignoring case, accents and punctuation', () => {
    expect(labels(matchChips('hei', chips))).toEqual(['Heist']);
    expect(labels(matchChips('HÉIST', chips))).toEqual(['Heist']);
    // A word inside the label: "noir" finds Nordic Noir and Neo-Noir.
    expect(labels(matchChips('noir', chips))).toEqual(['Nordic Noir', 'Neo-Noir']);
    // Punctuation and "&" fold away: "sci fi" is "Sci-Fi", "spy and" is "Spy & Espionage".
    expect(labels(matchChips('sci fi', chips))).toContain('Sci-Fi Horror');
    expect(labels(matchChips('spy and esp', chips))).toEqual(['Spy & Espionage']);
    expect(matchChips('', chips)).toEqual([]);
  });

  it('never offers For You, and ignores words that name nothing', () => {
    expect(labels(matchChips('for you', chips))).toEqual([]);
    expect(labels(matchChips('the', chips, { minWord: 3 }))).toEqual([]);
  });

  it('reads a synonym as the categories it means', () => {
    expect(labels(matchChips('funny', chips))).toEqual(['Feel-Good', 'Dark Comedies', 'Comedy']);
    expect(labels(matchChips('scary', chips))).toContain('Horror');
    expect(labels(matchChips('space', chips))).toEqual(['Set in Space', 'Science Fiction']);
  });

  it('offers what a query names, from two letters, named ones before synonyms, uncapped', () => {
    expect(labels(browseChips('funny heist', chips))).toEqual([
      'Heist',
      'Feel-Good',
      'Dark Comedies',
      'Comedy',
    ]);
    // Two letters begin something; one begins nothing yet; a plain title names no category.
    expect(browseChips('dr', chips).length).toBeGreaterThan(6);
    expect(browseChips('s', chips)).toEqual([]);
    expect(browseChips('the matrix', chips)).toEqual([]);
  });

  it('puts the whole query as a name first, short forms included', () => {
    expect(labels(browseChips('uk', chips))[0]).toBe('United Kingdom');
    expect(labels(browseChips('us', chips))[0]).toBe('United States');
    expect(labels(browseChips('sf', chips))[0]).toBe('Science Fiction');
    expect(labels(browseChips('sweden', chips))[0]).toBe('Sweden');
    expect(
      namesExactly(
        'UK',
        chips.find((c) => c.id === 'country-GB')!,
      ),
    ).toBe(true);
    expect(
      namesExactly(
        'united',
        chips.find((c) => c.id === 'country-GB')!,
      ),
    ).toBe(false);
  });

  it('offers only the closest three for a query of three words or more', () => {
    expect(browseChips('slow burn bleak thriller', chips).length).toBeLessThanOrEqual(3);
    expect(browseChips('action crime', chips).length).toBeGreaterThan(3);
  });

  it('forgives a typo or two, ranked below anything spelled right', () => {
    // A swapped pair is one edit; a missing letter is one.
    expect(labels(matchChips('sweidsh', chips)).slice(0, 2)).toEqual(['Swedish', 'Sweden']);
    expect(labels(matchChips('acton', chips))[0]).toBe('Action');
    // Nothing is a near miss under three letters: every "ac" match really begins with it.
    for (const chip of matchChips('ac', chips))
      expect(fold(`${chip.label} ${chip.aliases?.join(' ') ?? ''}`)).toMatch(/(^| )ac/);
    expect(matchChips('xq', chips)).toEqual([]);
  });

  it('finds a language, a country by its people, and a decade by its nicknames', () => {
    const found = (text: string) =>
      matchChips(text, chips).map((c) => `${c.label} · ${KIND[c.group]}`);
    expect(found('swedish').slice(0, 2)).toEqual(['Swedish · language', 'Sweden · country']);
    expect(found('90s')[0]).toBe('1990s · decade');
    expect(found('nineties')[0]).toBe('1990s · decade');
    expect(found('1990')[0]).toBe('1990s · decade');
    expect(found('korean')).toContain('South Korea · country');
    expect(exploreChips('movie').filter((c) => c.group === 'decade').length).toBeGreaterThan(3);
  });

  it('ranks an exact name over a prefix over a word over a synonym', () => {
    expect(labels(matchChips('action', chips)).slice(0, 2)).toEqual(['Action', 'Action Thriller']);
    expect(labels(matchChips('funny', chips))).toEqual(['Feel-Good', 'Dark Comedies', 'Comedy']);
  });

  it('suggests only what this type has: no Horror genre under Series', () => {
    const series = exploreChips('tv', { atlas: true });
    expect(labels(browseChips('scary', series))).toEqual(['Supernatural Horror']);
  });
});

describe('switching Movies and Series', () => {
  const movie = exploreChips('movie', { atlas: true });
  const tv = exploreChips('tv', { atlas: true });

  it('keeps a genre open as its closest counterpart', () => {
    expect(remapChip('genre-28', 'movie', 'tv', tv)).toBe('genre-10759');
    expect(remapChip('genre-27', 'movie', 'tv', tv)).toBe('genre-10765');
    expect(remapChip('genre-35', 'movie', 'tv', tv)).toBe('genre-35');
    expect(remapChip('genre-10765', 'tv', 'movie', movie)).toBe('genre-878');
  });

  it('never leaves a chip open the new type has no titles for', () => {
    // Romance folds into Drama; Reality into Documentary.
    expect(remapChip('genre-10749', 'movie', 'tv', tv)).toBe('genre-18');
    expect(remapChip('genre-10764', 'tv', 'movie', movie)).toBe('genre-99');
    // A recipe with no series form, and a mood only films carry, fall back to For You.
    expect(remapChip('recipe-sci-fi-horror', 'movie', 'tv', tv)).toBe(FOR_YOU);
    expect(remapChip('plot-bittersweet', 'movie', 'tv', tv)).toBe(FOR_YOU);
    // A recipe and a mood both types have stay open.
    expect(remapChip('recipe-heist', 'movie', 'tv', tv)).toBe('recipe-heist');
    expect(remapChip('mood-feel-good', 'movie', 'tv', tv)).toBe('mood-feel-good');
  });

  it('keeps a hidden genre’s counterpart closed too', () => {
    const hidden = exploreChips('tv', { hiddenGenres: new Set([10759]) });
    expect(remapChip('genre-28', 'movie', 'tv', hidden)).toBe(FOR_YOU);
  });

  it('moves a whole selection, and says what couldn’t come', () => {
    expect(
      remapSet(
        ['country-SE', 'genre-28', 'recipe-sci-fi-horror', 'decade-1990'],
        'movie',
        'tv',
        tv,
      ),
    ).toEqual({
      set: ['country-SE', 'genre-10759', 'decade-1990'],
      dropped: ['recipe-sci-fi-horror'],
    });
    // Two genres that fold into one are one.
    expect(remapSet(['genre-28', 'genre-12'], 'movie', 'tv', tv).set).toEqual(['genre-10759']);
  });
});

describe('facets', () => {
  it('stack, one of each kind but genres, which all apply', () => {
    let set: string[] = [];
    set = applyPick(set, 'country-SE', 'movie').set;
    set = applyPick(set, 'genre-28', 'movie').set;
    set = applyPick(set, 'genre-35', 'movie').set;
    expect(set).toEqual(['country-SE', 'genre-28', 'genre-35']);
    // A second country takes the first one's place.
    expect(applyPick(set, 'country-DK', 'movie')).toEqual({
      set: ['genre-28', 'genre-35', 'country-DK'],
      removed: ['country-SE'],
    });
    // Picked again, a facet comes out; For You empties the lot.
    expect(applyPick(set, 'genre-28', 'movie').set).toEqual(['country-SE', 'genre-35']);
    expect(applyPick(set, FOR_YOU, 'movie').set).toEqual([]);
  });

  it('let the newer pick win where a recipe contradicts a facet', () => {
    // K-Drama is Korean; picking it throws out Swedish.
    expect(applyPick(['lang-sv', 'genre-18'], 'recipe-k-drama', 'tv')).toEqual({
      set: ['genre-18', 'recipe-k-drama'],
      removed: ['lang-sv'],
    });
    // Pure Drama rules out Crime; picking Crime after it throws the recipe out.
    expect(applyPick(['recipe-pure-drama'], 'genre-80', 'movie')).toEqual({
      set: ['genre-80'],
      removed: ['recipe-pure-drama'],
    });
    // A mood can't take a country or a recipe: atlas's rows don't say.
    expect(applyPick(['country-SE', 'genre-28'], 'mood-cozy', 'movie')).toEqual({
      set: ['genre-28', 'mood-cozy'],
      removed: ['country-SE'],
    });
  });

  it('offer beside a selection only what won’t throw a pick of another kind out', () => {
    const set = ['recipe-k-drama'];
    expect(offered(set, 'lang-ko', 'tv')).toBe(true);
    expect(offered(set, 'lang-sv', 'tv')).toBe(false);
    expect(offered(set, 'recipe-k-drama', 'tv')).toBe(false);
    // Another recipe takes this one's place, which is a pick like any other.
    expect(offered(set, 'recipe-heist', 'tv')).toBe(true);
    expect(offered(['mood-cozy'], 'country-SE', 'movie')).toBe(false);
    expect(offered(['mood-cozy'], 'decade-1990', 'movie')).toBe(true);
  });

  it('merge into one discover query', () => {
    expect(discoverParams(facetQuery(['country-SE', 'genre-28'], 'movie')!)).toEqual({
      sort_by: 'popularity.desc',
      include_adult: 'false',
      with_genres: '28',
      with_origin_country: 'SE',
      'vote_count.gte': '30',
    });
    // A recipe is a preset the rest add to: Heist's keyword stays, its OR-joined genres give way to Action.
    const heist = discoverParams(facetQuery(['recipe-heist', 'genre-28', 'decade-1990'], 'movie')!);
    expect(heist.with_keywords).toBe('10051');
    expect(heist.with_genres).toBe('28');
    expect(heist['primary_release_date.gte']).toBe('1990-01-01');
    expect(heist['vote_count.gte']).toBe('100');
    // An AND-joined recipe's genres join the picked ones.
    expect(
      discoverParams(facetQuery(['recipe-romantic-comedy', 'genre-18'], 'movie')!).with_genres,
    ).toBe('35,10749,18');
    // An atlas row can't be a discover query.
    expect(facetQuery(['mood-cozy', 'genre-35'], 'movie')).toBeUndefined();
  });
});

describe('emptyOptions', () => {
  const chips = exploreChips('movie');
  const loaded = [
    { ...film(1), genreIds: [28, 18], originalLanguage: 'sv', year: 1994 },
    { ...film(2), genreIds: [28], originalLanguage: 'sv', year: 2001 },
  ];

  it('hides what nothing in a fully loaded feed matches, and nothing before it is fully loaded', () => {
    const empty = emptyOptions(['country-SE', 'genre-28'], loaded, true, chips);
    expect(empty.has('genre-35')).toBe(true);
    expect(empty.has('genre-18')).toBe(false);
    expect(empty.has('lang-en')).toBe(true);
    expect(empty.has('lang-sv')).toBe(false);
    expect(empty.has('decade-1980')).toBe(true);
    expect(empty.has('decade-1990')).toBe(false);
    expect(emptyOptions(['country-SE', 'genre-28'], loaded, false, chips).size).toBe(0);
  });

  it('never judges what nothing loaded can say: a country, a recipe, or a replacement', () => {
    const empty = emptyOptions(['lang-sv'], loaded, true, chips);
    expect(empty.has('country-KR')).toBe(false);
    expect(empty.has('recipe-heist')).toBe(false);
    // A second language replaces Swedish rather than narrowing it.
    expect(empty.has('lang-en')).toBe(false);
    expect(emptyOptions([], loaded, true, chips).size).toBe(0);
  });
});

describe('Explore feeds', () => {
  const calls: { path: string; params: Record<string, string>; page: number }[] = [];
  const pages: Pages = async (path, type, params, page) => {
    calls.push({ path, params, page });
    if (path.endsWith('/recommendations')) return [film(1000 + page, type), film(50, type)];
    return [film(page * 100, type)];
  };
  const sources = (seeds: Title[] = []) => ({
    pages,
    atlas: null,
    seeds,
    owned: new Set(['movie:50']),
  });

  it('browses a genre as its primary-genre shelf, retargeted for the type', async () => {
    calls.length = 0;
    const row = exploreFeed(['genre-10765'], 'tv', { ...sources(), minYear: 1990 });
    await row.load(2);
    expect(calls[0]?.path).toBe('/discover/tv');
    expect(calls[0]?.params.with_genres).toBe('10765');
    expect(calls[0]?.params['first_air_date.gte']).toBe('1990-01-01');
    expect(calls[0]?.page).toBe(2);
    expect(row.filter?.({ ...film(1, 'tv'), genreIds: [10765] })).toBe(true);
  });

  it('browses a language, a country and a decade as TMDB discover', async () => {
    const asked = async (id: string) => {
      calls.length = 0;
      await exploreFeed([id], 'tv', sources()).load(1);
      return calls[0]?.params ?? {};
    };
    expect((await asked('lang-sv')).with_original_language).toBe('sv');
    expect((await asked('country-SE')).with_origin_country).toBe('SE');
    const decade = await asked('decade-1990');
    expect(decade['first_air_date.gte']).toBe('1990-01-01');
    expect(decade['first_air_date.lte']).toBe('1999-12-31');
  });

  it('browses a movie recipe as series under Series', async () => {
    calls.length = 0;
    await exploreFeed(['recipe-heist'], 'tv', sources()).load(1);
    expect(calls[0]?.path).toBe('/discover/tv');
    expect(calls[0]?.params.with_genres).toBe('80');
    expect(calls[0]?.params.with_keywords).toBe('10051');
  });

  it('is For You: recommendations for the latest titles of this type, then the popular tail', async () => {
    calls.length = 0;
    const seeds = [film(1), film(2, 'tv'), film(3), film(4), film(5)];
    const row = exploreFeed([], 'movie', sources(seeds));
    const first = await row.load(1);
    // Three movie seeds asked (not the series, not a fourth), and what the library holds is left out.
    expect(calls.map((c) => c.path)).toEqual([
      '/movie/1/recommendations',
      '/movie/3/recommendations',
      '/movie/4/recommendations',
    ]);
    expect(first.map((t) => t.id)).toEqual([1001]);
    await row.load(2);
    expect(calls.at(-1)).toMatchObject({ path: '/movie/popular', page: 1 });
  });

  it('is the tail alone for a guest, top-rated for series', async () => {
    calls.length = 0;
    await exploreFeed([], 'tv', sources()).load(1);
    expect(calls).toEqual([{ path: '/tv/top_rated', params: {}, page: 1 }]);
  });

  it('is atlas’s own row for a mood, and For You where atlas can’t be reached', () => {
    const row = exploreFeed(['mood-cozy'], 'movie', { ...sources(), atlas: '/atlas' });
    expect(row.id).toBe('facets-mood-cozy-movie');
    expect(exploreFeed(['mood-cozy'], 'movie', sources()).id).toBe(`${FOR_YOU}-movie`);
  });

  it('narrows a mood by the genre, language and decade beside it, on what its titles carry', () => {
    const row = exploreFeed(['mood-cozy', 'genre-35', 'lang-sv', 'decade-1990'], 'movie', {
      ...sources(),
      atlas: '/atlas',
    });
    const title = { ...film(1), genreIds: [35, 18], originalLanguage: 'sv', year: 1994 };
    expect(row.filter?.(title)).toBe(true);
    expect(row.filter?.({ ...title, genreIds: [18] })).toBe(false);
    expect(row.filter?.({ ...title, originalLanguage: 'en' })).toBe(false);
    expect(row.filter?.({ ...title, year: 2001 })).toBe(false);
  });

  it('names a mood’s posterless titles from TMDB, so the hide rules don’t empty it', async () => {
    const atlasFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes('/index/row/')
        ? new Response(
            JSON.stringify({
              titles: [
                { type: 'movie', id: 1, title: 'Drawn', posterPath: '/a.jpg' },
                { type: 'movie', id: 2, title: 'Blank' },
                { type: 'movie', id: 3, title: 'Unknown' },
              ],
            }),
          )
        : new Response('', { status: 404 })) as typeof fetch;
    try {
      const looked: number[] = [];
      const row = exploreFeed(['mood-cozy'], 'movie', {
        ...sources(),
        atlas: '/atlas',
        title: async (ref) => {
          looked.push(ref.id);
          return ref.id === 2 ? { ...film(2), posterPath: '/b.jpg' } : null;
        },
      });
      const titles = await row.load(1);
      expect(looked).toEqual([2, 3]);
      expect(titles.map((t) => t.posterPath)).toEqual(['/a.jpg', '/b.jpg', undefined]);
    } finally {
      globalThis.fetch = atlasFetch;
    }
  });
});
