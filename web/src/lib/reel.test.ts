import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cropStyle,
  forgetWarmedTrailers,
  nativeHls,
  parseSourcePlan,
  PlaybackCursor,
  prepareTrailers,
} from './reel';
import type { SourcePlan, TrailerCandidate } from './reel';
import type { Routes } from './routes';

const CAPABILITY = `m/s/${'A'.repeat(40)}?s=${'b'.repeat(24)}`;
const ROUTES: Routes = { reel: [{ url: 'https://reel.example' }] };

const external = (url: string, kind: 'mp4' | 'hls' = 'mp4') => ({
  kind,
  audio: true,
  width: 1920,
  height: 1080,
  delivery: { type: 'external', url },
});

const carried = (capability = CAPABILITY) => ({
  kind: 'mp4',
  audio: true,
  width: 1280,
  height: 720,
  delivery: { type: 'reel', capability },
});

const plan = (...sources: unknown[]): SourcePlan =>
  parseSourcePlan({ v: 2, expires: 2_000_000_000, crop: null, sources })!;

const candidate = (sourcePlan: SourcePlan): TrailerCandidate => ({
  planUrl: '/reel/sources/trailer.json?v=2',
  plan: sourcePlan,
});

beforeEach(() => {
  forgetWarmedTrailers();
  vi.restoreAllMocks();
});

describe('the v2 plan parser', () => {
  it('accepts typed deliveries and drops values that would require URL inference', () => {
    const parsed = parseSourcePlan({
      v: 2,
      expires: 1234,
      crop: { letterboxed: true, aspect: 2.4, rect: [0, 0.1, 1, 0.8] },
      sources: [
        external('https://video.example/trailer.mp4'),
        carried(),
        {
          ...external('javascript:alert(1)'),
          delivery: { type: 'external', url: 'javascript:x' },
        },
        {
          ...carried(),
          delivery: { type: 'reel', capability: `${CAPABILITY}&extra=1` },
        },
        { kind: 'mp4', url: 'https://legacy.example/video.mp4' },
      ],
    });

    expect(parsed?.sources).toHaveLength(2);
    expect(parsed?.sources.map((source) => source.delivery.type)).toEqual(['external', 'reel']);
    expect(parsed?.crop?.rect).toEqual([0, 0.1, 1, 0.8]);
  });
});

describe('prepareTrailers', () => {
  it('reuses a warm answer for play, preserves an install-scoped plan URL, and expires with the plan', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(
        JSON.stringify({
          v: 2,
          meta: {
            links: [
              {
                planUrl:
                  'https://internal.invalid/reel/cfg/sources/trailer.json?v=2&surface=audible&player=native',
              },
            ],
          },
          primary: {
            id: 'trailer',
            planUrl:
              'https://internal.invalid/reel/cfg/sources/trailer.json?v=2&surface=audible&player=native',
          },
          primaryPlan: {
            v: 2,
            expires: Math.floor(now / 1000) + 10,
            crop: null,
            sources: [external('https://video.example/trailer.mp4')],
          },
        }),
      );
    };
    const options = { fetchImpl, secure: true };
    const ids = { tmdb: 42, imdb: 'tt42' };

    const warm = await prepareTrailers(
      '/reel/cfg',
      'movie',
      ids,
      ROUTES,
      { surface: 'audible', player: 'native', intent: 'warm' },
      options,
    );
    const reused = await prepareTrailers(
      '/reel/cfg',
      'movie',
      ids,
      ROUTES,
      { surface: 'audible', player: 'native' },
      options,
    );

    expect(reused).toBe(warm);
    expect(reused[0]?.planUrl).toBe(
      '/reel/cfg/sources/trailer.json?v=2&surface=audible&player=native',
    );
    expect(asked).toHaveLength(1);

    now += 11_000;
    await prepareTrailers(
      '/reel/cfg',
      'movie',
      ids,
      ROUTES,
      { surface: 'audible', player: 'native' },
      options,
    );
    expect(asked).toHaveLength(2);
  });

  it('leaves a degraded primary lazy instead of caching null as its plan', async () => {
    const found = await prepareTrailers(
      '/reel/cfg',
      'movie',
      { tmdb: 42 },
      ROUTES,
      { surface: 'audible', player: 'native' },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              v: 2,
              meta: {
                links: [{ planUrl: 'https://internal.invalid/sources/a.json?v=2' }],
              },
              primary: {
                id: 'a',
                planUrl: 'https://internal.invalid/sources/a.json?v=2',
              },
              primaryPlan: null,
            }),
          ),
      },
    );
    expect(found).toEqual([{ planUrl: '/reel/sources/a.json?v=2' }]);
  });

  it('preserves a direct route config prefix without duplicating its mount', async () => {
    const directRoutes: Routes = {
      reel: [{ url: 'https://lan.example/reel' }],
    };
    const found = await prepareTrailers(
      'https://lan.example/reel/cfg',
      'movie',
      { tmdb: 42 },
      directRoutes,
      { surface: 'audible', player: 'native' },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              v: 2,
              meta: {
                links: [
                  {
                    planUrl: 'https://lan.example/reel/cfg/sources/a.json?v=2',
                  },
                ],
              },
              primary: null,
              primaryPlan: null,
            }),
          ),
      },
    );
    expect(found[0]?.planUrl).toBe('https://lan.example/reel/cfg/sources/a.json?v=2');
  });
});

describe('PlaybackCursor', () => {
  it('mounts an external first source without a transport call', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const cursor = new PlaybackCursor(
      [candidate(plan(external('https://video.example/first.mp4'), carried()))],
      { fetchImpl },
    );

    expect(await cursor.first()).toMatchObject({
      attemptType: 'external',
      url: 'https://video.example/first.mp4',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redeems a Reel capability only when current and walks its attempts in order', async () => {
    const asked: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          v: 2,
          capability: CAPABILITY,
          attempts: [
            { type: 'lan', url: 'https://lan.example/video.mp4' },
            { type: 'public', url: 'https://public.example/video.mp4' },
            { type: 'relay', url: `/reel/${CAPABILITY}` },
          ],
        }),
      );
    };
    const cursor = new PlaybackCursor(
      [candidate(plan(external('https://video.example/first.mp4'), carried()))],
      { fetchImpl },
    );

    expect((await cursor.first())?.attemptType).toBe('external');
    expect(asked).toEqual([]);
    expect((await cursor.next())?.attemptType).toBe('lan');
    expect(asked).toEqual([{ url: '/reel/transport', body: { capability: CAPABILITY } }]);
    expect((await cursor.next())?.attemptType).toBe('public');
    expect((await cursor.next())?.attemptType).toBe('relay');
    expect(asked).toHaveLength(1);
  });

  it.each([
    ['malformed', () => new Response('{}')],
    ['non-OK', () => new Response('{}', { status: 503 })],
    ['thrown', () => Promise.reject(new Error('transport unavailable'))],
  ])('keeps the exact configured relay fallback when transport is %s', async (_name, answer) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer());
    const cursor = new PlaybackCursor(
      [
        {
          planUrl: '/custom/reel/sources/trailer.json?v=2',
          plan: plan(carried()),
        },
      ],
      { fetchImpl },
    );

    await expect(cursor.first()).resolves.toMatchObject({
      attemptType: 'relay',
      url: `/custom/reel/${CAPABILITY}`,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/custom/reel/transport');
  });

  it.each([403, 410])('does not bypass an explicit %s capability rejection', async (status) => {
    const cursor = new PlaybackCursor([candidate(plan(carried()))], {
      fetchImpl: async () => new Response('{}', { status }),
    });
    await expect(cursor.first()).resolves.toBeNull();
  });

  it('keeps a configured-mount relay after a valid direct transport attempt', async () => {
    const relay = `/custom/reel/${CAPABILITY}`;
    const cursor = new PlaybackCursor(
      [
        {
          planUrl: '/custom/reel/sources/trailer.json?v=2',
          plan: plan(carried()),
        },
      ],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              v: 2,
              capability: CAPABILITY,
              attempts: [
                { type: 'public', url: 'https://public.example/video.mp4' },
                { type: 'relay', url: relay },
              ],
            }),
          ),
      },
    );

    await expect(cursor.first()).resolves.toMatchObject({ attemptType: 'public' });
    await expect(cursor.next()).resolves.toMatchObject({ attemptType: 'relay', url: relay });
  });

  it('does not publish the relay fallback after its cursor is aborted', async () => {
    const controller = new AbortController();
    const cursor = new PlaybackCursor([candidate(plan(carried()))], {
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        throw new DOMException('stopped', 'AbortError');
      },
    });
    await expect(cursor.first()).resolves.toBeNull();
  });

  it('advances failed plans and candidates deterministically without mutating shared discovery', async () => {
    const lazy: TrailerCandidate = {
      planUrl: '/reel/sources/missing.json?v=2',
    };
    const fallback = candidate(
      plan(external('https://video.example/a.mp4'), external('https://video.example/b.mp4')),
    );
    const fetchImpl: typeof fetch = async (input) =>
      String(input).includes('missing') ? new Response('{}', { status: 503 }) : new Response('{}');
    const cursor = new PlaybackCursor([lazy, fallback], { fetchImpl });

    expect((await cursor.first())?.url).toBe('https://video.example/a.mp4');
    expect((await cursor.next())?.url).toBe('https://video.example/b.mp4');
    expect(lazy).toEqual({ planUrl: '/reel/sources/missing.json?v=2' });
  });

  it('refreshes an expired embedded plan before redeeming it', async () => {
    const expired = { ...plan(carried()), expires: Math.floor(Date.now() / 1000) - 1 };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(plan(external('https://video.example/fresh.mp4')))),
      ),
    );
    const cursor = new PlaybackCursor([candidate(expired)], { fetchImpl });

    expect((await cursor.first())?.url).toBe('https://video.example/fresh.mp4');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/reel/sources/trailer.json?v=2');
  });

  it('coalesces duplicate seeks and aborts pending work on teardown', async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    };
    const cursor = new PlaybackCursor([{ planUrl: '/reel/sources/lazy.json?v=2' }], { fetchImpl });
    const first = cursor.first();
    const duplicate = cursor.first();
    expect(requestSignal?.aborted).toBe(false);

    cursor.close();
    expect(requestSignal?.aborted).toBe(true);
    resolveResponse?.(new Response('{}'));
    await expect(first).resolves.toBeNull();
    await expect(duplicate).resolves.toBeNull();
  });
});

describe('small presentation helpers', () => {
  it('uses native HLS only where the element is the available player', () => {
    expect(nativeHls({ claims: () => 'maybe', apple: true, mse: true })).toBe(true);
    expect(nativeHls({ claims: () => 'maybe', apple: false, mse: true })).toBe(false);
  });

  it('crops measured letterboxing around the picture centre', () => {
    expect(cropStyle({ letterboxed: true, aspect: 2.4, rect: [0, 0.125, 1, 0.75] })).toContain(
      'scale(1.3333)',
    );
  });
});
