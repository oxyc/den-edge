import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Availability, RETRY_MS } from './availability.svelte';

const SCOUT = 'http://192.168.86.193:8080/sealed-cfg/manifest.json';
const SUBTITLES = 'http://192.168.86.193:8093/subs-cfg/manifest.json';
const PUBLIC = 'https://torrentio.example/debrid-token/manifest.json';

/** Scout on this origin, and TMDB naming movie n `tt000000n` — except 404, which has no IMDb id. */
function fake(verdicts: () => Record<string, string>) {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === '/scout/sealed-cfg/manifest.json') return json({ id: 'com.den.scout' });
    if (url === '/scout/subs-cfg/manifest.json') return json({ id: 'com.den.subtitles' });
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

  it('finds scout among the LAN plugins, and never sends a public addon its URL', async () => {
    const { calls, fetchImpl } = fake(() => ({}));
    await new Availability(fetchImpl).connect([PUBLIC, SUBTITLES, SCOUT], 'key');
    expect(calls.map((c) => c.url)).toEqual(['/scout/subs-cfg/manifest.json', '/scout/sealed-cfg/manifest.json']);
  });

  it('fades what scout says has nothing, asks again about what it was still checking, and skips series', async () => {
    let second = 'unknown';
    const { calls, fetchImpl } = fake(() => ({ tt0000001: 'unavailable', tt0000002: second, tt0000003: 'available' }));
    const availability = new Availability(fetchImpl);
    await availability.connect([SCOUT], 'key');
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

  it('asks nothing until scout is found', async () => {
    const { calls, fetchImpl } = fake(() => ({}));
    const availability = new Availability(fetchImpl);
    availability.want({ type: 'movie', id: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
    await availability.connect([SCOUT], 'key');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.some((c) => c.url === '/scout/sealed-cfg/availability')).toBe(true);
  });
});
