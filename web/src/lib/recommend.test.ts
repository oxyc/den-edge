import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import type { Prefs } from './prefs';
import {
  billboardScope,
  freshKept,
  memberPostOn,
  nameSlides,
  recommend,
  recommendationReason,
  recommendBody,
  recommendForEveryone,
  startBillboard,
  swapAfter,
  type KeptBillboard,
} from './recommend';

const film = (id: number, extra: Partial<Title> = {}): Title => ({
  type: 'movie',
  id,
  title: `T${id}`,
  ...extra,
});

describe('recommendForEveryone', () => {
  it('asks for the scope’s billboard for the UTC day with GET', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ slides: [{ type: 'series', id: 1438 }] }));
    }) as unknown as typeof fetch;
    const slides = await recommendForEveryone(
      '/atlas',
      billboardScope('tv'),
      new Date('2026-09-28T23:30:00-03:00'),
      fetchImpl,
    );
    expect(slides).toEqual([{ type: 'tv', id: 1438, imdbId: undefined, why: undefined }]);
    expect(asked[0]!.url).toBe('/atlas/recommend/series.json?day=2026-09-29');
    expect(asked[0]!.init?.method ?? 'GET').toBe('GET');
    expect(billboardScope(null)).toBe('home');
  });

  it('returns nothing where atlas cannot rank', async () => {
    const unavailable = (async () =>
      new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const malformed = (async () => new Response('{}')) as unknown as typeof fetch;
    expect(await recommendForEveryone('/atlas', 'home', new Date(), unavailable)).toBeNull();
    expect(await recommendForEveryone('/atlas', 'home', new Date(), malformed)).toBeNull();
  });

  it('takes the billboard the app started asking for once', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ slides: [{ type: 'movie', id: asked.length }] }));
    }) as unknown as typeof fetch;
    const now = new Date('2026-09-28T12:00:00Z');
    startBillboard('/movies', false, now, fetchImpl);
    startBillboard('/watchlist', false, now, fetchImpl);
    expect(asked).toEqual(['/atlas/recommend/movies.json?day=2026-09-28']);
    expect((await recommendForEveryone('/atlas', 'movies', now, fetchImpl))?.[0]?.id).toBe(1);
    expect(asked).toHaveLength(1);
    await recommendForEveryone('/atlas', 'movies', now, fetchImpl);
    expect(asked).toHaveLength(2);
  });

  it('starts nothing for a paired browser, whose Home asks its own atlas install', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ slides: [{ type: 'movie', id: 1 }] }));
    }) as unknown as typeof fetch;
    const now = new Date('2026-09-28T12:00:00Z');
    startBillboard('/', true, now, fetchImpl);
    expect(asked).toEqual([]);
    await recommendForEveryone('/atlas/us_8', 'home', now, fetchImpl);
    expect(asked).toEqual(['/atlas/us_8/recommend/home.json?day=2026-09-28']);
  });
});

describe('memberPostOn', () => {
  const storage = () => {
    const kept = new Map<string, string>();
    return {
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, value: string) => void kept.set(name, value),
    };
  };

  it('is off until this browser turns it on, and the parameter is remembered', () => {
    const kept = storage();
    expect(memberPostOn('', kept)).toBe(false);
    expect(memberPostOn('?billboard-post=1', kept)).toBe(true);
    expect(memberPostOn('', kept)).toBe(true);
    expect(memberPostOn('?billboard-post=0', kept)).toBe(false);
    expect(memberPostOn('', kept)).toBe(false);
  });

  it('reads the flag set by hand, and the parameter where storage refuses', () => {
    const kept = storage();
    kept.setItem('den.billboard.member-post', '1');
    expect(memberPostOn('', kept)).toBe(true);
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(memberPostOn('?billboard-post=1', refusing)).toBe(true);
    expect(memberPostOn('', refusing)).toBe(false);
  });
});

describe('recommend', () => {
  const prefs = {
    excludedGenres: new Set([27]),
    excludedLanguages: new Set(['ja']),
    hideAnime: true,
    minReleaseYear: 1990,
    services: [{ id: 8, country: 'US' }],
    servicesConfigured: true,
  } as unknown as Prefs;

  it('sends the whole library with what TMDB said of it, and nothing to rank it against', () => {
    const body = recommendBody({
      facet: 'tv',
      prefs,
      library: [
        { ref: { type: 'tv', id: 1438 }, weight: 1, at: 5 },
        { ref: { type: 'movie', id: 2 }, weight: -1.5, at: 9 },
      ],
      named: new Map([
        ['movie:2', film(2, { year: 2020, rating: 7, ratingSource: 'tmdb', votes: 10 })],
      ]),
      owned: new Set(['tv:1438', 'movie:2', 'bogus']),
      now: new Date('2026-09-30T12:00:00Z'),
    });
    expect(body).toEqual({
      version: 1,
      surface: 'series',
      now: '2026-09-30T12:00:00.000Z',
      services: [{ id: 8, country: 'US' }],
      library: [
        {
          type: 'movie',
          id: 2,
          weight: -1.5,
          at: 9,
          hint: expect.objectContaining({ title: 'T2', year: 2020, rating: 7, votes: 10 }),
        },
        { type: 'series', id: 1438, weight: 1, at: 5 },
      ],
      owned: [
        { type: 'series', id: 1438 },
        { type: 'movie', id: 2 },
      ],
      hide: { minYear: 1990, genres: [27], languages: ['ja'], anime: true },
    });
    expect(body).not.toHaveProperty('candidates');
  });

  it('keeps a library past atlas’s limit to its most recent titles', () => {
    const library = Array.from({ length: 5001 }, (_, i) => ({
      ref: { type: 'movie' as const, id: i },
      weight: 1,
      at: i,
    }));
    const body = recommendBody({ facet: null, prefs, library, owned: new Set() });
    expect(body.library).toHaveLength(5000);
    expect(body.library.some((entry) => entry.id === 0)).toBe(false);
  });

  it('POSTs the body and reads atlas’s slides; null where atlas can’t rank', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const answering = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(
        JSON.stringify({ slides: [{ type: 'series', id: 7, why: { reason: 'profile' } }] }),
      );
    }) as unknown as typeof fetch;
    const body = recommendBody({ facet: null, prefs, library: [], owned: new Set() });
    expect(await recommend('/atlas/us_8', body, answering)).toEqual([
      { type: 'tv', id: 7, imdbId: undefined, why: { reason: 'profile' } },
    ]);
    expect(asked[0]!.url).toBe('/atlas/us_8/recommend');
    expect(asked[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(asked[0]!.init?.body))).toEqual(body);

    const failing = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    const unreachable = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await recommend('/atlas', body, failing)).toBeNull();
    expect(await recommend('/atlas', body, unreachable)).toBeNull();
  });
});

describe('freshKept', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const titles = [film(1)];

  it('opens the page with a kept ranking under a day old, and not otherwise', () => {
    expect(freshKept({ at: now - 60_000, titles }, now)).toEqual(titles);
    expect(freshKept({ at: now - 86_400_000 + 1, titles }, now)).toEqual(titles);
    expect(freshKept({ at: now - 86_400_000, titles }, now)).toBeNull();
    expect(freshKept({ at: now + 60_000, titles }, now)).toBeNull();
    expect(freshKept({ at: now, titles: [] }, now)).toBeNull();
    expect(freshKept(undefined, now)).toBeNull();
    // A bare list, as the shared billboard is kept, has no age to judge.
    expect(freshKept(titles as unknown as KeptBillboard, now)).toBeNull();
  });
});

describe('swapAfter', () => {
  const slides = (...ids: number[]) => ids.map((id) => film(id));
  const ids = (titles: Title[]) => titles.map((t) => t.id);

  it('never replaces the slide on screen or those before it', () => {
    const shown = slides(1, 2, 3, 4);
    expect(ids(swapAfter(shown, shown[1], slides(9, 2, 8, 1, 7)))).toEqual([1, 2, 9, 8, 7]);
    expect(ids(swapAfter(shown, shown[0], slides(9, 8)))).toEqual([1, 9, 8]);
    expect(ids(swapAfter(shown, shown[3], slides(9)))).toEqual([1, 2, 3, 4, 9]);
  });

  it('is the new ranking whole with nothing on screen', () => {
    expect(ids(swapAfter([], undefined, slides(9, 8)))).toEqual([9, 8]);
  });

  it('matches the slide by type and id, not by the object', () => {
    const shown = slides(1, 2, 3);
    expect(ids(swapAfter(shown, { type: 'movie', id: 2 }, slides(5)))).toEqual([1, 2, 5]);
    expect(ids(swapAfter(shown, { type: 'tv', id: 2 }, slides(5)))).toEqual([5]);
  });
});

describe('recommendationReason', () => {
  it.each([
    ['similar', 'Similar to what you watch'],
    ['profile', 'Fits your viewing taste'],
    ['people', 'Cast and creators you like'],
    ['franchise', 'From a franchise you like'],
    ['arrived', 'New on streaming'],
    ['recent', 'Recently released'],
    ['upcoming', 'Coming soon'],
    ['timely', 'New or coming soon'],
    ['quality', 'Highly rated'],
    ['buzz', 'Popular now'],
  ])('renders Atlas reason %s', (reason, copy) => {
    expect(recommendationReason({ reason })).toBe(copy);
  });

  it('stays silent for missing and unknown reason codes', () => {
    expect(recommendationReason(undefined)).toBeUndefined();
    expect(recommendationReason({ fit: 0.7 })).toBeUndefined();
    expect(recommendationReason({ reason: 'future-signal' })).toBeUndefined();
  });
});

describe('nameSlides', () => {
  it('keeps atlas order, names known titles, and drops what TMDB cannot name', async () => {
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

  it('carries why through naming', async () => {
    const why = { score: 0.8, fit: 0.7, reason: 'similar' };
    const titles = await nameSlides(
      [{ type: 'movie', id: 1, why }],
      new Map([['movie:1', film(1)]]),
      async () => null,
      1,
    );
    expect(titles).toEqual([{ ...film(1), imdbId: undefined, why }]);
  });
});
