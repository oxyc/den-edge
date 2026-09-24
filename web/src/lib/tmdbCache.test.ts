import { describe, expect, it, vi } from 'vitest';
import {
  cachingFetch,
  freshFor,
  onTmdbThrottle,
  RETENTION,
  sharingFlights,
  TMDB_PROXY_KEY,
  type Entry,
  type Store,
} from './tmdbCache';

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

describe('every device, with a key of its own or without', () => {
  it('asks this origin instead, and keeps the answer under the same question', async () => {
    vi.stubGlobal('location', { origin: 'https://den.example' });
    const { entries, store } = memory();
    const net = network();
    const cached = cachingFetch(store, net.fetchImpl, () => 0);
    await cached(
      `https://api.themoviedb.org/3/movie/603?api_key=${TMDB_PROXY_KEY}&append_to_response=credits`,
    );
    // den-edge substitutes the household's key; the sentinel never leaves the browser.
    expect(net.asked).toEqual(['https://den.example/tmdb/3/movie/603?append_to_response=credits']);
    // Kept under the question, not under who asked it: the day this browser is given a key of its own, it
    // reads what it already has rather than asking TMDB again.
    expect([...entries.keys()]).toEqual([
      'https://api.themoviedb.org/3/movie/603?append_to_response=credits',
    ]);
    vi.unstubAllGlobals();
  });

  // A browser holding the household's own key used to ask TMDB directly, which spent that key once per device and
  // kept the answer where no other device could read it. The question is the same either way, so it goes to the one
  // cache that every device and every visitor shares.
  it('asks through this origin with a key of its own too, and never sends the key', async () => {
    vi.stubGlobal('location', { origin: 'https://den.example' });
    const { entries, store } = memory();
    const net = network();
    await cachingFetch(store, net.fetchImpl, () => 0)(detail);
    expect(net.asked).toEqual(['https://den.example/tmdb/3/movie/603?append_to_response=credits']);
    expect([...entries.keys()], 'the same entry a keyless browser would have written').toEqual([
      'https://api.themoviedb.org/3/movie/603?append_to_response=credits',
    ]);
    vi.unstubAllGlobals();
  });
});

describe('cachingFetch', () => {
  it('reports a rate limit that leaves the page without an answer', async () => {
    const waits: number[] = [];
    const stop = onTmdbThrottle(({ retryMs }) => waits.push(retryMs));
    const refused: typeof fetch = async () =>
      new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'retry-after': '17' },
      });
    try {
      expect((await cachingFetch(memory().store, refused)(detail)).status).toBe(429);
      expect(waits).toEqual([17_000]);
    } finally {
      stop();
    }
  });

  it('shows the answer it keeps rather than a rate limit, and does not report one', async () => {
    const waits: number[] = [];
    const stop = onTmdbThrottle(({ retryMs }) => waits.push(retryMs));
    waits.length = 0; // What an earlier test left in force.
    const { entries, store } = memory();
    entries.set('https://api.themoviedb.org/3/discover/movie?page=1', {
      body: '{"page":1}',
      fetchedAt: 0,
    });
    const refused: typeof fetch = async () =>
      new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'retry-after': '17' },
      });
    try {
      // Past fresh and past stale: asked, refused, and the kept answer still shows.
      const res = await cachingFetch(store, refused, () => 30 * 24 * HOUR)(discover);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"page":1}');
      expect(waits).toEqual([]);
    } finally {
      stop();
    }
  });

  it('retains the longest active rate limit for a listener that mounts late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    let retryAfter = '60';
    const refused: typeof fetch = async () =>
      new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'retry-after': retryAfter },
      });
    const cached = cachingFetch(memory().store, refused);
    try {
      await cached(detail); // No listener yet: the root UI can still be mounting.
      vi.advanceTimersByTime(10_000);

      const waits: number[] = [];
      const stop = onTmdbThrottle(({ retryMs }) => waits.push(retryMs));
      try {
        expect(waits).toEqual([50_000]);

        retryAfter = '5';
        await cached(detail);
        expect(waits).toEqual([50_000]);

        retryAfter = '120';
        await cached(detail);
        expect(waits).toEqual([50_000, 120_000]);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('shows a recently stale answer at once and refreshes it behind the page, once', async () => {
    const { entries, store } = memory();
    const net = network();
    let clock = 0;
    const cached = cachingFetch(store, net.fetchImpl, () => clock);
    await cached(discover);
    await new Promise((resolve) => setTimeout(resolve));
    clock = 2 * 24 * HOUR;
    const aborted = AbortSignal.abort();
    const both = await Promise.all([cached(discover, { signal: aborted }), cached(discover)]);
    expect(await Promise.all(both.map((r) => r.json()))).toEqual([{ n: 1 }, { n: 1 }]);
    await vi.waitFor(() => expect([...entries.values()][0]?.body).toBe('{"n":2}'));
    expect(net.asked).toHaveLength(2);
    expect(await (await cached(discover)).json()).toEqual({ n: 2 });
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

  /**
   * A title's details are kept for months, so an answer that names no title would stand for months —
   * the page insisting it cannot load a film TMDB serves perfectly well, with reloading no help.
   */
  it('never keeps an answer that is not TMDB’s, and asks again for one already kept', async () => {
    const { entries, store } = memory();
    const refusals: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, status_message: 'Invalid API key' }), {
        status: 200,
      });
    await cachingFetch(store, refusals, () => 0)(detail);
    expect(entries.size, 'an error envelope is not an answer').toBe(0);

    const net = network();
    entries.set('https://api.themoviedb.org/3/movie/603?append_to_response=credits', {
      body: '<!doctype html>',
      fetchedAt: 0,
    });
    expect(await (await cachingFetch(store, net.fetchImpl, () => 0)(detail)).json()).toEqual({
      n: 1,
    });
    expect(net.asked, 'what was kept was unusable, so it was asked again').toHaveLength(1);
  });

  /**
   * den-edge may hand over an answer it kept months ago. Counted from when it reached this browser, the copy
   * here could outlive TMDB's six months by as much again.
   */
  it('counts a lent answer’s age from when den-edge kept it', async () => {
    vi.stubGlobal('location', { origin: 'https://den.example' });
    const { entries, store } = memory();
    const clock = 400 * 24 * HOUR;
    const keptAt = clock - 179 * 24 * HOUR;
    const asked: string[] = [];
    const lending: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response('{"id":603}', {
        status: 200,
        headers: { 'last-modified': new Date(keptAt).toUTCString() },
      });
    };
    let now = clock;
    const cached = cachingFetch(store, lending, () => now);
    const lent = `https://api.themoviedb.org/3/movie/603?api_key=${TMDB_PROXY_KEY}`;
    await cached(lent);
    await new Promise((resolve) => setTimeout(resolve));
    expect([...entries.values()][0]?.fetchedAt).toBe(keptAt);

    // Two days on it is past six months since den-edge fetched it, so it is asked for again.
    now += 2 * 24 * HOUR;
    await cached(lent);
    expect(asked).toHaveLength(2);
    vi.unstubAllGlobals();

    // TMDB's own Last-Modified is when the title changed, not when it was fetched.
    const direct = memory();
    await cachingFetch(direct.store, lending, () => clock)(detail);
    await new Promise((resolve) => setTimeout(resolve));
    expect([...direct.entries.values()][0]?.fetchedAt).toBe(clock);
  });

  it('never shows a copy past six months, not even when TMDB cannot be reached', async () => {
    const { entries, store } = memory();
    const net = network();
    entries.set('https://api.themoviedb.org/3/movie/603?append_to_response=credits', {
      body: '{"id":603}',
      fetchedAt: 0,
    });
    net.fail();
    await expect(
      cachingFetch(store, net.fetchImpl, () => RETENTION + HOUR)(detail),
    ).rejects.toThrow('offline');
  });

  it('keeps details for as long as TMDB allows, and lists for hours', () => {
    // What a film is called, when it came out and who was in it does not change, so re-asking every month
    // bought nothing but a wait. den-edge keeps them the same length (`tmdb.rs`), and TMDB's terms set both.
    expect(freshFor('/3/tv/1399')).toBe(RETENTION);
    expect(freshFor('/3/tv/1399/season/2')).toBe(RETENTION);
    expect(freshFor('/3/movie/603/external_ids')).toBe(RETENTION);
    expect(freshFor('/3/discover/movie')).toBe(6 * HOUR);
    expect(freshFor('/3/search/multi')).toBe(6 * HOUR);
  });

  /** The detail page's "where to watch" came from an answer kept for six months. */
  it('keeps a title asked with where it streams, or what is like it, for hours', () => {
    expect(freshFor('/3/movie/603', undefined, 'credits')).toBe(RETENTION);
    expect(freshFor('/3/tv/1399', undefined, 'credits,external_ids')).toBe(RETENTION);
    expect(
      freshFor(
        '/3/movie/603',
        undefined,
        'credits,recommendations,videos,external_ids,release_dates,watch/providers',
      ),
    ).toBe(6 * HOUR);
    expect(freshFor('/3/tv/1399', undefined, 'watch/providers')).toBe(6 * HOUR);
  });

  it('asks again the same day for a title asked with where it streams', async () => {
    const withProviders =
      'https://api.themoviedb.org/3/movie/603?api_key=secret&append_to_response=credits,watch/providers';
    const { entries, store } = memory();
    const net = network();
    entries.set(
      'https://api.themoviedb.org/3/movie/603?append_to_response=credits%2Cwatch%2Fproviders',
      { body: '{"id":603}', fetchedAt: 0 },
    );
    await cachingFetch(store, net.fetchImpl, () => 7 * HOUR)(withProviders);
    await vi.waitFor(() => expect(net.asked).toHaveLength(1));
  });

  /**
   * Only TMDB knows whether a series has ended, so the answer decides this and not the path. Kept for six
   * months, a series still airing leaves the app believing the season ended months ago — and the next episode,
   * which `continueWatching` picks from that shape, never appears.
   */
  it('keeps a series that is not over for hours, and a finished one for months', () => {
    const airing = '{"id":1399,"status":"Returning Series","next_episode_to_air":{"id":1}}';
    const ended = '{"id":1399,"status":"Ended","next_episode_to_air":null}';
    // Between seasons nothing is scheduled, and the announcement of the next one is what must be noticed.
    const between = '{"id":1399,"status":"Returning Series","next_episode_to_air":null}';
    expect(freshFor('/3/tv/1399', airing)).toBe(6 * HOUR);
    expect(freshFor('/3/tv/1399', between)).toBe(6 * HOUR);
    expect(freshFor('/3/tv/1399', ended)).toBe(RETENTION);
    expect(freshFor('/3/tv/1399', '{"id":1399,"status":"Canceled"}')).toBe(RETENTION);
    // A season's episodes are settled once they have aired, and a film has no such field to read.
    expect(freshFor('/3/tv/1399/season/2', airing)).toBe(RETENTION);
    expect(freshFor('/3/movie/603', airing)).toBe(RETENTION);
    expect(freshFor('/3/tv/1399')).toBe(RETENTION);
  });

  it('asks again for an airing series the same day, and leaves a finished one alone', async () => {
    const airing = '{"id":1399,"status":"Returning Series","next_episode_to_air":{"id":1}}';
    const series = 'https://api.themoviedb.org/3/tv/1399?api_key=secret';
    const { entries, store } = memory();
    const net = network();
    entries.set('https://api.themoviedb.org/3/tv/1399', { body: airing, fetchedAt: 0 });
    await cachingFetch(store, net.fetchImpl, () => 7 * HOUR)(series);
    expect(net.asked, 'six hours old and still airing, so it is asked again').toHaveLength(1);

    const settled = memory();
    settled.entries.set('https://api.themoviedb.org/3/tv/1399', {
      body: '{"id":1399,"status":"Ended","next_episode_to_air":null}',
      fetchedAt: 0,
    });
    const quiet = network();
    await cachingFetch(settled.store, quiet.fetchImpl, () => 7 * HOUR)(series);
    expect(quiet.asked, 'a finished series is what it was six hours ago').toHaveLength(0);
  });
});

describe('sharingFlights', () => {
  /** A network whose answers wait until released, counting what it was asked and with which signal. */
  function held() {
    const asked: { url: string; signal: AbortSignal | null | undefined }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), signal: init?.signal });
      await gate;
      return new Response(JSON.stringify({ n: asked.length }), { status: 200 });
    };
    return { asked, fetchImpl, release };
  }

  it('joins a question already on its way, whatever key or parameter order asked it', async () => {
    const net = held();
    const shared = sharingFlights(net.fetchImpl);
    const first = shared('https://api.themoviedb.org/3/movie/7?api_key=a&language=en');
    const second = shared('https://api.themoviedb.org/3/movie/7?language=en&api_key=b');
    net.release();
    const bodies = await Promise.all([first, second].map(async (res) => (await res).json()));
    expect(net.asked).toHaveLength(1);
    expect(bodies, 'each caller reads its own copy of the one answer').toEqual([
      { n: 1 },
      { n: 1 },
    ]);
    await shared('https://api.themoviedb.org/3/movie/7?api_key=a&language=en');
    expect(net.asked, 'once answered it is no longer in flight').toHaveLength(2);
  });

  it('lets one caller give up without failing the others', async () => {
    const net = held();
    const shared = sharingFlights(net.fetchImpl);
    const leaving = new AbortController();
    const gaveUp = shared(detail, { signal: leaving.signal });
    const stayed = shared(detail);
    expect(net.asked[0]?.signal, 'the shared request carries no caller’s signal').not.toBe(
      leaving.signal,
    );
    leaving.abort(new Error('left the page'));
    await expect(gaveUp).rejects.toThrow('left the page');
    net.release();
    expect(await (await stayed).json()).toEqual({ n: 1 });
  });

  it('gives up on a shared question nobody answers, so the next caller asks again', async () => {
    const limits: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const limit = new AbortController();
      limits.push(limit);
      return limit.signal;
    });
    const asked: string[] = [];
    const hung: typeof fetch = (input, init) => {
      asked.push(String(input));
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    };
    try {
      const shared = sharingFlights(hung);
      const first = shared(detail);
      limits[0]!.abort(new DOMException('timed out', 'TimeoutError'));
      await expect(first).rejects.toThrow('timed out');
      void shared(detail).catch(() => undefined);
      expect(asked, 'asked again, not joined to the one that hung').toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves everything but a TMDB GET alone', async () => {
    const net = held();
    net.release();
    const shared = sharingFlights(net.fetchImpl);
    await Promise.all([shared('/atlas/manifest.json'), shared('/atlas/manifest.json')]);
    await Promise.all([shared(detail, { method: 'POST' }), shared(detail, { method: 'POST' })]);
    expect(net.asked).toHaveLength(4);
  });
});
