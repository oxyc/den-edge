import { describe, expect, it } from 'vitest';
import { exploreChips, emptyOptions } from './explore';
import {
  countedEmpty,
  facetCountsUrl,
  facetParts,
  fetchFacetCounts,
  type FacetCounts,
} from './facetCounts';

describe('facetCountsUrl', () => {
  it('is the bare route for no selection, and the series path for series', () => {
    expect(facetCountsUrl('/atlas', 'movie', [])).toBe('/atlas/index/facets/movie.json');
    expect(facetCountsUrl('/atlas', 'tv', [])).toBe('/atlas/index/facets/series.json');
  });

  it('sorts by kind, then by value as a string, once each', () => {
    expect(
      facetCountsUrl('/atlas', 'tv', ['genre-18', 'country-SE', 'genre-10759', 'genre-18']),
    ).toBe('/atlas/index/facets/series.json?sel=country:SE,genre:10759,genre:18');
  });

  it('writes each kind as atlas does: a decade by its first year, a language lower, a country upper', () => {
    expect(facetCountsUrl('/atlas', 'movie', ['decade-1990', 'lang-sv', 'country-KR'])).toBe(
      '/atlas/index/facets/movie.json?sel=country:KR,decade:1990,language:sv',
    );
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
    expect(facetCountsUrl('/atlas', 'movie', ['subgenre-psychological-thriller'])).toBe(
      '/atlas/index/facets/movie.json?sel=subgenre:Psychological%20Thriller',
    );
  });

  it('asks for a recipe by the parts atlas knows, and nothing for the rest', () => {
    // Romantic Comedy is Comedy and Romance.
    expect(facetParts('recipe-romantic-comedy', 'movie')).toEqual([
      ['genre', '35'],
      ['genre', '10749'],
    ]);
    // K-Drama: Drama, Korean, from Korea.
    expect(facetParts('recipe-k-drama', 'tv')).toEqual([
      ['genre', '18'],
      ['language', 'ko'],
      ['country', 'KR'],
    ]);
    // Heist is Crime or Thriller, and a keyword: nothing atlas can count.
    expect(facetParts('recipe-heist', 'movie')).toEqual([]);
  });

  it('asks nothing for a selection bigger than atlas takes', () => {
    const genres = Array.from({ length: 17 }, (_, i) => `genre-${i + 1}`);
    expect(facetCountsUrl('/atlas', 'movie', genres)).toBeUndefined();
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

  it('hides a recipe when one of its parts has none', () => {
    // Romantic Comedy needs Comedy, which has none here.
    expect(countedEmpty('recipe-romantic-comedy', 'movie', counts)).toBe(true);
  });

  it('reads the per-kind shape, hiding only in a kind listed completely', () => {
    const shaped = {
      total: 40,
      genre: { mode: 'multi', complete: true, values: { '28': 12 } },
      language: { mode: 'single', complete: false, values: { sv: 4 } },
    } as unknown as FacetCounts;
    expect(countedEmpty('genre-35', 'movie', shaped)).toBe(true);
    expect(countedEmpty('genre-28', 'movie', shaped)).toBe(false);
    // An incomplete kind's missing value may simply not be listed.
    expect(countedEmpty('lang-en', 'movie', shaped)).toBe(false);
  });

  it('asks for a plot row by atlas’s own axes, never the old `structure` it redirects from', () => {
    expect(facetParts('plot-nonlinear', 'movie')).toEqual([['chronology', 'nonlinear']]);
    expect(facetParts('plot-single-day', 'movie')).toEqual([['timespan', 'single-day']]);
  });
});

describe('fetchFacetCounts', () => {
  const answering = (status: number, body: unknown, asked: string[] = []) =>
    (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('reads the counts at the canonical address', async () => {
    const asked: string[] = [];
    const counts = await fetchFacetCounts('/atlas', 'movie', ['genre-28', 'country-SE'], {
      fetchImpl: answering(200, { genre: { '28': 1 } }, asked),
    });
    expect(counts).toEqual({ genre: { '28': 1 } });
    expect(asked).toEqual(['/atlas/index/facets/movie.json?sel=country:SE,genre:28']);
  });

  it('has none to give where atlas has no such route, or fails', async () => {
    expect(
      await fetchFacetCounts('/atlas', 'movie', [], { fetchImpl: answering(404, {}) }),
    ).toBeNull();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchFacetCounts('/atlas', 'movie', [], { fetchImpl: failing })).toBeNull();
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

  it('never hides what would take over a pick’s slot', () => {
    const counts = { language: { sv: 9 } };
    const empty = emptyOptions(['lang-sv'], [], false, chips, { counts, type: 'movie' });
    expect(empty.has('lang-en')).toBe(false);
  });
});
