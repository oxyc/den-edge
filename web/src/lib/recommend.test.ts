import { describe, expect, it, vi } from 'vitest';
import type { Title } from './library';
import {
  billboardScope,
  nameSlides,
  personalizeEveryone,
  recommendationReason,
  recommendForEveryone,
  startBillboard,
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
    startBillboard('/movies', now, fetchImpl);
    startBillboard('/watchlist', now, fetchImpl);
    expect(asked).toEqual(['/atlas/recommend/movies.json?day=2026-09-28']);
    expect((await recommendForEveryone('/atlas', 'movies', now, fetchImpl))?.[0]?.id).toBe(1);
    expect(asked).toHaveLength(1);
    await recommendForEveryone('/atlas', 'movies', now, fetchImpl);
    expect(asked).toHaveLength(2);
  });
});

describe('personalizeEveryone', () => {
  const slides = Array.from({ length: 20 }, (_, i) => ({ type: 'movie' as const, id: i + 1 }));

  it('keeps the shared prior, removes owned titles, and lifts fan matches without a POST', async () => {
    const asked: { url: string; method: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ mixed: [{ type: 'movie', id: 12 }] }));
    }) as unknown as typeof fetch;
    const ranked = await personalizeEveryone(
      '/atlas',
      slides,
      [{ ref: { type: 'tv', id: 1438 }, weight: 2, at: 9 }],
      new Set(['movie:20']),
      fetchImpl,
    );
    expect(ranked.some((slide) => slide.id === 20)).toBe(false);
    expect(ranked[0]?.id).toBe(12);
    expect(ranked.find((slide) => slide.id === 12)?.why?.reason).toBe('profile');
    expect(asked).toEqual([
      { url: '/atlas/index/suggest/series/1438.json?skip=0&limit=100', method: 'GET' },
    ]);
  });

  it('bounds fan lookups at four and degrades to the shared order', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const ranked = await personalizeEveryone(
      '/atlas',
      slides,
      Array.from({ length: 10 }, (_, i) => ({
        ref: { type: 'movie' as const, id: 100 + i },
        weight: 1,
        at: i,
      })),
      new Set(),
      fetchImpl,
    );
    expect(ranked).toEqual(slides);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('normalizes a ubiquitous fan match and applies dislikes instead of dropping them', async () => {
    const pool = Array.from({ length: 100 }, (_, i) => ({ type: 'movie' as const, id: i + 1 }));
    const fetchImpl = vi.fn(async (url: string) => {
      const disliked = url.includes('/109.json');
      return new Response(
        JSON.stringify({
          mixed: [
            { type: 'movie', id: 80 },
            { type: 'movie', id: disliked ? 12 : 81 },
            { type: 'movie', id: 80 }, // a malformed duplicate cannot multiply one seed's vote
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const ranked = await personalizeEveryone(
      '/atlas',
      pool,
      Array.from({ length: 10 }, (_, i) => ({
        ref: { type: 'movie' as const, id: 100 + i },
        weight: i === 9 ? -1.5 : 1,
        at: i,
      })),
      new Set(),
      fetchImpl,
    );
    expect(ranked[0]?.id).toBe(80);
    expect(ranked[0]?.why?.reason).toBe('profile');
    expect(ranked.findIndex((slide) => slide.id === 12)).toBeGreaterThan(11);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('does not call one bottom-of-row coincidence a personal match', async () => {
    const pool = Array.from({ length: 100 }, (_, i) => ({ type: 'movie' as const, id: i + 1 }));
    const mixed = Array.from({ length: 100 }, (_, i) => ({
      type: 'movie',
      id: i === 99 ? 80 : 200 + i,
    }));
    const ranked = await personalizeEveryone(
      '/atlas',
      pool,
      [{ ref: { type: 'movie', id: 500 }, weight: 1, at: 1 }],
      new Set(),
      (async () => new Response(JSON.stringify({ mixed }))) as unknown as typeof fetch,
    );
    expect(ranked[0]?.id).toBe(1);
    expect(ranked.find((slide) => slide.id === 80)?.why?.reason).toBeUndefined();
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
