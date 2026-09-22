import { describe, expect, it } from 'vitest';
import type { Pages } from './catalog';
import { exploreChips, exploreFeed, FOR_YOU, openChip, remapChip } from './explore';
import type { MediaType, Title } from './library';

const film = (id: number, type: MediaType = 'movie'): Title => ({ type, id, title: `T${id}` });

describe('Explore chips', () => {
  it('lead with For You, then the TV’s genre order, recipes with a form here, and moods', () => {
    const movies = exploreChips('movie', { atlas: true }).map((c) => c.id);
    expect(movies[0]).toBe(FOR_YOU);
    expect(movies.slice(1, 4)).toEqual(['genre-28', 'genre-35', 'genre-18']);
    expect(movies).toContain('recipe-sci-fi-horror');
    expect(movies).toContain('mood-cozy');

    const series = exploreChips('tv', { atlas: true }).map((c) => c.id);
    expect(series.slice(1, 3)).toEqual(['genre-10759', 'genre-35']);
    // Recipes with no series form are not offered under Series.
    expect(series).not.toContain('recipe-sci-fi-horror');
    expect(series).not.toContain('recipe-romantic-comedy');
    expect(series).toContain('recipe-heist');
    expect(series).toContain('mood-bingeable');
  });

  it('leave out hidden genres, and the moods where atlas can’t be reached', () => {
    const ids = exploreChips('movie', { hiddenGenres: new Set([27]) }).map((c) => c.id);
    expect(ids).not.toContain('genre-27');
    expect(ids.some((id) => id.startsWith('mood-'))).toBe(false);
  });

  it('fall back to For You for an id that names no chip', () => {
    const chips = exploreChips('movie');
    expect(openChip('genre-27', chips).id).toBe('genre-27');
    expect(openChip('genre-999', chips).id).toBe(FOR_YOU);
    expect(openChip(undefined, chips).id).toBe(FOR_YOU);
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
    expect(remapChip('mood-cozy', 'movie', 'tv', tv)).toBe(FOR_YOU);
    // A recipe and a mood both types have stay open.
    expect(remapChip('recipe-heist', 'movie', 'tv', tv)).toBe('recipe-heist');
    expect(remapChip('mood-feel-good', 'movie', 'tv', tv)).toBe('mood-feel-good');
  });

  it('keeps a hidden genre’s counterpart closed too', () => {
    const hidden = exploreChips('tv', { hiddenGenres: new Set([10759]) });
    expect(remapChip('genre-28', 'movie', 'tv', hidden)).toBe(FOR_YOU);
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
    const chip = openChip('genre-10765', exploreChips('tv'));
    const row = exploreFeed(chip, 'tv', { ...sources(), minYear: 1990 });
    await row.load(2);
    expect(calls[0]?.path).toBe('/discover/tv');
    expect(calls[0]?.params.with_genres).toBe('10765');
    expect(calls[0]?.params['first_air_date.gte']).toBe('1990-01-01');
    expect(calls[0]?.page).toBe(2);
    expect(row.filter?.({ ...film(1, 'tv'), genreIds: [10765] })).toBe(true);
  });

  it('browses a movie recipe as series under Series', async () => {
    calls.length = 0;
    const chip = openChip('recipe-heist', exploreChips('tv'));
    await exploreFeed(chip, 'tv', sources()).load(1);
    expect(calls[0]?.path).toBe('/discover/tv');
    expect(calls[0]?.params.with_genres).toBe('80');
    expect(calls[0]?.params.with_keywords).toBe('10051');
  });

  it('is For You: recommendations for the latest titles of this type, then the popular tail', async () => {
    calls.length = 0;
    const seeds = [film(1), film(2, 'tv'), film(3), film(4), film(5)];
    const row = exploreFeed(openChip(FOR_YOU, exploreChips('movie')), 'movie', sources(seeds));
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
    await exploreFeed(openChip(FOR_YOU, exploreChips('tv')), 'tv', sources()).load(1);
    expect(calls).toEqual([{ path: '/tv/top_rated', params: {}, page: 1 }]);
  });

  it('is atlas’s own row for a mood, and For You where atlas can’t be reached', () => {
    const chip = openChip('mood-cozy', exploreChips('movie', { atlas: true }));
    expect(exploreFeed(chip, 'movie', { ...sources(), atlas: '/atlas' }).id).toBe(
      'atlas-mood-cozy-movie',
    );
    expect(exploreFeed(chip, 'movie', sources()).id).toBe(`${FOR_YOU}-movie`);
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
      const chip = openChip('mood-cozy', exploreChips('movie', { atlas: true }));
      const row = exploreFeed(chip, 'movie', {
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
