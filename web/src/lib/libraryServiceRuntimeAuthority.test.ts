import { describe, expect, it } from 'vitest';
import { openClockStore } from './clockStore';
import type { DownloadContent } from './downloadServiceRuntime';
import { LIBRARY_SERVICE_PROTOCOL, type LibraryServiceHello } from './libraryServiceProtocol';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import { upgradeLibrary } from './libraryUpgrade';
import { openHandover } from './pair';
import { unseal } from './recovery';
import { toBase64url } from './wire';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(31)));
const content = {
  identifiers: async () => ({ kind: 'missing' as const }),
  season: async () => ({ kind: 'missing' as const }),
} satisfies DownloadContent;

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
      undefined,
      content,
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
    await expect(
      openLibraryServiceAuthority(hello(), null, undefined, content),
    ).resolves.toBeNull();
  });

  it('keeps recovery, pairing, import, and export material behind typed service calls', async () => {
    const vault = memoryVault();
    const seed = await LibraryLog.openLocal(KEY, vault);
    expect(seed).not.toBeNull();
    const seedClock = await openClockStore(vault, { legacy: { device: '0123456789abcdef' } });
    await upgradeLibrary(seed!, true, 1_000, seedClock);
    expect(seed!.wireMinimum).toBe(3);
    await seedClock.issue(1_000_000);
    seed!.close();
    const authority = await openLibraryServiceAuthority(
      hello({ device: '0123456789abcdef' }),
      vault,
      undefined,
      content,
    );
    expect(authority).not.toBeNull();

    const reset = await authority!.query({ kind: 'key-reset.prepare' });
    expect(reset).toMatchObject({ kind: 'key-reset.prepare' });
    expect(
      atob(reset.kind === 'key-reset.prepare' ? reset.destinationLibraryKey : ''),
    ).toHaveLength(32);

    const wrapKey = new Uint8Array(32).fill(7);
    const locator = 'a'.repeat(32);
    const recovered = await authority!.query({
      kind: 'recovery.seal',
      locator,
      wrapKey: toBase64url(wrapKey),
      createdAt: 10_000,
    });
    expect(recovered.kind).toBe('recovery.seal');
    await expect(
      unseal({ locator, wrapKey }, recovered.kind === 'recovery.seal' ? recovered.sealed : ''),
    ).resolves.toEqual(new Uint8Array(32).fill(31));

    const handoverKey = new Uint8Array(32).fill(9);
    const handover = await authority!.query({
      kind: 'pairing.handover',
      handoverKey: toBase64url(handoverKey),
      host: 'This browser',
    });
    expect(handover.kind).toBe('pairing.handover');
    const opened = await openHandover(
      handoverKey,
      fromBase64urlForTest(handover.kind === 'pairing.handover' ? handover.sealed : ''),
    );
    expect(opened).toMatchObject({
      host: 'This browser',
      hostDeviceId: '0123456789abcdef',
      libraryKey: new Uint8Array(32).fill(31),
    });

    const imported = await authority!.task!(
      {
        kind: 'history.import',
        items: [{ title: { type: 'movie', id: 77 }, watchedAt: 20_000 }],
      },
      'import-history',
    );
    expect(imported.result).toEqual({
      kind: 'history.import',
      written: 1,
      total: 1,
      complete: true,
    });
    const exported = await authority!.query({ kind: 'history.export' });
    expect(exported).toMatchObject({
      kind: 'history.export',
      titles: [
        {
          type: 'movie',
          tmdbId: 77,
          status: 'watched',
          plays: [{ watchedAt: new Date(20_000).toISOString(), source: 'import' }],
        },
      ],
    });
    expect(JSON.stringify(exported)).not.toContain('schema');
    expect(JSON.stringify(exported)).not.toContain('document');

    const sourceKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
    const source = await openLibraryServiceAuthority(
      { ...hello(), requestId: 'source', clientId: 'source', libraryKey: sourceKey },
      vault,
      undefined,
      content,
    );
    await source!.command(
      { kind: 'watchlist.add', title: { type: 'movie', id: 88 } },
      'source-watchlist',
    );
    await source!.close?.();
    await expect(
      authority!.task!({ kind: 'local-library.merge', sourceLibraryKey: sourceKey }, 'merge-local'),
    ).resolves.toMatchObject({ result: { outcome: 'merged' } });
    await expect(
      authority!.select({ kind: 'title', title: { type: 'movie', id: 88 } }),
    ).resolves.toMatchObject({ listed: true, standing: 'watchlist' });
    await authority!.close?.();
  });
});

const fromBase64urlForTest = (value: string) => {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(
    atob(standard + '='.repeat((4 - (standard.length % 4)) % 4)),
    (character) => character.charCodeAt(0),
  );
};
