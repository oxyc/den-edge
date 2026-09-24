import { describe, expect, it, vi } from 'vitest';
import type { LibraryLog } from './log';
import { SessionServices } from './sessionServices.svelte';

vi.mock('./discoverServices', () => ({
  discoverServices: (
    _installed: string[],
    _routes: unknown,
    publish: { atlas: (value: { base: string } | null) => void },
  ) => {
    discoveries++;
    queueMicrotask(() => publish.atlas({ base: `/atlas-${discoveries}` }));
    return () => undefined;
  },
}));
vi.mock('./grants.svelte', () => ({
  guestGrants: { refresh: async () => undefined, pluginUrls: () => [] },
}));
let discoveries = 0;

const logWith = (plugins: string[]) =>
  ({
    settings: (name: string) =>
      name === 'plugins'
        ? {
            kind: 'set',
            schema: 2,
            name,
            values: Object.fromEntries(
              plugins.map((url) => [url, { value: { bool: true }, at: [1, 0, 'x'] }]),
            ),
          }
        : undefined,
    kept: async () => undefined,
    keep: async () => undefined,
  }) as unknown as LibraryLog;

describe('SessionServices', () => {
  it('discovers once for every page, and again only when what it reads changes, keeping what it found', async () => {
    discoveries = 0;
    let asked = 0;
    const services = new SessionServices(
      async () => (asked++, {}),
      () => undefined,
    );
    const log = logWith([]);
    // Three pages mount, each asking.
    services.configure(log);
    services.configure(log);
    services.configure(log);
    await vi.waitFor(() => expect(services.atlasReady).toBe(true));
    expect(asked).toBe(1);
    expect(discoveries).toBe(1);
    expect(services.atlas).toBe('/atlas-1');

    // A settings change that leaves discovery's inputs alone starts nothing.
    services.configure(logWith([]));
    await Promise.resolve();
    expect(asked).toBe(1);

    // One that changes them asks again, and what was found stays until the new answer.
    services.configure(logWith(['https://addon.test/manifest.json']));
    expect(services.atlasReady).toBe(true);
    expect(services.atlas).toBe('/atlas-1');
    await vi.waitFor(() => expect(services.atlas).toBe('/atlas-2'));
    expect(asked).toBe(2);
    services.stop();
  });
});
