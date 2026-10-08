import { describe, expect, it, vi } from 'vitest';
import { availability } from './availability.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import type { RuntimeDiscoveryView } from './libraryServiceProtocol';
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

const runtime = (tmdbKey: string, pluginManifestUrls: string[] = []): RuntimeDiscoveryView => ({
  kind: 'runtime',
  tmdbKey,
  pluginManifestUrls,
  privateRemuxUrl: null,
});

const fakeModel = (overrides: Record<string, unknown> = {}) =>
  ({
    retainedServices: vi.fn().mockResolvedValue(null),
    retainServices: vi.fn().mockResolvedValue(undefined),
    rememberPrivateRemux: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as LibraryModel;

describe('SessionServices', () => {
  it('discovers once per normalized input and replaces a run cancelled across its yield', async () => {
    vi.useFakeTimers();
    discoveries = 0;
    let asked = 0;
    const services = new SessionServices(fakeModel(), async () => ({
      [`routes-${++asked}`]: [{ url: `/route-${asked}` }],
    }));

    services.configure(runtime('first', ['https://first.test/manifest.json']));
    expect(services.tmdbKey).toBe('first');
    await Promise.resolve();
    services.configure(runtime('second', ['https://second.test/manifest.json']));
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
    const services = new SessionServices(fakeModel(), async () => ({}));
    services.configure(runtime('tmdb'));
    await vi.waitFor(() => expect(services.scout?.base).toBe('/scout-1'));
    expect(connect).not.toHaveBeenCalledWith(services.scout, 'tmdb');

    connect.mockClear();
    services.foregroundReady();
    expect(connect).toHaveBeenCalledWith(services.scout, 'tmdb');
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
    const services = new SessionServices(model, () => routes);
    services.configure(runtime('tmdb'));
    await vi.waitFor(() => expect(services.atlas).toBe('/retained-atlas'));
    release({ live: [{ url: '/live' }] });
    await vi.waitFor(() => expect(services.atlas).not.toBe('/retained-atlas'));
    services.stop();
  });

  it('reports discovered private remux through the semantic model command', async () => {
    discoveries = 0;
    reaches = 'https://den-remux.tail.test';
    const rememberPrivateRemux = vi.fn().mockResolvedValue(undefined);
    const services = new SessionServices(fakeModel({ rememberPrivateRemux }), async () => ({}));
    services.configure(runtime('tmdb'));
    await vi.waitFor(() => expect(rememberPrivateRemux).toHaveBeenCalledWith(reaches));
    services.stop();
    reaches = undefined;
  });
});
