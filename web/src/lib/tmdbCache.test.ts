import { describe, expect, it } from 'vitest';
import { cachingFetch, freshFor, RETENTION, type Entry, type Store } from './tmdbCache';

const HOUR = 3_600_000;

function memory() {
  const entries = new Map<string, Entry>();
  const pruned: number[] = [];
  const store: Store = {
    get: async (key) => entries.get(key),
    put: async (key, entry) => void entries.set(key, entry),
    prune: async (cutoff) => void pruned.push(cutoff),
    clear: async () => entries.clear(),
  };
  return { entries, pruned, store };
}

function network() {
  const asked: string[] = [];
  let failing = false;
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    if (failing) throw new TypeError('offline');
    return new Response(JSON.stringify({ n: asked.length }), { status: 200 });
  };
  return { asked, fetchImpl, fail: () => (failing = true) };
}

const detail = 'https://api.themoviedb.org/3/movie/603?api_key=secret&append_to_response=credits';
const discover = 'https://api.themoviedb.org/3/discover/movie?page=1&api_key=secret';

describe('cachingFetch', () => {
  it('answers from the store while fresh, and never keeps the key', async () => {
    const { entries, store } = memory();
    const net = network();
    let clock = 0;
    const cached = cachingFetch(store, net.fetchImpl, () => clock);
    expect(await (await cached(detail)).json()).toEqual({ n: 1 });
    await new Promise((resolve) => setTimeout(resolve));
    expect(await (await cached(detail)).json()).toEqual({ n: 1 });
    expect(net.asked).toHaveLength(1);
    expect([...entries.keys()].some((k) => k.includes('secret'))).toBe(false);

    clock = 7 * HOUR; // a list goes stale in hours, a title's details in weeks
    await cached(discover);
    await new Promise((resolve) => setTimeout(resolve));
    clock += 7 * HOUR;
    await cached(discover);
    await cached(detail);
    expect(net.asked.filter((u) => u.includes('discover'))).toHaveLength(2);
    expect(net.asked.filter((u) => u.includes('/movie/603'))).toHaveLength(1);
  });

  it('serves a stale answer when TMDB cannot be reached', async () => {
    const { store } = memory();
    const net = network();
    let clock = 0;
    const cached = cachingFetch(store, net.fetchImpl, () => clock);
    await cached(discover);
    await new Promise((resolve) => setTimeout(resolve));
    clock = 10 * 24 * HOUR;
    net.fail();
    expect(await (await cached(discover)).json()).toEqual({ n: 1 });
    await expect(cached('https://api.themoviedb.org/3/search/multi?query=x')).rejects.toThrow(
      'offline',
    );
  });

  it('leaves everything but TMDB alone, and prunes past the retention limit once', async () => {
    const { entries, pruned, store } = memory();
    const net = network();
    const cached = cachingFetch(store, net.fetchImpl, () => RETENTION + 5);
    await cached('/scout/cfg/availability', { method: 'POST' });
    await cached('/atlas/catalog/movie/den-titles.json');
    expect(entries.size).toBe(0);
    await cached(detail);
    await cached(discover);
    expect(pruned).toEqual([5]);
  });

  it('keeps details for weeks and lists for hours, as the TV does', () => {
    expect(freshFor('/3/tv/1399')).toBe(30 * 24 * HOUR);
    expect(freshFor('/3/tv/1399/season/2')).toBe(30 * 24 * HOUR);
    expect(freshFor('/3/movie/603/external_ids')).toBe(30 * 24 * HOUR);
    expect(freshFor('/3/discover/movie')).toBe(6 * HOUR);
    expect(freshFor('/3/search/multi')).toBe(6 * HOUR);
  });
});
