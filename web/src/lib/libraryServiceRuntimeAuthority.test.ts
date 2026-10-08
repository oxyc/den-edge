import { describe, expect, it } from 'vitest';
import { openClockStore } from './clockStore';
import { LIBRARY_SERVICE_PROTOCOL, type LibraryServiceHello } from './libraryServiceProtocol';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';
import type { Vault } from './localVault';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(31)));

function memoryVault(): Vault {
  const data = new Map<string, Uint8Array>();
  return {
    get: async (key) => data.get(key)?.slice(),
    entries: async (prefix) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, value.slice()]),
    put: async (key, value) => void data.set(key, value.slice()),
    update: async (key, updater) => {
      const next = updater(data.get(key)?.slice());
      data.set(key, next.slice());
      return next.slice();
    },
    delete: async (key) => void data.delete(key),
    remove: async (prefix) => {
      for (const key of data.keys()) if (key.startsWith(prefix)) data.delete(key);
    },
  };
}

const hello = (legacyClock?: LibraryServiceHello['legacyClock']): LibraryServiceHello => ({
  type: 'hello',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId: 'open-1',
  clientId: 'tab-1',
  libraryKey: KEY,
  mode: 'local',
  ...(legacyClock ? { legacyClock } : {}),
});

describe('openLibraryServiceAuthority', () => {
  it('opens a local log and durable clock from the validated legacy seed', async () => {
    const vault = memoryVault();
    const authority = await openLibraryServiceAuthority(
      hello({ device: '0123456789abcdef', last: [4_000, 2, 'fedcba9876543210'] }),
      vault,
    );

    expect(authority).not.toBeNull();
    await expect(
      authority!.command({ kind: 'watchlist.add', title: { type: 'movie', id: 7 } }, 'watchlist-7'),
    ).resolves.toMatchObject({ outcome: 'applied', delivery: 'local' });
    await expect(
      authority!.select({ kind: 'title', title: { type: 'movie', id: 7 } }),
    ).resolves.toMatchObject({ listed: true });

    const reopenedClock = await openClockStore(vault);
    expect(reopenedClock.device).toBe('0123456789abcdef');
    expect((await reopenedClock.current())[0]).toBeGreaterThanOrEqual(4_000);
    await authority!.close?.();
  });

  it('does not create a non-durable authority when IndexedDB is unavailable', async () => {
    await expect(openLibraryServiceAuthority(hello(), null)).resolves.toBeNull();
  });
});
