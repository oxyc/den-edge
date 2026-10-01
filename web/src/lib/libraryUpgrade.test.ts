import { expect, it, vi } from 'vitest';
import { upgradeLibrary } from './libraryUpgrade';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import type { TitleRow } from './wire';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function memoryVault(): Vault {
  const data = new Map<string, Uint8Array>();
  return {
    get: async (k) => data.get(k),
    put: async (k, value) => void data.set(k, value),
    remove: async (prefix) => {
      for (const k of [...data.keys()]) if (k.startsWith(prefix)) data.delete(k);
    },
  };
}

const title: TitleRow = {
  kind: 'rec',
  schema: 2,
  title: { type: 'movie', id: 1 },
  status: { value: 'watchlist', at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
  resume: { value: 0, at: [1000, 0, 'aaaaaaaaaaaaaaaa'], viewing: 0 },
  reaction: { value: null, at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
  deleted: { value: false, at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
  dismissed: { value: false, at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
  episodesReset: null,
  addedAt: 1000,
  watchedAt: null,
};

it('switches a library kept only in this browser to v3 without being asked', async () => {
  const vault = memoryVault();
  const log = (await LibraryLog.openLocal(KEY, vault))!;
  await log.write(title);
  expect(await upgradeLibrary(log, true)).toBe(true);
  expect(log.wireMinimum).toBe(3);
  expect(log.title({ type: 'movie', id: 1 })).toBeDefined();
  expect((await LibraryLog.openLocal(KEY, vault))!.wireMinimum).toBe(3);
  // Already v3: nothing more to do.
  expect(await upgradeLibrary(log, true)).toBe(false);
});

it('tries a switch that did not happen again only after a while, not on every refresh', async () => {
  const switchWebOnly = vi.fn(async () => false);
  const log = {
    wireMinimum: 2,
    moved: false,
    upgradeRequired: null,
    newestStamp: () => [0, 0, ''],
    settings: () => undefined,
    switchWebOnly,
  } as unknown as LibraryLog;
  expect(await upgradeLibrary(log, true, 1_000)).toBe(false);
  expect(await upgradeLibrary(log, true, 31_000)).toBe(false);
  expect(switchWebOnly).toHaveBeenCalledTimes(1);
  await upgradeLibrary(log, true, 1_000 + 10 * 60_000);
  expect(switchWebOnly).toHaveBeenCalledTimes(2);
});
