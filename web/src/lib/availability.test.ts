import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Availability, RETRY_MS } from './availability.svelte';

const SCOUT = { install: 'http://192.168.86.193:8080/sealed-cfg', config: 'sealed-cfg' };

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
    const { calls, fetchImpl } = fake(() => ({ tt0000001: 'unavailable', tt0000002: second, tt0000003: 'available' }));
    const availability = new Availability(fetchImpl);
    availability.connect(SCOUT, 'key');
    for (const id of [1, 2, 3, 404]) availability.want({ type: 'movie', id });
    availability.want({ type: 'tv', id: 5 });
    await vi.advanceTimersByTimeAsync(100);

    const asked = () => calls.filter((c) => c.url.endsWith('/availability')).map((c) => JSON.parse(c.body!).ids);
    expect(asked()).toEqual([['tt0000001', 'tt0000002', 'tt0000003']]);
    expect([1, 2, 3, 404].map((id) => availability.unavailable({ type: 'movie', id }))).toEqual([true, false, false, false]);

    second = 'unavailable';
    await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
    expect(asked()).toEqual([['tt0000001', 'tt0000002', 'tt0000003'], ['tt0000002']]);
    expect(availability.unavailable({ type: 'movie', id: 2 })).toBe(true);
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
