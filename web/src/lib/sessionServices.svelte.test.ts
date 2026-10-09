import { afterEach, describe, expect, it, vi } from 'vitest';
import { availability } from './availability.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import type { RuntimeDiscoveryView } from './libraryServiceProtocol';
import type { ContentServiceClientPort } from './libraryServiceFactory';
import { SessionServices } from './sessionServices.svelte';

let discoveries = 0;
let reaches: string | undefined;
vi.mock('./discoverServices', () => ({
  discoverServices: (
    _installed: string[],
    _routes: unknown,
    publish: {
      scout?: (value: { base: string; install: string } | null) => void;
      atlas: (value: { base: string } | null) => void;
      reel: (value: { base: string } | null) => void;
      remux?: (value: string | null) => void;
    },
  ) => {
    const run = ++discoveries;
    queueMicrotask(() => publish.scout?.({ base: `/scout-${run}`, install: '/scout' }));
    queueMicrotask(() => publish.atlas({ base: `/atlas-${run}` }));
    queueMicrotask(() => publish.reel({ base: `/reel-${run}` }));
    if (reaches) queueMicrotask(() => publish.remux?.(reaches!));
    return () => undefined;
  },
}));
vi.mock('./grants.svelte', () => ({
  guestGrants: { refresh: async () => undefined, pluginUrls: () => [] },
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
    const services = new SessionServices(fakeModel(), content, async () => ({}));
    services.configure(runtime());
    await vi.waitFor(() => expect(services.scout?.base).toBe('/scout-1'));
    expect(connect).not.toHaveBeenCalledWith(services.scout, content);

    connect.mockClear();
    services.foregroundReady();
    expect(connect).toHaveBeenCalledWith(services.scout, content);
    services.stop();
  });

  it('paints retained discovery while live probes are pending', async () => {
    let release!: (routes: Record<string, Array<{ url: string }>>) => void;
    const routes = new Promise<Record<string, Array<{ url: string }>>>(
      (resolve) => (release = resolve),
    );
    const model = fakeModel({
      retainedServices: vi.fn().mockResolvedValue({
        routes: { retained: [{ url: '/retained' }] },
        scout: { base: '/retained-scout', install: '/scout' },
        atlas: '/retained-atlas',
        reel: '/retained-reel',
        remux: null,
      }),
    });
    const services = new SessionServices(model, content, () => routes);
    services.configure(runtime());
    await vi.waitFor(() => expect(services.atlas).toBe('/retained-atlas'));
    release({ live: [{ url: '/live' }] });
    await vi.waitFor(() => expect(services.atlas).not.toBe('/retained-atlas'));
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
