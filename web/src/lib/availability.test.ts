import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Availability,
  KEPT_MS,
  RETRY_MS,
  UNAVAILABLE_MS,
  listVerdict,
  seriesAvailabilityEpisode,
} from './availability.svelte';
import type { ContentServiceClientPort } from './contentServiceClient';
import { forgetLibraryCredential, useLibraryCredential } from './relayFetch';

const SCOUT = { install: 'http://192.168.86.193:8080/sealed-cfg', base: '/scout/sealed-cfg' };

const contentQuery = async (request: { kind: string; title?: { id: number } }) => ({
  kind: 'title.external-id' as const,
  imdbId:
    request.title?.id === 404
      ? ({ state: 'absent' } as const)
      : ({ state: 'ready', value: `tt${String(request.title?.id).padStart(7, '0')}` } as const),
});
const content = {
  query: contentQuery,
  onStatus: () => () => {},
} as unknown as ContentServiceClientPort;

/** Scout on this origin. IMDb identifiers come through the semantic content port above. */
function fake(verdicts: () => Record<string, string>) {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === '/scout/sealed-cfg/availability') return json({ availability: verdicts() });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

describe('Availability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fades what scout says has nothing, asks again about what it was still checking, and keeps series out of the batch', async () => {
    let second = 'unknown';
    const { calls, fetchImpl } = fake(() => ({
      tt0000001: 'unavailable',
      tt0000002: second,
      tt0000003: 'available',
    }));
    const availability = new Availability();
    availability.connect(SCOUT, content, fetchImpl);
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

  it('waits as long as scout says when it refuses, and spends no try on the refusal', async () => {
    let busy = true;
    const { calls, fetchImpl: answers } = fake(() => ({ tt0000001: 'unavailable' }));
    const fetchImpl: typeof fetch = async (input, init) =>
      busy && String(input).endsWith('/availability')
        ? (calls.push({ url: String(input) }),
          new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '60' } }))
        : answers(input, init);
    const availability = new Availability();
    availability.connect(SCOUT, content, fetchImpl);
    availability.want({ type: 'movie', id: 1 });
    const asked = () => calls.filter((c) => c.url.endsWith('/availability')).length;
    await vi.advanceTimersByTimeAsync(100);
    expect(asked()).toBe(1);
    busy = false;
    await vi.advanceTimersByTimeAsync(4 * RETRY_MS);
    expect(asked(), 'not before the minute scout asked for').toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked()).toBe(2);
    expect(availability.unavailable({ type: 'movie', id: 1 })).toBe(true);
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
    const availability = new Availability(storage, () => now);
    expect(availability.unavailable({ type: 'movie', id: 1 })).toBe(true);
    expect(availability.unavailable({ type: 'movie', id: 2 })).toBe(false);

    availability.connect(SCOUT, content, fetchImpl);
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

  it('asks again about "nothing to play" once scout itself would have checked again, and never about "available"', async () => {
    let now = 1_000_000;
    const { calls, fetchImpl } = fake(() => ({
      tt0000001: 'unavailable',
      tt0000002: 'available',
    }));
    const availability = new Availability(undefined, () => now);
    availability.connect(SCOUT, content, fetchImpl);
    const ask = async () => {
      for (const id of [1, 2]) availability.want({ type: 'movie', id });
      await vi.advanceTimersByTimeAsync(100);
    };
    const asked = () =>
      calls.filter((c) => c.url.endsWith('/availability')).map((c) => JSON.parse(c.body!).ids);
    await ask();
    now += UNAVAILABLE_MS - 1;
    await ask();
    expect(asked(), 'both answers still stand').toEqual([['tt0000001', 'tt0000002']]);
    now += 1;
    await ask();
    expect(asked()).toEqual([['tt0000001', 'tt0000002'], ['tt0000001']]);
  });

  it('keeps what scout answered while a new session has no scout yet', async () => {
    const { calls, fetchImpl } = fake(() => ({ tt0000001: 'unavailable' }));
    const availability = new Availability();
    availability.connect(SCOUT, content, fetchImpl);
    availability.want({ type: 'movie', id: 1 });
    await vi.advanceTimersByTimeAsync(100);
    availability.connect(null, content);
    expect(availability.unavailable({ type: 'movie', id: 1 })).toBe(true);
    availability.connect(SCOUT, content, fetchImpl);
    availability.want({ type: 'movie', id: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.filter((c) => c.url.endsWith('/availability'))).toHaveLength(1);
  });

  it('asks the content service nothing about a movie that already knows its IMDb id', async () => {
    const { calls, fetchImpl } = fake(() => ({ tt7654321: 'unavailable' }));
    const query = vi.fn(contentQuery);
    const watchedContent = {
      query,
      onStatus: () => () => {},
    } as unknown as ContentServiceClientPort;
    const availability = new Availability();
    availability.connect(SCOUT, watchedContent, fetchImpl);
    availability.want({ type: 'movie', id: 9, imdbId: 'tt7654321' });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map((c) => c.url)).toEqual(['/scout/sealed-cfg/availability']);
    expect(query).not.toHaveBeenCalled();
    expect(availability.unavailable({ type: 'movie', id: 9 })).toBe(true);
  });

  it('asks nothing until there is a scout to ask', async () => {
    const { calls, fetchImpl } = fake(() => ({}));
    const availability = new Availability();
    availability.want({ type: 'movie', id: 1 });
    availability.connect(null, content, fetchImpl);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
    availability.connect(SCOUT, content, fetchImpl);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.some((c) => c.url === '/scout/sealed-cfg/availability')).toBe(true);
  });

  it('does not duplicate an in-flight ask when a windowed poster remounts', async () => {
    let release!: (response: Response) => void;
    const answer = new Promise<Response>((resolve) => (release = resolve));
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return answer;
    };
    const availability = new Availability();
    availability.connect(SCOUT, content, fetchImpl);
    const movie = { type: 'movie' as const, id: 9, imdbId: 'tt7654321' };
    availability.want(movie);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['/scout/sealed-cfg/availability']);

    for (let mount = 0; mount < 20; mount++) availability.want(movie);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls, 'remounts join the pending id instead of scheduling another batch').toHaveLength(
      1,
    );

    release(Response.json({ availability: { tt7654321: 'available' } }));
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
  });

  it('does not let a remount bypass an unknown verdict retry delay', async () => {
    const { calls, fetchImpl } = fake(() => ({ tt7654321: 'unknown' }));
    const availability = new Availability();
    availability.connect(SCOUT, content, fetchImpl);
    const movie = { type: 'movie' as const, id: 9, imdbId: 'tt7654321' };
    availability.want(movie);
    await vi.advanceTimersByTimeAsync(100);
    const asked = () => calls.filter((call) => call.url.endsWith('/availability')).length;
    expect(asked()).toBe(1);

    for (let mount = 0; mount < 20; mount++) availability.want(movie);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 100);
    expect(asked(), 'the retry remains blocked for its full backoff').toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(asked()).toBe(2);
  });

  it('drops an old scout response and moves its pending id to the new scout', async () => {
    let releaseOld!: (response: Response) => void;
    const oldAnswer = new Promise<Response>((resolve) => (releaseOld = resolve));
    const calls: string[] = [];
    const oldFetch: typeof fetch = async (input) => {
      calls.push(`old ${String(input)}`);
      return oldAnswer;
    };
    const newFetch: typeof fetch = async (input) => {
      calls.push(`new ${String(input)}`);
      return Response.json({ availability: { tt7654321: 'available' } });
    };
    const availability = new Availability();
    const movie = { type: 'movie' as const, id: 9, imdbId: 'tt7654321' };
    availability.connect(SCOUT, content, oldFetch);
    availability.want(movie);
    await vi.advanceTimersByTimeAsync(100);

    availability.connect(null, content);
    await vi.advanceTimersByTimeAsync(100);
    availability.connect({ ...SCOUT, base: '/scout/new' }, content, newFetch);
    await vi.advanceTimersByTimeAsync(100);
    releaseOld(Response.json({ availability: { tt7654321: 'unavailable' } }));
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['old /scout/sealed-cfg/availability', 'new /scout/new/availability']);
    expect(availability.unavailable(movie), 'the late old-service answer is ignored').toBe(false);
  });

  it('cancels an old scout retry delay and asks the new scout once', async () => {
    const calls: string[] = [];
    const oldFetch: typeof fetch = async (input) => {
      calls.push(`old ${String(input)}`);
      return Response.json({ availability: { tt7654321: 'unknown' } });
    };
    const newFetch: typeof fetch = async (input) => {
      calls.push(`new ${String(input)}`);
      return Response.json({ availability: { tt7654321: 'available' } });
    };
    const availability = new Availability();
    const movie = { type: 'movie' as const, id: 9, imdbId: 'tt7654321' };
    availability.connect(SCOUT, content, oldFetch);
    availability.want(movie);
    await vi.advanceTimersByTimeAsync(100);

    availability.connect({ ...SCOUT, base: '/scout/new' }, content, newFetch);
    await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
    expect(calls).toEqual(['old /scout/sealed-cfg/availability', 'new /scout/new/availability']);
  });

  it('does not carry an old scout’s Retry-After timer into a new scout', async () => {
    const calls: string[] = [];
    const oldFetch: typeof fetch = async (input) => {
      calls.push(`old ${String(input)}`);
      return new Response('{"error":"busy"}', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    };
    const newFetch: typeof fetch = async (input) => {
      calls.push(`new ${String(input)}`);
      return Response.json({ availability: { tt7654321: 'available' } });
    };
    const availability = new Availability();
    const movie = { type: 'movie' as const, id: 9, imdbId: 'tt7654321' };
    availability.connect(SCOUT, content, oldFetch);
    availability.want(movie);
    await vi.advanceTimersByTimeAsync(100);

    availability.connect({ ...SCOUT, base: '/scout/new' }, content, newFetch);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['old /scout/sealed-cfg/availability', 'new /scout/new/availability']);
  });

  /**
   * Scout is asked under this origin, where den-edge relays it, and the relay wants the household's
   * membership. Assert the default relay fetch path rather than a test fetch.
   */
  it('asks scout with the household’s membership, not with TMDB’s fetch', async () => {
    const sent: (string | null)[] = [];
    // A page to be on. Without one `relayFetch` cannot tell this origin from anyone else's, so it
    // claims nothing — correctly — and these tests otherwise run with no location at all.
    vi.stubGlobal('location', { href: 'https://d.oxy.fi/', origin: 'https://d.oxy.fi' });
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('x-den-library-member'));
      return new Response(JSON.stringify({ availability: { tt7654321: 'unavailable' } }));
    });
    useLibraryCredential({ id: 'lib', member: 'tok' });
    try {
      const availability = new Availability();
      availability.connect(SCOUT, content);
      availability.want({ type: 'movie', id: 9, imdbId: 'tt7654321' });
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      forgetLibraryCredential();
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual(['lib:tok']);
  });
});

/** The vectors DenKit's `SeriesAvailabilityTests` holds the TV and iOS to: the same rule on every client. */
describe('seriesAvailabilityEpisode', () => {
  const now = new Date(2026, 4, 28, 12);
  const day = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const ask = (input: Parameters<typeof seriesAvailabilityEpisode>[0]) =>
    seriesAvailabilityEpisode(input, now);

  it('takes a new episode, then the Continue Watching entry, then S1E1', () => {
    const newEpisode = { season: 3, episode: 1 };
    const continuing = { season: 2, episode: 4, out: true };
    expect(ask({ newEpisode, continuing, firstAired: day(-900) })).toEqual(newEpisode);
    expect(ask({ continuing, firstAired: day(-900) })).toEqual({ season: 2, episode: 4 });
    expect(ask({ firstAired: day(-900) })).toEqual({ season: 1, episode: 1 });
  });

  it('never asks about an episode not out yet', () => {
    expect(
      ask({ continuing: { season: 2, episode: 5, out: false }, firstAired: day(-900) }),
    ).toBeUndefined();
    expect(ask({ firstAired: day(3) })).toBeUndefined();
    expect(ask({ firstAired: day(60) })).toBeUndefined();
    expect(ask({ firstAired: day(0) })).toEqual({ season: 1, episode: 1 });
    expect(ask({})).toEqual({ season: 1, episode: 1 });
  });
});

describe('listVerdict', () => {
  it('reads a stream list as the TV reads its addons', () => {
    expect(listVerdict({ streams: [{ url: 'x' }] })).toBe('available');
    expect(listVerdict({ streams: [] })).toBe('unavailable');
    expect(listVerdict({ streams: [], den: { answerKind: 'empty' } })).toBe('unavailable');
    expect(listVerdict({ streams: [], den: { answerKind: 'unknown' } })).toBe('unknown');
    expect(listVerdict({ streams: [], den: { answerKind: 'partial' } })).toBe('unknown');
    expect(
      listVerdict({
        streams: [],
        den: { answerKind: 'live', coverage: { sources: [{ outcome: 'timeout' }] } },
      }),
    ).toBe('unknown');
    expect(listVerdict({ error: 'nope' })).toBe('unknown');
  });
});

describe('Availability — series', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Familjen Andersson (TMDB tv 233351, IMDb tt28784095): every stream list it gets is empty. */
  const andersson = { type: 'tv' as const, id: 233351, releaseDate: '2024-01-05' };
  const LIST = (season: number, episode: number) =>
    `/scout/sealed-cfg/stream/series/${encodeURIComponent(`tt28784095:${season}:${episode}`)}.json`;
  const seriesContent = {
    query: async () => ({
      kind: 'title.external-id' as const,
      imdbId: { state: 'ready', value: 'tt28784095' } as const,
    }),
    onStatus: () => () => {},
  } as unknown as ContentServiceClientPort;
  function scout(answer: (url: string) => Response) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return answer(String(input));
    };
    return { calls, fetchImpl };
  }
  const empty = () =>
    Response.json({ streams: [], den: { answerKind: 'empty', coverage: { sources: [] } } });

  it('fades Familjen Andersson — every stream list empty — after one list search at S1E1', async () => {
    const { calls, fetchImpl } = scout(empty);
    const availability = new Availability();
    availability.connect(SCOUT, seriesContent, fetchImpl);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([LIST(1, 1)]);
    expect(availability.unavailable(andersson)).toBe(true);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls, 'the verdict stands for its ten minutes').toHaveLength(1);
  });

  it('asks about the Continue Watching entry, and nothing while it waits for an episode', async () => {
    const { calls, fetchImpl } = scout((url) =>
      url === LIST(1, 3) ? Response.json({ streams: [{ url: '/scout/p/x' }] }) : empty(),
    );
    const availability = new Availability();
    availability.connect(SCOUT, seriesContent, fetchImpl);
    const entry = (episode: number, upcoming?: string) => ({
      title: andersson,
      episode: { season: 1, episode },
      upcoming,
    });
    availability.follow([entry(3)], []);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([LIST(1, 3)]);
    expect(availability.unavailable(andersson)).toBe(false);

    availability.follow([entry(4, '2026-12-01')], []);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls, 'an episode not out is not asked about').toHaveLength(1);
    expect(availability.unavailable(andersson)).toBe(false);
  });

  it('a new episode found with sources clears the fade', async () => {
    const { fetchImpl } = scout(empty);
    const availability = new Availability();
    availability.connect(SCOUT, seriesContent, fetchImpl);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(availability.unavailable(andersson)).toBe(true);

    const released = { series: andersson.id, season: 2, episode: 1 };
    availability.confirm(andersson, released, true);
    availability.follow([], [released]);
    expect(availability.unavailable(andersson)).toBe(false);
  });

  it('a failed search is unknown, never fades, and is asked again', async () => {
    let down = true;
    const { calls, fetchImpl } = scout(() =>
      down ? new Response('{}', { status: 502 }) : empty(),
    );
    const availability = new Availability();
    availability.connect(SCOUT, seriesContent, fetchImpl);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(availability.unavailable(andersson)).toBe(false);
    down = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
    expect(calls).toEqual([LIST(1, 1), LIST(1, 1)]);
    expect(availability.unavailable(andersson)).toBe(true);
  });

  it('opening the Sources heals a stale fade, and verdicts are kept for the next visit', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
    const { fetchImpl } = scout(empty);
    const availability = new Availability(storage);
    availability.connect(SCOUT, seriesContent, fetchImpl);
    availability.want(andersson);
    await vi.advanceTimersByTimeAsync(100);
    expect(new Availability(storage).unavailable(andersson), 'kept').toBe(true);

    availability.confirm(andersson, { season: 1, episode: 1 }, true);
    expect(availability.unavailable(andersson)).toBe(false);
    expect(new Availability(storage).unavailable(andersson)).toBe(false);
  });
});
