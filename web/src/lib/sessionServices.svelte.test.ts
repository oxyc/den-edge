import { describe, expect, it, vi } from 'vitest';
import type { LibraryLog } from './log';
import type { SettingsRow } from './wire';
import { SessionServices } from './sessionServices.svelte';

vi.mock('./discoverServices', () => ({
  discoverServices: (
    _installed: string[],
    _routes: unknown,
    publish: {
      atlas: (value: { base: string } | null) => void;
      remux?: (value: string | null) => void;
    },
  ) => {
    discoveries++;
    queueMicrotask(() => publish.atlas({ base: `/atlas-${discoveries}` }));
    const remux = reaches;
    if (remux) queueMicrotask(() => publish.remux?.(remux));
    return () => undefined;
  },
}));
vi.mock('./syncLoader', () => ({ ensureSyncPolicy: async () => undefined }));
vi.mock('./grants.svelte', () => ({
  guestGrants: { refresh: async () => undefined, pluginUrls: () => [] },
}));
let discoveries = 0;
/** Where the mocked discovery finds den-remux; undefined publishes nothing for it. */
let reaches: string | undefined;

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

  it('keeps where den-remux answered without discovering again for that write', async () => {
    discoveries = 0;
    reaches = 'https://den-remux.tail1234.ts.net';
    let stored: SettingsRow | undefined;
    const log = {
      settings: (name: string) => (name === 'addresses' ? stored : undefined),
      newestStamp: () => [0, 0, 'x'],
      write: async (row: SettingsRow) => ((stored = row), true),
      kept: async () => undefined,
      keep: async () => undefined,
    } as unknown as LibraryLog;
    let changes = 0;
    const services: SessionServices = new SessionServices(
      async () => ({}),
      // As the session does: the settings revision moves, and every page configures again.
      () => (changes++, services.configure(log)),
    );
    services.configure(log);
    await vi.waitFor(() => expect(changes).toBe(1));
    expect(Object.keys(stored?.values ?? {})).toEqual(['remux']);
    expect(services.remux).toBe('https://den-remux.tail1234.ts.net');
    await Promise.resolve();
    expect(discoveries).toBe(1);
    reaches = undefined;
    services.stop();
  });
});
