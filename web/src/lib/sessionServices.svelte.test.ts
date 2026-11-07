import { afterEach, describe, expect, it, vi } from 'vitest';
import { availability } from './availability.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import type { RuntimeDiscoveryView } from './libraryServiceProtocol';
import type { ContentServiceClientPort } from './contentServiceClient';
import { SessionServices } from './sessionServices.svelte';

let discoveries = 0;
let reaches: string | undefined;
/** atlas could not be reached at all (`discoverServices` publishes undefined). */
let atlasUnreachable = false;
let guestPluginUrls = $state.raw<string[]>([]);
let refreshGrants: () => Promise<'verified' | 'retained-unverified'> = async () => 'verified';
let autoDiscover = true;
const debridReads: Array<(value: { configured: boolean; reachable: boolean } | null) => void> = [];
const discoveryPublishes: Array<{
  scout?: (value: { base: string; install: string; playback?: string } | null) => void;
  atlas: (value: { base: string } | null) => void;
  reel: (value: { base: string } | null) => void;
  remux?: (value: string | null) => void;
}> = [];
vi.mock('./discoverServices', () => ({
  discoverServices: (
    _installed: string[],
    _routes: unknown,
    publish: {
      scout?: (value: { base: string; install: string; playback?: string } | null) => void;
      atlas: (value: { base: string } | null | undefined) => void;
      reel: (value: { base: string } | null) => void;
      remux?: (value: string | null) => void;
    },
  ) => {
    const run = ++discoveries;
    discoveryPublishes.push(publish);
    if (autoDiscover) {
      queueMicrotask(() =>
        publish.scout?.({
          base: `/scout-${run}`,
          install: '/scout',
          playback: `/scout-${run}/playback`,
        }),
      );
      queueMicrotask(() => publish.atlas(atlasUnreachable ? undefined : { base: `/atlas-${run}` }));
      queueMicrotask(() => publish.reel({ base: `/reel-${run}` }));
      if (reaches) queueMicrotask(() => publish.remux?.(reaches!));
    }
    return () => undefined;
  },
}));
vi.mock('./grants.svelte', () => ({
  guestGrants: { refresh: () => refreshGrants(), pluginUrls: () => guestPluginUrls },
}));
vi.mock('./debridStatus', () => ({
  readDebridState: () =>
    new Promise<{ configured: boolean; reachable: boolean } | null>((resolve) =>
      debridReads.push(resolve),
    ),
}));

const runtime = (pluginManifestUrls: string[] = []): RuntimeDiscoveryView => ({
  kind: 'runtime',
  pluginManifestUrls,
  privateRemuxUrl: null,
});
const content = {
  query: vi.fn(async () => ({ kind: 'sources.configure' })),
  onStatus: () => () => {},
} as unknown as ContentServiceClientPort;

const fakeModel = (overrides: Record<string, unknown> = {}) =>
  ({
    retainedServices: vi.fn().mockResolvedValue(null),
    retainServices: vi.fn().mockResolvedValue(undefined),
    rememberPrivateRemux: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as LibraryModel;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reaches = undefined;
  atlasUnreachable = false;
  guestPluginUrls = [];
  refreshGrants = async () => 'verified';
  autoDiscover = true;
  discoveryPublishes.length = 0;
  debridReads.length = 0;
});

describe('SessionServices', () => {
  it('discovers once per normalized input and replaces a run cancelled across its yield', async () => {
    vi.useFakeTimers();
    discoveries = 0;
    let asked = 0;
    const services = new SessionServices(fakeModel(), content, async () => ({
      [`routes-${++asked}`]: [{ url: `/route-${asked}` }],
    }));

    services.configure(runtime(['https://first.test/manifest.json']));
    await Promise.resolve();
    services.configure(runtime(['https://second.test/manifest.json']));
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(asked).toBe(2);
    expect(discoveries).toBe(1);
    expect(services.routes).toEqual({ 'routes-2': [{ url: '/route-2' }] });
    services.stop();
    vi.useRealTimers();
  });

  it('holds availability until the foreground signal', async () => {
    discoveries = 0;
    const connect = vi.spyOn(availability, 'connect');
    const model = fakeModel();
    const services = new SessionServices(model, content, async () => ({}));
    services.configure(runtime());
    await vi.waitFor(() => expect(services.scout?.base).toBe('/scout-1'));
    expect(connect).not.toHaveBeenCalledWith(services.scout, content);

    connect.mockClear();
    services.foregroundReady();
    expect(connect).toHaveBeenCalledWith(services.scout, content);
    services.stop();
  });

  it('does not publish a retained guest playback install from a grant no longer held', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    let release!: (routes: Record<string, Array<{ url: string }>>) => void;
    const routes = new Promise<Record<string, Array<{ url: string }>>>(
      (resolve) => (release = resolve),
    );
    const services = new SessionServices(
      fakeModel({
        retainedServices: vi.fn().mockResolvedValue({
          routes: {},
          scout: {
            base: '/den/~aaaaaaaa',
            install: 'https://den.example/den/~aaaaaaaa',
          },
          atlas: null,
          reel: null,
          remux: null,
        }),
      }),
      content,
      () => routes,
    );

    services.configure(runtime());
    await vi.waitFor(() => expect(services.atlasReady).toBe(true));
    expect(services.scout).toBeNull();
    release({});
    services.stop();
  });

  it('waits for grant refresh before retained paint and uses the refreshed authority', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    autoDiscover = false;
    let refreshed!: () => void;
    refreshGrants = () =>
      new Promise<'verified'>((resolve) => (refreshed = () => resolve('verified')));
    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    const retainedServices = vi.fn().mockResolvedValue({
      routes: {},
      scout: {
        base: '/den/~aaaaaaaa',
        install: 'https://den.example/den/~aaaaaaaa',
      },
      atlas: null,
      reel: null,
      remux: null,
    });
    const services = new SessionServices(
      fakeModel({ retainedServices }),
      content,
      async () => ({}),
    );
    services.configure(runtime());
    await Promise.resolve();
    expect(retainedServices).not.toHaveBeenCalled();
    expect(services.scout).toBeNull();

    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    refreshed();
    await vi.waitFor(() => expect(retainedServices).toHaveBeenCalledOnce());
    expect(services.scout).toBeNull();
    services.stop();
  });

  it('fails closed on grant refresh failure and recovers on the next configuration', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    autoDiscover = false;
    discoveries = 0;
    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    refreshGrants = async () => {
      throw new Error('offline');
    };
    const services = new SessionServices(fakeModel(), content, async () => ({}));
    services.configure(runtime());
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(1));
    expect(services.plugins).toEqual([]);
    expect(services.scout).toBeNull();

    refreshGrants = async () => 'verified';
    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    services.configure(runtime(['https://member.example/scout/manifest.json']));
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(2));
    expect(services.plugins).toEqual([
      'https://member.example/scout/manifest.json',
      'https://den.example/den/~bbbbbbbb/manifest.json',
    ]);
    services.stop();
  });

  it('does not start discovery after a stopped profile refresh completes', async () => {
    let refreshed!: () => void;
    refreshGrants = () =>
      new Promise<'verified'>((resolve) => (refreshed = () => resolve('verified')));
    const retainedServices = vi.fn().mockResolvedValue(null);
    const services = new SessionServices(
      fakeModel({ retainedServices }),
      content,
      async () => ({}),
    );
    services.configure(runtime());
    services.stop();
    refreshed();
    await Promise.resolve();
    await Promise.resolve();
    expect(retainedServices).not.toHaveBeenCalled();
  });

  it('withdraws A immediately on A→B→A authority replacement and fences stale discovery', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    autoDiscover = false;
    discoveries = 0;
    const connect = vi.spyOn(availability, 'connect');
    const services = new SessionServices(fakeModel(), content, async () => ({}));
    services.foregroundReady();

    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    services.configure(runtime());
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(1));
    const a = { base: '/den/~aaaaaaaa', install: 'https://den.example/den/~aaaaaaaa' };
    discoveryPublishes[0]!.scout?.(a);
    expect(services.scout).toEqual(a);

    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    services.configure(runtime());
    expect(services.scout).toBeNull();
    expect(connect).toHaveBeenLastCalledWith(null, content);
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(2));
    discoveryPublishes[0]!.scout?.(a);
    expect(services.scout).toBeNull();
    const b = { base: '/den/~bbbbbbbb', install: 'https://den.example/den/~bbbbbbbb' };
    discoveryPublishes[1]!.scout?.(b);
    expect(services.scout).toEqual(b);

    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    services.configure(runtime());
    expect(services.scout).toBeNull();
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(3));
    discoveryPublishes[1]!.scout?.(b);
    expect(services.scout).toBeNull();
    discoveryPublishes[2]!.scout?.(a);
    expect(services.scout).toEqual(a);
    services.stop();
  });

  it('stops A before a held B refresh and requires a new refresh after A→B→A', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    autoDiscover = false;
    discoveries = 0;
    let refreshes = 0;
    const held: Array<(outcome: 'verified') => void> = [];
    refreshGrants = () => {
      refreshes++;
      if (refreshes === 1) return Promise.resolve('verified');
      return new Promise<'verified'>((resolve) => held.push(resolve));
    };
    const model = fakeModel();
    const services = new SessionServices(model, content, async () => ({}));

    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    services.configure(runtime());
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(1));
    const first = discoveryPublishes[0]!;
    first.scout?.({
      base: '/den/~aaaaaaaa',
      install: 'https://den.example/den/~aaaaaaaa',
    });
    first.atlas({ base: '/atlas-a' });
    first.reel({ base: '/reel-a' });
    first.remux?.('/remux-a');
    await vi.waitFor(() => expect(services.atlas).toBe('/atlas-a'));
    expect(debridReads).toHaveLength(1);

    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    services.configure(runtime());
    expect(services.scout).toBeNull();
    expect(services.atlas).toBeNull();
    expect(services.reel).toBeNull();
    expect(services.remux).toBeNull();
    expect(refreshes).toBe(2);

    first.scout?.({
      base: '/late-scout-a',
      install: 'https://den.example/den/~aaaaaaaa',
    });
    first.atlas({ base: '/late-atlas-a' });
    first.reel({ base: '/late-reel-a' });
    first.remux?.('/late-remux-a');
    debridReads[0]!({ configured: true, reachable: true });
    await Promise.resolve();
    expect(services.scout).toBeNull();
    expect(services.atlas).toBeNull();
    expect(services.reel).toBeNull();
    expect(services.remux).toBeNull();
    expect(services.debrid).toBeNull();

    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    services.configure(runtime());
    held[0]!('verified');
    await vi.waitFor(() => expect(refreshes).toBe(3));
    expect(discoveryPublishes).toHaveLength(1);
    held[1]!('verified');
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(2));
    expect(model.retainedServices).toHaveBeenCalledOnce();
    discoveryPublishes[1]!.reel({ base: '/reel-a-again' });
    expect(services.reel).toBe('/reel-a-again');
    services.stop();
  });

  it('retries unchanged route discovery with a bounded cancelable schedule', async () => {
    vi.useFakeTimers();
    autoDiscover = false;
    let attempts = 0;
    const services = new SessionServices(fakeModel(), content, async () => {
      attempts++;
      if (attempts < 3) throw new Error('route discovery failed');
      return { atlas: [{ url: '/atlas' }] };
    });
    services.configure(runtime());
    await vi.runAllTicks();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(3);
    await vi.runAllTimersAsync();
    expect(services.routes).toEqual({ atlas: [{ url: '/atlas' }] });
    services.stop();

    attempts = 0;
    const stopped = new SessionServices(fakeModel(), content, async () => {
      attempts++;
      throw new Error('route discovery failed');
    });
    stopped.configure(runtime(['different']));
    await vi.runAllTicks();
    expect(attempts).toBe(1);
    stopped.stop();
    await vi.runAllTimersAsync();
    expect(attempts).toBe(1);
  });

  it('retries an unchanged retained grant after production-style resolved fetch failure', async () => {
    vi.useFakeTimers();
    autoDiscover = false;
    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    let attempts = 0;
    refreshGrants = async () => (++attempts === 1 ? 'retained-unverified' : 'verified');
    const services = new SessionServices(fakeModel(), content, async () => ({}));
    services.configure(runtime());
    await vi.runAllTicks();
    expect(services.plugins).toEqual([]);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    expect(services.plugins).toEqual(guestPluginUrls);
    services.stop();
  });

  it('keeps an incompatible Scout withdrawn when replacement route discovery fails', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    autoDiscover = false;
    discoveries = 0;
    let fail = false;
    const services = new SessionServices(fakeModel(), content, async () => {
      if (fail) throw new Error('route discovery failed');
      return {};
    });
    guestPluginUrls = ['https://den.example/den/~aaaaaaaa/manifest.json'];
    services.configure(runtime());
    await vi.waitFor(() => expect(discoveryPublishes).toHaveLength(1));
    discoveryPublishes[0]!.scout?.({
      base: '/den/~aaaaaaaa',
      install: 'https://den.example/den/~aaaaaaaa',
    });
    expect(services.scout).not.toBeNull();

    fail = true;
    guestPluginUrls = ['https://den.example/den/~bbbbbbbb/manifest.json'];
    services.configure(runtime());
    expect(services.scout).toBeNull();
    await Promise.resolve();
    expect(services.scout).toBeNull();
    services.stop();
  });

  it('paints retained discovery while live probes are pending', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/' });
    let release!: (routes: Record<string, Array<{ url: string }>>) => void;
    const routes = new Promise<Record<string, Array<{ url: string }>>>(
      (resolve) => (release = resolve),
    );
    const model = fakeModel({
      retainedServices: vi.fn().mockResolvedValue({
        routes: { retained: [{ url: '/retained' }] },
        scout: {
          base: '/retained-scout',
          install: '/scout',
          // Simulates a retained value written by an earlier build. Runtime capability must be reprobed.
          playback: '/retained-scout/playback',
        },
        atlas: '/retained-atlas',
        reel: '/retained-reel',
        remux: null,
      }),
    });
    const services = new SessionServices(model, content, () => routes);
    services.configure(runtime(['/scout/manifest.json']));
    await vi.waitFor(() => expect(services.atlas).toBe('/retained-atlas'));
    expect(services.scout).toEqual({ base: '/retained-scout', install: '/scout' });
    release({ live: [{ url: '/live' }] });
    await vi.waitFor(() => expect(services.atlas).not.toBe('/retained-atlas'));
    services.stop();
  });

  it('does not publish Atlas until the content Worker acknowledges its configuration', async () => {
    discoveries = 0;
    let acknowledge!: () => void;
    const configured = new Promise<void>((resolve) => (acknowledge = resolve));
    const heldContent = {
      query: vi.fn(async () => {
        await configured;
        return { kind: 'sources.configure' as const };
      }),
      onStatus: () => () => {},
    } as unknown as ContentServiceClientPort;
    const services = new SessionServices(fakeModel(), heldContent, async () => ({}));

    services.configure(runtime());
    await vi.waitFor(() => expect(heldContent.query).toHaveBeenCalledOnce());
    expect(services.atlas).toBeNull();
    expect(services.atlasReady).toBe(false);

    acknowledge();
    await vi.waitFor(() => expect(services.atlas).toBe('/atlas-1'));
    expect(services.atlasReady).toBe(true);
    services.stop();
  });

  it('does not let a stale Atlas acknowledgement replace a newer discovery run', async () => {
    discoveries = 0;
    const acknowledgements = new Map<string | null, () => void>();
    const heldContent = {
      query: vi.fn(
        (request: { kind: string; atlas: string | null }) =>
          new Promise<{ kind: 'sources.configure' }>((resolve) =>
            acknowledgements.set(request.atlas, () => resolve({ kind: 'sources.configure' })),
          ),
      ),
      onStatus: () => () => {},
    } as unknown as ContentServiceClientPort;
    const services = new SessionServices(fakeModel(), heldContent, async () => ({}));

    services.configure(runtime(['first']));
    await vi.waitFor(() => expect(acknowledgements.has('/atlas-1')).toBe(true));
    services.configure(runtime(['second']));
    await vi.waitFor(() => expect(acknowledgements.has('/atlas-2')).toBe(true));

    acknowledgements.get('/atlas-2')!();
    await vi.waitFor(() => expect(services.atlas).toBe('/atlas-2'));
    acknowledgements.get('/atlas-1')!();
    await Promise.resolve();
    expect(services.atlas).toBe('/atlas-2');
    expect(services.atlasReady).toBe(true);
    services.stop();
  });

  it('reports discovered private remux through the semantic model command', async () => {
    discoveries = 0;
    reaches = 'https://den-remux.tail.test';
    const rememberPrivateRemux = vi.fn().mockResolvedValue(undefined);
    const services = new SessionServices(
      fakeModel({ rememberPrivateRemux }),
      content,
      async () => ({}),
    );
    services.configure(runtime());
    await vi.waitFor(() => expect(rememberPrivateRemux).toHaveBeenCalledWith(reaches));
    services.stop();
    reaches = undefined;
  });

  it('cancels an old retention timer when discovery inputs change', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('scheduler', { yield: () => Promise.resolve() });
    discoveries = 0;
    const retainServices = vi.fn().mockResolvedValue(undefined);
    const services = new SessionServices(fakeModel({ retainServices }), content, async () => ({
      scout: [{ url: '/scout' }],
    }));

    services.configure(runtime(['first']));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(services.atlas).toBe('/atlas-1');
    services.configure(runtime(['second']));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(retainServices).toHaveBeenCalledOnce();
    expect(retainServices.mock.calls[0]?.[0]).toMatchObject({
      scout: { base: '/scout-2' },
      atlas: '/atlas-2',
      reel: '/reel-2',
    });
    expect(retainServices.mock.calls[0]?.[0].scout).not.toHaveProperty('playback');
    services.stop();
  });

  /**
   * den-edge down: `/routes` comes from Cloudflare's copy (so the live table wins over the retained hint) and atlas's
   * manifest cannot be reached. That does not say atlas is gone, so the address the last visit found is configured and
   * the content Worker can hand out what it kept of atlas.
   */
  it('keeps the retained atlas while atlas cannot be reached', async () => {
    atlasUnreachable = true;
    discoveries = 0;
    const services = new SessionServices(
      fakeModel({
        retainedServices: vi.fn().mockResolvedValue({
          routes: { atlas: [{ url: '/retained' }] },
          scout: null,
          atlas: '/retained-atlas',
          reel: null,
          remux: null,
        }),
      }),
      content,
      async () => ({ atlas: [{ url: '/live' }] }),
    );
    services.configure(runtime());
    await vi.waitFor(() => expect(discoveries).toBe(1));
    // Every hint, probe and acknowledgement is settled by then.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.atlas).toBe('/retained-atlas');
    expect(services.atlasReady).toBe(true);
    services.stop();
  });

  it('treats a rejected retained hint as a cache miss', async () => {
    const services = new SessionServices(
      fakeModel({ retainedServices: vi.fn().mockRejectedValue(new Error('closed')) }),
      content,
      async () => ({}),
    );
    services.configure(runtime());
    await vi.waitFor(() => expect(services.atlasReady).toBe(true));
    expect(services.atlas).toBeTruthy();
    services.stop();
  });
});
