import { describe, expect, it } from 'vitest';
import { recipeParts } from './catalog';
import { exploreChips, emptyOptions } from './explore';
import {
  countedEmpty,
  countItems,
  facetParts,
  filterItems,
  groupKind,
  type FacetCounts,
} from './facetCounts';
import { filterUrl } from './filterRoutes';

describe('facetParts', () => {
  it('writes each kind as atlas does: a decade by its first year, a language lower, a country upper', () => {
    expect(
      filterUrl('/atlas', 'movie', 'counts', {
        items: countItems(['decade-1990', 'lang-sv', 'country-KR'], 'movie'),
      }),
    ).toBe('/atlas/index/filter/movie/counts.json?sel=country:KR,decade:1990,language:sv');
    expect(facetParts('decade-1995', 'movie')).toEqual([['decade', '1990']]);
  });

  it('asks for a mood by atlas’s own label, and a plot row by each of its axes', () => {
    expect(facetParts('mood-feel-good', 'movie')).toEqual([['mood', 'Feel-good']]);
    expect(facetParts('subgenre-psychological-thriller', 'movie')).toEqual([
      ['subgenre', 'Psychological Thriller'],
    ]);
    expect(facetParts('plot-slow-bleak', 'movie')).toEqual([
      ['pacing', 'slow-burn'],
      ['tone', 'bleak'],
    ]);
  });

  it('asks for a plot row by atlas’s own axes, never the old `structure` it redirects from', () => {
    expect(facetParts('plot-nonlinear', 'movie')).toEqual([['chronology', 'nonlinear']]);
    expect(facetParts('plot-single-day', 'movie')).toEqual([['timespan', 'single-day']]);
  });

  it('asks for a rating, a "Like" of this type, and the kinds only atlas knows by their ids', () => {
    expect(facetParts('rating-7', 'movie')).toEqual([['rating', '7']]);
    expect(facetParts('like-movie-949', 'movie')).toEqual([['like', '949']]);
    expect(facetParts('like-tv-1396', 'movie')).toEqual([]);
    expect(facetParts('person-Q25191', 'movie')).toEqual([['person', 'Q25191']]);
    expect(facetParts('studio-Q159846', 'movie')).toEqual([['studio', 'Q159846']]);
    expect(facetParts('runtime-under-90', 'movie')).toEqual([['runtime', 'under-90']]);
    expect(facetParts('technique-live_action', 'movie')).toEqual([['technique', 'live_action']]);
  });
});

describe('recipes in atlas’s terms', () => {
  it('are a subgenre where atlas has one, and their genres, language and country where that is all they are', () => {
    expect(recipeParts('heist', 'movie')).toEqual([['subgenre', 'Heist']]);
    expect(recipeParts('romantic-comedy', 'movie')).toEqual([['subgenre', 'Romantic Comedy']]);
    expect(recipeParts('k-drama', 'tv')).toEqual([
      ['genre', '18'],
      ['language', 'ko'],
      ['country', 'KR'],
    ]);
  });

  it('have no form there when they need keywords, several languages or countries, or genres left out', () => {
    for (const id of ['nordic-noir', 'korean-thriller', 'latin-american', 'pure-drama'])
      expect(recipeParts(id, 'movie'), id).toBeUndefined();
    // Counted, one still asks for what atlas can read of it.
    expect(facetParts('recipe-nordic-noir', 'movie')).toEqual([['genre', '80']]);
  });
});

describe('filterItems', () => {
  it('is the whole selection as one filter where every pick has a form there', () => {
    expect(
      filterItems(['country-SE', 'recipe-heist', 'person-Q25191', 'rating-7'], 'movie'),
    ).toEqual([
      { kind: 'country', id: 'SE' },
      { kind: 'subgenre', id: 'Heist' },
      { kind: 'person', id: 'Q25191' },
      { kind: 'rating', id: '7' },
    ]);
  });

  it('under All, names genres by the films’ ids, a "Like" of either type by its typed id, a mood of either', () => {
    expect(filterItems(['genre-28', 'like-tv-1396', 'recipe-k-drama'], 'all')).toEqual([
      { kind: 'genre', id: '28' },
      { kind: 'like', id: 'series-1396' },
      { kind: 'genre', id: '18' },
      { kind: 'language', id: 'ko' },
      { kind: 'country', id: 'KR' },
    ]);
    expect(facetParts('mood-bingeable', 'all')).toEqual([['mood', 'Bingeable']]);
    expect(facetParts('plot-nonlinear', 'all')).toEqual([['chronology', 'nonlinear']]);
  });

  it('is nothing where one pick has no form there', () => {
    expect(filterItems(['genre-80', 'recipe-nordic-noir'], 'movie')).toBeUndefined();
    expect(filterItems(['like-tv-1396'], 'movie')).toBeUndefined();
  });

  it('asks a kind’s picks as one either-or group, in its first pick’s place', () => {
    const set = ['country-FR', 'genre-18', 'country-IT', 'genre-28', 'decade-1980', 'decade-1990'];
    expect(filterItems(set, 'movie')).toEqual([
      { kind: 'country', id: 'FR|IT' },
      { kind: 'genre', id: '18|28' },
      { kind: 'decade', id: '1980|1990' },
    ]);
    expect(countItems(set, 'movie')).toEqual(filterItems(set, 'movie'));
    expect(filterUrl('/atlas', 'movie', 'titles', { items: filterItems(set, 'movie') })).toBe(
      '/atlas/index/filter/movie/titles.json?sel=country:FR|IT,decade:1980|1990,genre:18|28',
    );
  });

  it('keeps a recipe’s parts and a plot pair’s axes apart from a group, and never groups a rating', () => {
    // K-drama's drama AND Korean, beside Action: never "drama or action".
    expect(filterItems(['genre-28', 'recipe-k-drama'], 'tv')).toEqual([
      { kind: 'genre', id: '28' },
      { kind: 'genre', id: '18' },
      { kind: 'language', id: 'ko' },
      { kind: 'country', id: 'KR' },
    ]);
    expect(groupKind('recipe-heist', 'movie')).toBeUndefined();
    expect(groupKind('plot-slow-bleak', 'movie')).toBeUndefined();
    expect(groupKind('rating-7', 'movie')).toBeUndefined();
    expect(groupKind('mood-feel-good', 'movie')).toBe('mood');
    expect(filterItems(['rating-6', 'rating-7'], 'movie')).toEqual([
      { kind: 'rating', id: '6' },
      { kind: 'rating', id: '7' },
    ]);
  });
});

describe('countedEmpty', () => {
  const counts = { genre: { '28': 12, '18': 3 }, language: { sv: 4 } };

  it('hides a value missing from a kind the answer names', () => {
    expect(countedEmpty('genre-35', 'movie', counts)).toBe(true);
    expect(countedEmpty('genre-28', 'movie', counts)).toBe(false);
    expect(countedEmpty('lang-en', 'movie', counts)).toBe(true);
  });

  it('judges nothing of a kind the answer leaves out', () => {
    expect(countedEmpty('country-SE', 'movie', counts)).toBe(false);
    expect(countedEmpty('decade-1990', 'movie', counts)).toBe(false);
    expect(countedEmpty('recipe-heist', 'movie', counts)).toBe(false);
  });

  it('hides a recipe when its subgenre has none', () => {
    expect(countedEmpty('recipe-heist', 'movie', { subgenre: { Zombie: 2 } })).toBe(true);
  });

  it('reads atlas’s per-kind shape, hiding only in a kind listed completely', () => {
    const shaped = {
      genre: { mode: 'and', complete: true, values: { '28': 12 } },
      person: { mode: 'and', complete: false, values: { Q1: 4 } },
    } as FacetCounts;
    expect(countedEmpty('genre-35', 'movie', shaped)).toBe(true);
    expect(countedEmpty('genre-28', 'movie', shaped)).toBe(false);
    // An incomplete kind's missing value may simply not be in its top.
    expect(countedEmpty('person-Q2', 'movie', shaped)).toBe(false);
  });

  it('hides a region atlas lists no titles for, and none where it has no regions yet', () => {
    const regions = {
      region: { mode: 'single', complete: true, values: { nordic: 4 } },
    } as FacetCounts;
    expect(facetParts('region-east-asian', 'movie')).toEqual([['region', 'east-asian']]);
    expect(countedEmpty('region-nordic', 'movie', regions)).toBe(false);
    expect(countedEmpty('region-slavic', 'movie', regions)).toBe(true);
    expect(countedEmpty('region-slavic', 'movie', { genre: { '28': 1 } })).toBe(false);
  });
});

describe('emptyOptions with counts', () => {
  const chips = exploreChips('movie', { atlas: true });

  it('hides by the counts before the feed is loaded, and falls back to the feed without them', () => {
    const counts = { genre: { '28': 5 }, mood: { 'Feel-good': 2 } };
    const empty = emptyOptions(['country-SE'], [], false, chips, { counts, type: 'movie' });
    expect(empty.has('genre-35')).toBe(true);
    expect(empty.has('genre-28')).toBe(false);
    expect(empty.has('mood-cozy')).toBe(true);
    expect(empty.has('mood-feel-good')).toBe(false);
    // Countries weren't counted: nothing of them is judged.
    expect(empty.has('country-DK')).toBe(false);
    // No counts, nothing loaded: nothing hidden.
    expect(emptyOptions(['country-SE'], [], false, chips).size).toBe(0);
  });

  it('never judges a one-value kind against its own pick', () => {
    const counts = {
      language: { mode: 'and', complete: true, values: { sv: 9 } },
      decade: { mode: 'single', complete: true, values: { '1990': 3 } },
    } as FacetCounts;
    const empty = emptyOptions(['decade-1990'], [], false, chips, { counts, type: 'movie' });
    expect(empty.has('decade-1980')).toBe(false);
    expect(empty.has('lang-en')).toBe(true);
  });

  it('lets the counts decide alone where they answered, even over what has loaded', () => {
    const counts = { genre: { mode: 'and', complete: true, values: { '28': 5 } } } as FacetCounts;
    const loaded = [{ type: 'movie' as const, id: 1, title: 'A', genreIds: [18] }];
    const empty = emptyOptions(['mood-cozy'], loaded, true, chips, { counts, type: 'movie' });
    // Nothing loaded is action, but atlas counts five.
    expect(empty.has('genre-28')).toBe(false);
    // atlas's cards carry no rating: the counts don't list one, so none is judged.
    expect(empty.has('rating-7')).toBe(false);
  });
});
