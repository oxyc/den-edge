import { describe, expect, it, vi } from 'vitest';
import { discoverParams, type Pages } from './catalog';
import type { FacetCounts } from './facetCounts';
import {
  applyPick,
  chipsOf,
  countedEmptyAcross,
  emptyOptions,
  exploreChips,
  exploreFeed,
  editDistance,
  interleaveFeeds,
  perType,
  facetQuery,
  filterChips,
  fold,
  FOR_YOU,
  KIND,
  matchChips,
  offered,
  pendingChip,
  pillOrder,
  remapChip,
  remapSet,
  browseChips,
  namesExactly,
} from './explore';
import type { FilterCounts } from './filterRoutes';
import type { MediaType, Title } from './library';

const film = (id: number, type: MediaType = 'movie'): Title => ({ type, id, title: `T${id}` });

describe('Explore chips', () => {
  it('run For You, moods, recipes, then genres, each strongest first', () => {
    const chips = exploreChips('movie', { atlas: true });
    const groups = chips.map((c) => c.group);
    // Each group in one run, in that order; languages, countries, decades and ratings last.
    expect([...new Set(groups)]).toEqual([
      'for-you',
      'mood',
      'recipe',
      'genre',
      'language',
      'country',
      'region',
      'decade',
      'rating',
    ]);
    const of = (group: string) => chips.filter((c) => c.group === group).map((c) => c.id);
    // atlas's own order: its strongest rows lead, moods and plot facets together.
    expect(of('mood').slice(0, 3)).toEqual(['mood-mind-bending', 'plot-unhappy', 'mood-feel-good']);
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

  it('finds a region by its label and the names people use for it', () => {
    const first = (text: string) =>
      browseChips(text, chips).map((c) => `${c.label} · ${KIND[c.group]}`)[0];
    expect(first('nordic')).toBe('Nordic · region');
    expect(first('scandi')).toBe('Scandinavian · region');
    expect(first('latin')).toBe('Latin American · region');
    expect(first('nollywood')).toBe('African · region');
    expect(labels(matchChips('asian', chips))).toEqual(
      expect.arrayContaining(['East Asian', 'Southeast Asian', 'South Asian']),
    );
  });

  it('finds a rating floor by its number and by the words for one', () => {
    expect(labels(browseChips('7+', chips))).toEqual(['★ 7+']);
    expect(labels(browseChips('rated', chips))).toEqual(['★ 6+', '★ 7+', '★ 8+']);
    expect(labels(browseChips('good', chips))[0]).toBe('★ 7+');
    expect(labels(browseChips('great', chips))[0]).toBe('★ 8+');
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
    expect(remapChip('plot-nonlinear', 'movie', 'tv', tv)).toBe(FOR_YOU);
    // A recipe and a mood both types have stay open.
    expect(remapChip('recipe-heist', 'movie', 'tv', tv)).toBe('recipe-heist');
    expect(remapChip('mood-feel-good', 'movie', 'tv', tv)).toBe('mood-feel-good');
    expect(remapChip('plot-unhappy', 'movie', 'tv', tv)).toBe('plot-unhappy');
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

  it('offer no second value of a one-value kind: it is removed before another is picked', () => {
    const set = ['lang-sv', 'country-SE', 'decade-1990', 'rating-7', 'genre-35'];
    for (const other of ['lang-en', 'country-DK', 'decade-2000', 'rating-8'])
      expect(offered(set, other, 'movie')).toBe(false);
    // Genres stack.
    expect(offered(set, 'genre-18', 'movie')).toBe(true);
    // One mood at a time, and one "Like".
    expect(offered(['mood-cozy'], 'mood-dark', 'movie')).toBe(false);
    expect(offered(['like-movie-949'], 'like-movie-680', 'movie')).toBe(false);
    // Taken out, the kind is open again.
    expect(offered(['genre-35'], 'lang-en', 'movie')).toBe(true);
  });

  it('where atlas’s filter answers, take a second value of a kind beside the first, as either-or', () => {
    const set = ['lang-sv', 'country-SE', 'decade-1990', 'mood-cozy', 'genre-35', 'rating-7'];
    for (const other of ['lang-da', 'country-DK', 'decade-2000', 'mood-dark', 'genre-18']) {
      expect(offered(set, other, 'movie', true), other).toBe(true);
      expect(applyPick(set, other, 'movie', true)).toEqual({ set: [...set, other], removed: [] });
    }
    // One rating floor, one "Like", one recipe.
    expect(offered(set, 'rating-8', 'movie', true)).toBe(false);
    expect(offered(['like-movie-949'], 'like-movie-680', 'movie', true)).toBe(false);
    expect(applyPick(['recipe-heist'], 'recipe-k-drama', 'tv', true).removed).toEqual([
      'recipe-heist',
    ]);
    // Never judged empty beside its kind's pick: it can only widen the grid.
    const counts: FacetCounts = {
      country: { complete: true, values: { SE: 4 } },
      language: { complete: true, values: { sv: 4 } },
    };
    const chips = exploreChips('movie', { atlas: true });
    const empty = emptyOptions(['country-SE'], [], false, chips, {
      counts,
      type: 'movie',
      filtered: true,
    });
    expect(empty.has('country-DK')).toBe(false);
    expect(empty.has('lang-da')).toBe(true);
  });

  it('show a kind’s values side by side, each after the first as "or"', () => {
    const kind = (id: string) => id.slice(0, id.indexOf('-'));
    expect(
      pillOrder(['country-SE', 'genre-35', 'country-DK', 'like-movie-1'], (id) =>
        id.startsWith('like-') ? undefined : kind(id),
      ),
    ).toEqual([
      { id: 'country-SE', or: false },
      { id: 'country-DK', or: true },
      { id: 'genre-35', or: false },
      { id: 'like-movie-1', or: false },
    ]);
  });

  it('take a "Like" as one feed: it replaces a mood or another "Like", and takes no country or recipe', () => {
    expect(applyPick(['mood-cozy', 'genre-35'], 'like-movie-949', 'movie')).toEqual({
      set: ['genre-35', 'like-movie-949'],
      removed: ['mood-cozy'],
    });
    expect(applyPick(['like-movie-949'], 'like-movie-680', 'movie')).toEqual({
      set: ['like-movie-680'],
      removed: ['like-movie-949'],
    });
    expect(applyPick(['country-SE', 'recipe-heist'], 'like-movie-949', 'movie').set).toEqual([
      'like-movie-949',
    ]);
    // Language, decade, genre and rating narrow it.
    expect(
      applyPick(['lang-sv', 'decade-1990', 'genre-35', 'rating-7'], 'like-movie-949', 'movie')
        .removed,
    ).toEqual([]);
    expect(facetQuery(['like-movie-949', 'genre-35'], 'movie')).toBeUndefined();
  });

  it('take a rating beside anything but a mood, whose titles carry none', () => {
    expect(offered(['mood-cozy'], 'rating-7', 'movie')).toBe(false);
    expect(offered(['like-movie-949'], 'rating-7', 'movie')).toBe(true);
    expect(applyPick(['rating-7'], 'mood-cozy', 'movie').removed).toEqual(['rating-7']);
  });

  it('keep a "Like" across a type switch only for a title of that type', () => {
    const chips = exploreChips('tv');
    expect(remapSet(['like-tv-1396', 'genre-35'], 'tv', 'tv', chips).set).toEqual([
      'like-tv-1396',
      'genre-35',
    ]);
    expect(remapSet(['like-movie-949'], 'movie', 'tv', chips)).toEqual({
      set: [],
      dropped: ['like-movie-949'],
    });
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

  it('ask TMDB for any of a region’s countries, or for the country alone where one is picked too', () => {
    expect(discoverParams(facetQuery(['region-nordic', 'genre-28'], 'movie')!)).toEqual({
      sort_by: 'popularity.desc',
      include_adult: 'false',
      with_genres: '28',
      with_origin_country: 'SE|NO|DK|FI|IS',
      'vote_count.gte': '30',
    });
    const both = discoverParams(facetQuery(['region-nordic', 'country-SE'], 'movie')!);
    expect(both.with_origin_country).toBe('SE');
    // One region at a time, beside a country; without atlas's filter a mood takes no region.
    expect(applyPick(['region-nordic'], 'region-slavic', 'movie').removed).toEqual([
      'region-nordic',
    ]);
    expect(offered(['region-nordic'], 'region-slavic', 'movie')).toBe(false);
    expect(applyPick(['region-nordic'], 'country-SE', 'movie').removed).toEqual([]);
    expect(applyPick(['mood-cozy'], 'region-nordic', 'movie').removed).toEqual(['mood-cozy']);
    expect(applyPick(['mood-cozy'], 'region-nordic', 'movie', true).removed).toEqual([]);
    // A recipe's own countries rule out a region that names none of them.
    expect(offered(['recipe-k-drama'], 'region-east-asian', 'tv')).toBe(true);
    expect(offered(['recipe-k-drama'], 'region-nordic', 'tv')).toBe(false);
  });

  it('ask TMDB for a rating floor on the ★ posters show, on 10 votes in place of the usual floor', () => {
    const rated = discoverParams(facetQuery(['genre-35', 'rating-7'], 'movie')!);
    expect(rated['vote_average.gte']).toBe('7');
    expect(rated.with_genres).toBe('35');
    expect(rated['vote_count.gte']).toBe('10');
    // A decade's floor of 50 would leave Swedish 2020s romantic comedies at ★ 6+ with one title; 10 leaves two.
    const swedish = ['lang-sv', 'decade-2020', 'genre-35', 'genre-10749'];
    expect(discoverParams(facetQuery(swedish, 'movie')!)['vote_count.gte']).toBe('50');
    expect(discoverParams(facetQuery([...swedish, 'rating-6'], 'movie')!)['vote_count.gte']).toBe(
      '10',
    );
    // A recipe's own, higher floor stays.
    const heist = facetQuery(['recipe-heist', 'rating-8'], 'movie')!;
    expect(heist.voteAverageGte).toBe(8);
    expect(heist.voteCountGte).toBe(100);
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
    // A second language isn't offered beside Swedish at all (`taken`): nothing loaded is judged against it.
    expect(empty.has('lang-en')).toBe(false);
    // A rating is judged like a genre: nothing loaded here is rated at all.
    expect(empty.has('rating-8')).toBe(true);
    expect(emptyOptions([], loaded, true, chips).size).toBe(0);
  });

  it('judges a "Like" or a mood by what has loaded so far, and gives an option back once a match loads', () => {
    const like = ['like-movie-949'];
    // Loading, nothing drawn yet: nothing is judged.
    expect(emptyOptions(like, [], false, chips).size).toBe(0);
    const first = [{ ...film(1), genreIds: [80, 18], originalLanguage: 'en', year: 1995 }];
    const empty = emptyOptions(like, first, false, chips);
    expect(empty.has('genre-28')).toBe(true);
    expect(empty.has('genre-80')).toBe(false);
    expect(empty.has('lang-sv')).toBe(true);
    expect(empty.has('decade-1990')).toBe(false);
    // A later page brings an action film: Action is back.
    const more = [...first, { ...film(2), genreIds: [28], originalLanguage: 'en', year: 2001 }];
    expect(emptyOptions(like, more, false, chips).has('genre-28')).toBe(false);
    // A mood the same way.
    expect(emptyOptions(['mood-cozy'], first, false, chips).has('genre-28')).toBe(true);
    // A TMDB feed still waits for its end.
    expect(emptyOptions(['country-SE'], first, false, chips).size).toBe(0);
  });
});

describe('the kinds only atlas’s filter knows', () => {
  const counts: FilterCounts = {
    total: 9,
    ignored: [],
    kindsUnavailable: ['warning'],
    kinds: {
      person: {
        mode: 'and',
        complete: false,
        values: { Q1: 2, Q2: 7 },
        labels: { Q1: 'Ann', Q2: 'Bob' },
      },
      technique: { mode: 'and', complete: true, values: { live_action: 9, 'hand drawn': 1 } },
      runtime: { mode: 'single', complete: true, values: { 'under-90': 3 } },
      cast: {
        mode: 'and',
        complete: false,
        values: { Q3: 1 },
        labels: { Q3: 'Cy' },
        selected: ['Q3'],
      },
      studio: {
        mode: 'and',
        complete: true,
        values: { Q159846: 4 },
        labels: { Q159846: 'A24' },
      },
    },
  };

  it('lists each kind’s values from the counts, most titles first, named by atlas where it names them', () => {
    const chips = filterChips(counts);
    expect(chips.filter((c) => c.group === 'people').map((c) => [c.id, c.label])).toEqual([
      ['person-Q2', 'Bob'],
      ['person-Q1', 'Ann'],
      // A cast member is listed only because it is picked: its pill's name.
      ['cast-Q3', 'Cy'],
    ]);
    expect(chips.find((c) => c.id === 'technique-live_action')?.label).toBe('Live action');
    // An id the address can't carry isn't offered.
    expect(chips.some((c) => c.id.includes('hand'))).toBe(false);
    expect(chips.find((c) => c.id === 'runtime-under-90')?.label).toBe('Under 90 min');
    expect(chips.find((c) => c.id === 'studio-Q159846')).toMatchObject({
      label: 'A24',
      group: 'studio',
    });
  });

  it('names a pick before the counts do', () => {
    expect(pendingChip('person-Q9')?.label).toBe('Person…');
    expect(pendingChip('runtime-over-150')?.label).toBe('Over 150 min');
    expect(pendingChip('genre-28')).toBeUndefined();
  });

  it('stacks people, holds one runtime, and lets atlas’s filter mix what it knows', () => {
    expect(applyPick(['person-Q1'], 'person-Q2', 'movie').set).toEqual(['person-Q1', 'person-Q2']);
    expect(applyPick(['runtime-under-90'], 'runtime-over-150', 'movie').removed).toEqual([
      'runtime-under-90',
    ]);
    // Without the filter a mood takes no country; with it, they stand together.
    expect(applyPick(['mood-cozy'], 'country-SE', 'movie').removed).toEqual(['mood-cozy']);
    expect(applyPick(['mood-cozy'], 'country-SE', 'movie', true).removed).toEqual([]);
    // A recipe atlas has no form of still can't stand beside a kind only atlas knows.
    expect(applyPick(['person-Q1'], 'recipe-nordic-noir', 'movie', true).removed).toEqual([
      'person-Q1',
    ]);
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

  it('asks a seed that failed again when For You starts over, and leads with it then', async () => {
    let down = true;
    const flaky: Pages = async (path, type, params, page) => {
      if (down && path.endsWith('/recommendations')) throw new Error('offline');
      return pages(path, type, params, page);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const row = exploreFeed([], 'movie', { ...sources([film(1)]), pages: flaky });
      expect((await row.load(1)).map((t) => t.id)).toEqual([100]);
      expect(
        (await row.load(2)).map((t) => t.id),
        'the tail, not a page skipped',
      ).toEqual([200]);
      down = false;
      expect((await row.load(1)).map((t) => t.id)).toEqual([1001]);
      expect((await row.load(2)).map((t) => t.id)).toEqual([100]);
    } finally {
      warn.mockRestore();
    }
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

  it('asks atlas’s filter for the whole selection, and narrows nothing more itself', async () => {
    const asked: string[] = [];
    const row = exploreFeed(['mood-cozy', 'genre-35', 'country-SE', 'rating-7'], 'movie', {
      ...sources(),
      atlas: '/atlas',
      fetchImpl: (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(
          JSON.stringify(
            String(input).includes('/metadata')
              ? { titles: [] }
              : {
                  titles: [{ type: 'movie', id: 5, title: 'Five', posterPath: '/5.jpg' }],
                  order: 'o',
                },
          ),
        );
      }) as typeof fetch,
    });
    expect((await row.load(1)).map((t) => t.id)).toEqual([5]);
    expect(asked[0]).toBe(
      '/atlas/index/filter/movie/titles.json?sel=country:SE,genre:35,mood:Cozy,rating:7',
    );
    expect(row.filter?.({ ...film(9), genreIds: [18] })).toBe(true);
  });

  it('narrows a mood by the genre, language and decade beside it, where atlas has no filter', async () => {
    const row = exploreFeed(['mood-cozy', 'genre-35', 'lang-sv', 'decade-1990'], 'movie', {
      ...sources(),
      atlas: '/atlas',
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    // The filter's 404 hands over to atlas's row (unreachable here too).
    await row.load(1).catch(() => {});
    const title = { ...film(1), genreIds: [35, 18], originalLanguage: 'sv', year: 1994 };
    expect(row.filter?.(title)).toBe(true);
    expect(row.filter?.({ ...title, genreIds: [18] })).toBe(false);
    expect(row.filter?.({ ...title, originalLanguage: 'en' })).toBe(false);
    expect(row.filter?.({ ...title, year: 2001 })).toBe(false);
  });

  it('keeps a recipe atlas has no form of on TMDB, asking atlas nothing', async () => {
    calls.length = 0;
    const asked: string[] = [];
    await exploreFeed(['recipe-nordic-noir'], 'movie', {
      ...sources(),
      atlas: '/atlas',
      fetchImpl: (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response('', { status: 404 });
      }) as typeof fetch,
    }).load(1);
    expect(asked).toEqual([]);
    expect(calls[0]?.path).toBe('/discover/movie');
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

  it('is the title page’s "More like this" for a "Like", as deep as atlas keeps, narrowed beside it', async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const row = exploreFeed(['like-movie-949', 'genre-80', 'rating-7'], 'movie', {
        ...sources(),
        atlas: '/atlas',
        key: 'k',
      });
      expect(row.id).toBe('facets-genre-80+like-movie-949+rating-7-movie');
      await row.load(1);
      // atlas's filter first; with no such route, the title page's own "More like this".
      expect(asked[0]).toBe('/atlas/index/filter/movie/titles.json?sel=genre:80,like:949,rating:7');
      expect(asked[1]).toBe('/atlas/index/similar/movie/949.json?limit=200');
      // atlas has nothing for it: TMDB's recommendations, from their first page.
      expect(asked.some((url) => url.includes('/movie/949/recommendations'))).toBe(true);
      const title = { ...film(1), genreIds: [80, 18], rating: 7.6, votes: 4000 };
      expect(row.filter?.(title)).toBe(true);
      expect(row.filter?.({ ...title, genreIds: [18] })).toBe(false);
      expect(row.filter?.({ ...title, rating: 6.9 })).toBe(false);
      // A rating on a handful of votes isn't one.
      expect(row.filter?.({ ...title, votes: 3 })).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('All: films and series together', () => {
  const all = exploreChips('all', { atlas: true });
  const tv = exploreChips('tv', { atlas: true });
  const movie = exploreChips('movie', { atlas: true });
  const ids = (chips: { id: string; group: string }[], group: string) =>
    chips.filter((c) => c.group === group).map((c) => c.id);

  it('offers the films’ genres by their names, series-only ones under Series alone, and either type’s recipes and moods', () => {
    expect(ids(all, 'genre')).toEqual(ids(movie, 'genre'));
    expect(all.find((c) => c.id === 'genre-878')?.label).toBe('Science Fiction');
    for (const kids of ['genre-10762', 'genre-10763', 'genre-10764', 'genre-10766', 'genre-10767'])
      expect(ids(all, 'genre')).not.toContain(kids);
    expect(ids(tv, 'genre')).toContain('genre-10762');
    // A film-only recipe and a series-native one; a film-only mood and a series-only one.
    expect(ids(all, 'recipe')).toEqual(
      expect.arrayContaining(['recipe-romantic-comedy', 'recipe-k-drama']),
    );
    expect(ids(all, 'mood')).toEqual(expect.arrayContaining(['plot-nonlinear', 'mood-bingeable']));
    expect(all.filter((c) => c.id === 'mood-feel-good')).toHaveLength(1);
  });

  it('moves the selection across the toggle by the closest counterparts, saying what couldn’t come', () => {
    // All to Series: a genre to its series counterpart, a film-only recipe dropped.
    expect(remapSet(['genre-28', 'genre-27', 'recipe-sci-fi-horror'], 'all', 'tv', tv)).toEqual({
      set: ['genre-10759', 'genre-10765'],
      dropped: ['recipe-sci-fi-horror'],
    });
    // Series to All: a series-only genre comes as its film counterpart; a series mood stays.
    expect(remapSet(['genre-10762', 'mood-bingeable'], 'tv', 'all', all)).toEqual({
      set: ['genre-10751', 'mood-bingeable'],
      dropped: [],
    });
    // All and Movies share the genres; a series "Like" and a series mood don't go to Movies.
    expect(remapSet(['genre-28', 'like-tv-1396', 'mood-bingeable'], 'all', 'movie', movie)).toEqual(
      { set: ['genre-28'], dropped: ['like-tv-1396', 'mood-bingeable'] },
    );
    // Under All a "Like" of either type stays.
    expect(remapSet(['like-tv-1396'], 'tv', 'all', all).set).toEqual(['like-tv-1396']);
    expect(remapChip('genre-10765', 'tv', 'all', all)).toBe('genre-878');
  });

  it('asks each type for the selection as its own feed would, leaving out a type with no form of a pick', () => {
    const [films, series] = perType(['genre-28', 'genre-12', 'country-SE']);
    expect(films).toEqual({
      type: 'movie',
      set: ['genre-28', 'genre-12', 'country-SE'],
      dropped: [],
    });
    expect(series).toEqual({ type: 'tv', set: ['genre-10759', 'country-SE'], dropped: [] });
    // Horror has no series form, a network no film one, Romantic Comedy no series one.
    expect(perType(['genre-27'])[1]?.dropped).toEqual(['genre-27']);
    expect(perType(['network-Q1'])[0]?.dropped).toEqual(['network-Q1']);
    expect(perType(['network-Q1'])[1]?.set).toEqual(['network-Q1']);
    expect(perType(['recipe-romantic-comedy'])[1]?.dropped).toEqual(['recipe-romantic-comedy']);
  });

  it('interleaves two feeds page by page, each title once, each narrowed by its own type’s filter', async () => {
    const m = (id: number) => film(id);
    const t = (id: number) => film(id, 'tv');
    const films: Title[][] = [[m(1), m(2)], [m(2), m(3)], [m(4)], []];
    const series: Title[][] = [[t(1)], []];
    const row = interleaveFeeds('mixed', [
      {
        type: 'movie',
        row: {
          id: 'm',
          title: '',
          load: async (p) => films[p - 1] ?? [],
          filter: (x) => x.id !== 3,
        },
      },
      { type: 'tv', row: { id: 't', title: '', load: async (p) => series[p - 1] ?? [] } },
    ]);
    const keys = (titles: Title[]) => titles.map((x) => `${x.type}:${x.id}`);
    // A film and a series with one id are two titles.
    expect(keys(await row.load(1))).toEqual(['movie:1', 'tv:1', 'movie:2']);
    // Series ran out; films go on, the repeat given once.
    expect(keys(await row.load(2))).toEqual(['movie:3']);
    expect(keys(await row.load(3))).toEqual(['movie:4']);
    expect(await row.load(4)).toEqual([]);
    // The films' filter judges films only.
    expect(row.filter?.(m(3))).toBe(false);
    expect(row.filter?.(t(3))).toBe(true);
  });

  it('goes on with one type when the other fails, and fails only when both do', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken = {
        id: 'b',
        title: '',
        load: async () => {
          throw new Error('down');
        },
      };
      const half = interleaveFeeds('half', [
        { type: 'movie', row: broken },
        { type: 'tv', row: { id: 't', title: '', load: async () => [film(7, 'tv')] } },
      ]);
      expect((await half.load(1)).map((x) => x.type)).toEqual(['tv']);
      const none = interleaveFeeds('none', [
        { type: 'movie', row: broken },
        { type: 'tv', row: { ...broken, id: 'b2' } },
      ]);
      await expect(none.load(1)).rejects.toThrow('down');
    } finally {
      warn.mockRestore();
    }
  });

  it('asks a side for the page it failed on again, and starts over from the first page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const asked: number[] = [];
      let fail = true;
      const flaky = {
        id: 'f',
        title: '',
        load: async (p: number) => {
          asked.push(p);
          if (p === 2 && fail) {
            fail = false;
            throw new Error('blip');
          }
          return p <= 3 ? [film(p)] : [];
        },
      };
      const steady = { id: 's', title: '', load: async (p: number) => [film(p, 'tv')] };
      const row = interleaveFeeds('mixed', [
        { type: 'movie', row: flaky },
        { type: 'tv', row: steady },
      ]);
      const keys = (titles: Title[]) => titles.map((x) => `${x.type}:${x.id}`);
      expect(keys(await row.load(1))).toEqual(['movie:1', 'tv:1']);
      expect(keys(await row.load(2)), 'films failed once').toEqual(['tv:2']);
      expect(keys(await row.load(3)), 'and page 2 is asked again').toEqual(['movie:2', 'tv:3']);
      expect(asked).toEqual([1, 2, 2]);
      expect(keys(await row.load(1)), 'a new start').toEqual(['movie:1', 'tv:1']);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A side that failed was asked again at once, in the same request, and ended on a second failure a moment later;
   * and once titles had been given, both sides failing ended the feed quietly, with no Try again.
   */
  it('asks a failed side again at the next request, and fails a request both sides failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const asked: number[] = [];
      let down = false;
      const flaky = {
        id: 'f',
        title: '',
        load: async (p: number) => {
          asked.push(p);
          if (down) throw new Error('blip');
          return p <= 3 ? [film(p)] : [];
        },
      };
      const short = {
        id: 's',
        title: '',
        load: async (p: number) => (p === 1 ? [film(1, 'tv')] : []),
      };
      const row = interleaveFeeds('mixed', [
        { type: 'movie', row: flaky },
        { type: 'tv', row: short },
      ]);
      const keys = (titles: Title[]) => titles.map((x) => `${x.type}:${x.id}`);
      expect(keys(await row.load(1))).toEqual(['movie:1', 'tv:1']);
      down = true;
      await expect(row.load(2), 'nothing to give: Try again').rejects.toThrow('blip');
      expect(asked, 'asked once, not again at once').toEqual([1, 2]);
      await expect(row.load(2)).rejects.toThrow('blip');
      down = false;
      expect(keys(await row.load(2)), 'Try again asks once more').toEqual(['movie:2']);

      const broken = (type: MediaType) => ({
        id: type,
        title: '',
        load: async (p: number) => {
          if (p > 1) throw new Error('down');
          return [film(9, type)];
        },
      });
      const both = interleaveFeeds('both', [
        { type: 'movie', row: broken('movie') },
        { type: 'tv', row: broken('tv') },
      ]);
      expect(await both.load(1)).toHaveLength(2);
      await expect(both.load(2)).rejects.toThrow('down');
    } finally {
      warn.mockRestore();
    }
  });

  const answering = (asked: string[], body: (url: string) => unknown) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/metadata')) return new Response(JSON.stringify({ titles: [] }));
      asked.push(url);
      const answer = body(url);
      return answer === undefined
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify(answer));
    }) as typeof fetch;
  const pages: Pages = async (path, type, _params, page) =>
    path.includes('recommendations') ? [] : [film(page * 100, type)];
  const base = { pages, seeds: [], owned: new Set<string>() };

  it('asks atlas for both types at once, a series card staying a series', async () => {
    const asked: string[] = [];
    const row = exploreFeed(['genre-35'], 'all', {
      ...base,
      atlas: '/atlas',
      fetchImpl: answering(asked, () => ({
        titles: [
          { type: 'movie', id: 5, title: 'Five', posterPath: '/5.jpg' },
          { type: 'series', id: 6, title: 'Six', posterPath: '/6.jpg' },
        ],
        order: 'o',
        ignored: [],
      })),
    });
    expect((await row.load(1)).map((x) => `${x.type}:${x.id}`)).toEqual(['movie:5', 'tv:6']);
    expect(asked).toEqual(['/atlas/index/filter/all/titles.json?sel=genre:35']);
  });

  it('where atlas has no `all` route, is each type’s own feed interleaved', async () => {
    const asked: string[] = [];
    const discovered: string[] = [];
    const row = exploreFeed(['genre-28'], 'all', {
      ...base,
      pages: async (path, type, params, page) => {
        discovered.push(`${path}?${params.with_genres}`);
        return pages(path, type, params, page);
      },
      atlas: '/atlas',
      fetchImpl: answering(asked, () => undefined),
    });
    expect((await row.load(1)).map((x) => `${x.type}:${x.id}`)).toEqual(['movie:100', 'tv:100']);
    expect(asked).toEqual([
      '/atlas/index/filter/all/titles.json?sel=genre:28',
      '/atlas/index/filter/movie/titles.json?sel=genre:28',
      '/atlas/index/filter/series/titles.json?sel=genre:10759',
    ]);
    // Each type's own discover, the series' by its own genre.
    expect(discovered).toEqual(['/discover/movie?28', '/discover/tv?10759']);
    expect((await row.load(2)).map((x) => `${x.type}:${x.id}`)).toEqual(['movie:200', 'tv:200']);
  });

  it('is For You of both types, and one type alone for a pick the other has no form of', async () => {
    const asked: string[] = [];
    const forYou = exploreFeed([], 'all', { ...base, atlas: null });
    expect(forYou.id).toBe(`${FOR_YOU}-all`);
    expect((await forYou.load(1)).map((x) => `${x.type}:${x.id}`)).toEqual(['movie:100', 'tv:100']);
    const horror = exploreFeed(['genre-27'], 'all', {
      ...base,
      atlas: '/atlas',
      fetchImpl: answering(asked, () => undefined),
    });
    expect((await horror.load(1)).map((x) => x.type)).toEqual(['movie']);
    // Not asked of both at once: atlas's `all` would count series it can't be.
    expect(asked).toEqual(['/atlas/index/filter/movie/titles.json?sel=genre:27']);
  });

  it('is a "Like"’s similar titles of both types, each judged by its own type’s genres', async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = answering(asked, () => undefined);
    try {
      const row = exploreFeed(['like-movie-949', 'genre-28'], 'all', {
        ...base,
        atlas: '/atlas',
        key: 'k',
        fetchImpl: globalThis.fetch,
      });
      await row.load(1);
      expect(asked[0]).toBe('/atlas/index/filter/all/titles.json?sel=genre:28,like:movie-949');
      expect(asked[1]).toBe('/atlas/index/similar/movie/949.json?limit=200');
      // Action, for a series, is Action & Adventure.
      expect(row.filter?.({ ...film(1, 'tv'), genreIds: [10759] })).toBe(true);
      expect(row.filter?.({ ...film(1, 'tv'), genreIds: [18] })).toBe(false);
      expect(row.filter?.({ ...film(1), genreIds: [28] })).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('hides an option only where both types’ counts say none, or a type has no form of it', () => {
    const films = { genre: { mode: 'and', complete: true, values: { '28': 3 } } } as FacetCounts;
    const series = {
      genre: { mode: 'and', complete: true, values: { '80': 2 } },
      language: { mode: 'and', complete: false, values: {} },
    } as FacetCounts;
    const both = [
      { type: 'movie' as const, counts: films },
      { type: 'tv' as const, counts: series },
    ];
    expect(countedEmptyAcross('genre-35', both)).toBe(true);
    expect(countedEmptyAcross('genre-28', both)).toBe(false);
    expect(countedEmptyAcross('genre-80', both)).toBe(false);
    // Horror: no series form, and no films of it counted.
    expect(countedEmptyAcross('genre-27', both)).toBe(true);
    // A kind listed incompletely, or a type that didn't answer, judges nothing.
    expect(countedEmptyAcross('lang-sv', both)).toBe(false);
    expect(countedEmptyAcross('genre-35', [both[0]!, { type: 'tv', counts: null }])).toBe(false);
    // emptyOptions takes the judgement as it takes one answer's counts.
    const empty = emptyOptions(['country-SE'], [], false, all, {
      counted: (id) => countedEmptyAcross(id, both),
      type: 'all',
    });
    expect(empty.has('genre-35')).toBe(true);
    expect(empty.has('genre-80')).toBe(false);
  });
});
