import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Availability, KEPT_MS, RETRY_MS } from './availability.svelte';

const SCOUT = { install: 'http://192.168.86.193:8080/sealed-cfg', base: '/scout/sealed-cfg' };

/** Scout on this origin, and TMDB naming movie n `tt000000n` — except 404, which has no IMDb id. */
function fake(verdicts: () => Record<string, string>) {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === '/scout/sealed-cfg/availability') return json({ availability: verdicts() });
    const movie = /\/movie\/(\d+)\/external_ids/.exec(url)?.[1];
    if (movie) return json({ imdb_id: movie === '404' ? null : `tt${movie.padStart(7, '0')}` });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

describe('Availability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fades what scout says has nothing, asks again about what it was still checking, and skips series', async () => {
    let second = 'unknown';
    const { calls, fetchImpl } = fake(() => ({
      tt0000001: 'unavailable',
      tt0000002: second,
      tt0000003: 'available',
    }));
    const availability = new Availability(fetchImpl);
    availability.connect(SCOUT, 'key');
    for (const id of [1, 2, 3, 404]) availability.want({ type: 'movie', id });
    availability.want({ type: 'tv', id: 5 });
    await vi.advanceTimersByTimeAsync(100);

    const asked = () =>
      calls.filter((c) => c.url.endsWith('/availability')).map((c) => JSON.parse(c.body!).ids);
    expect(asked()).toEqual([['tt0000001', 'tt0000002', 'tt0000003']]);
    expect([1, 2, 3, 404].map((id) => availability.unavailable({ type: 'movie', id }))).toEqual([
      true,
      false,
      false,
      false,
    ]);

    second = 'unavailable';
    await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
    expect(asked()).toEqual([['tt0000001', 'tt0000002', 'tt0000003'], ['tt0000002']]);
    expect(availability.unavailable({ type: 'movie', id: 2 })).toBe(true);
  });

  it('fades what the last day found at once, still asks scout, and keeps its answer', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
    const now = 5 * KEPT_MS;
    data.set(
      'den.availability',
      JSON.stringify({ 1: ['unavailable', now - 1000], 2: ['unavailable', now - KEPT_MS - 1] }),
    );
    const { calls, fetchImpl } = fake(() => ({ tt0000001: 'available', tt0000002: 'available' }));
    const availability = new Availability(fetchImpl, storage, () => now);
    expect(availability.unavailable({ type: 'movie', id: 1 })).toBe(true);
    expect(availability.unavailable({ type: 'movie', id: 2 })).toBe(false);

    availability.connect(SCOUT, 'key');
    availability.want({ type: 'movie', id: 1 });
    availability.want({ type: 'movie', id: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.filter((c) => c.url.endsWith('/availability'))).toHaveLength(1);
    expect(availability.unavailable({ type: 'movie', id: 1 })).toBe(false);
    expect(JSON.parse(data.get('den.availability')!)).toEqual({
      1: ['available', now],
      2: ['available', now],
    });
  });

  it('asks TMDB nothing about a movie that already knows its IMDb id', async () => {
    const { calls, fetchImpl } = fake(() => ({ tt7654321: 'unavailable' }));
    const availability = new Availability(fetchImpl, undefined);
    availability.connect(SCOUT, 'key');
    availability.want({ type: 'movie', id: 9, imdbId: 'tt7654321' });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map((c) => c.url)).toEqual(['/scout/sealed-cfg/availability']);
    expect(availability.unavailable({ type: 'movie', id: 9 })).toBe(true);
  });

  it('asks nothing until there is a scout to ask', async () => {
    const { calls, fetchImpl } = fake(() => ({}));
    const availability = new Availability(fetchImpl);
    availability.want({ type: 'movie', id: 1 });
    availability.connect(null, 'key');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
    availability.connect(SCOUT, 'key');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.some((c) => c.url === '/scout/sealed-cfg/availability')).toBe(true);
  });
});
