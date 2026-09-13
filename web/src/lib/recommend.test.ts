import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { nameSlides, recommend, recommendBody } from './recommend';
import { readPrefs } from './prefs';

const film = (id: number, extra: Partial<Title> = {}): Title => ({
  type: 'movie',
  id,
  title: `T${id}`,
  ...extra,
});

describe('recommendBody', () => {
  it('names series as atlas does, ranks only ranked lists, and carries the hide rules', () => {
    const prefs = {
      ...readPrefs(undefined),
      excludedGenres: new Set([27]),
      excludedLanguages: new Set(['hi']),
      hideAnime: true,
      minReleaseYear: 1990,
      services: [{ id: 8, country: 'FI' }],
    };
    const body = recommendBody({
      facet: 'tv',
      prefs,
      library: [{ ref: { type: 'tv', id: 1438 }, weight: 1.5, at: 7 }],
      owned: new Set(['tv:1438', 'movie:603', 'nonsense']),
      lists: [
        {
          titles: [film(1, { releaseDate: '2026-09-01', genreIds: [18], popularity: 9 })],
          ranked: true,
        },
        { titles: [film(2), film(3)], ranked: false },
      ],
      now: new Date('2026-09-12T00:00:00Z'),
    });
    expect(body.surface).toBe('series');
    expect(body.now).toBe('2026-09-12T00:00:00.000Z');
    expect(body.library).toEqual([{ type: 'series', id: 1438, weight: 1.5, at: 7 }]);
    expect(body.owned).toEqual([
      { type: 'series', id: 1438 },
      { type: 'movie', id: 603 },
    ]);
    expect(body.hide).toEqual({ minYear: 1990, genres: [27], languages: ['hi'], anime: true });
    expect(body.services).toEqual([{ id: 8, country: 'FI' }]);
    expect(body.candidates[0]).toMatchObject({
      type: 'movie',
      id: 1,
      rank: 0,
      of: 1,
      hint: { releaseDate: '2026-09-01', genreIds: [18], popularity: 9 },
    });
    expect(body.candidates[1]).not.toHaveProperty('rank');
    expect(body.candidates).toHaveLength(3);
  });
});

describe('recommend', () => {
  const answering = (status: number, body: unknown) => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { asked, fetchImpl };
  };
  const body = recommendBody({
    facet: null,
    prefs: readPrefs(undefined),
    library: [],
    owned: new Set(),
    lists: [],
  });

  it('posts to this page’s atlas and reads the slides back in Den’s names', async () => {
    const { asked, fetchImpl } = answering(200, {
      slides: [
        { type: 'series', id: 1438, imdbId: 'tt0306414' },
        { type: 'movie', id: 603, imdbId: 'nope' },
        { type: 'person', id: 1 },
      ],
    });
    expect(await recommend('/atlas/auto_nfx', body, fetchImpl)).toEqual([
      { type: 'tv', id: 1438, imdbId: 'tt0306414' },
      { type: 'movie', id: 603, imdbId: undefined },
    ]);
    expect(asked[0]!.url).toBe('/atlas/auto_nfx/recommend');
    expect(asked[0]!.init?.method).toBe('POST');
  });

  it('is nothing where atlas can’t rank, so the page ranks for itself', async () => {
    expect(
      await recommend('/atlas', body, answering(404, { error: 'not_found' }).fetchImpl),
    ).toBeNull();
    expect(await recommend('/atlas', body, answering(200, { nope: true }).fetchImpl)).toBeNull();
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await recommend('/atlas', body, offline)).toBeNull();
  });
});

describe('nameSlides', () => {
  it('keeps atlas’s order, names from the lists first, looks up the rest, and drops what TMDB can’t name', async () => {
    const looked: string[] = [];
    const titles = await nameSlides(
      [
        { type: 'movie', id: 2, imdbId: 'tt2' },
        { type: 'tv', id: 1 },
        { type: 'movie', id: 9 },
        { type: 'movie', id: 1 },
      ],
      new Map([['movie:1', film(1)]]),
      async (ref) => {
        looked.push(`${ref.type}:${ref.id}`);
        return ref.id === 9 ? null : { ...film(ref.id), type: ref.type };
      },
      2,
    );
    expect(titles.map((t) => `${t.type}:${t.id}`)).toEqual(['movie:2', 'tv:1', 'movie:1']);
    expect(titles[0]!.imdbId).toBe('tt2');
    expect(looked.sort()).toEqual(['movie:2', 'movie:9', 'tv:1']);
  });
});
