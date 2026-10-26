import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryFactStore, type LibraryFactEntry } from './libraryFactStore';
import type { Vault, VaultChange } from './localVault';
import { ensureSyncPolicy } from './syncLoader';
import type { DocumentRow, Stamp } from './wire';

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  failCommit = false;

  async get(key: string) {
    return this.values.get(key)?.slice();
  }
  async entries(prefix: string) {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, value.slice()] as [string, Uint8Array]);
  }
  async page(prefix: string, after: string | undefined, limit: number) {
    return (await this.entries(prefix))
      .filter(([key]) => after === undefined || key > after)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit);
  }
  async put(key: string, value: Uint8Array) {
    this.values.set(key, value.slice());
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async remove(prefix: string) {
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key);
  }
  async commit(changes: readonly VaultChange[]) {
    if (this.failCommit) throw new Error('injected atomic commit failure');
    const replacement = new Map(this.values);
    for (const change of changes) {
      if (change.kind === 'put') replacement.set(change.key, change.value.slice());
      else replacement.delete(change.key);
    }
    this.values.clear();
    for (const [key, value] of replacement) this.values.set(key, value);
  }
}

const raw = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
const libraryKey = btoa(String.fromCharCode(...raw));
const device = 'aaaaaaaaaaaaaaaa';
const stamp = (at: number): Stamp => [at, 0, device];
const key = (number: number) => number.toString(16).padStart(64, '0');

const movie = (
  id: number,
  watchedAt: number,
  extra: Record<string, unknown> = {},
): DocumentRow => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id },
  status: { value: 'watched', at: stamp(watchedAt) },
  addedAt: watchedAt,
  ...extra,
});

const series = (id: number, watchedAt: number): DocumentRow[] => [
  {
    format: 4,
    kind: 'title',
    title: { type: 'tv', id },
    status: { value: 'watchlist', at: stamp(1) },
    addedAt: 1,
  },
  {
    format: 4,
    kind: 'season',
    title: { type: 'tv', id },
    season: 1,
    seasonReset: null,
    episodes: {
      1: {
        progress: { value: 1, at: stamp(watchedAt), viewing: 0 },
        imported: false,
        plays: { 0: watchedAt },
        cleared: null,
      },
    },
  },
];

const entry = (k: string, seq: number, row: DocumentRow | null): LibraryFactEntry => ({
  k,
  seq,
  value: `ciphertext-${seq}`,
  row,
});

const snapshot = (vault: MemoryVault) =>
  new Map([...vault.values].map(([storedKey, value]) => [storedKey, [...value]]));

beforeAll(async () => ensureSyncPolicy());

describe('compact History checkpoint', () => {
  it('publishes only with a complete fact manifest and rehydrates years in the current timezone', async () => {
    const nativeResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const resolvedOptions = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    try {
      resolvedOptions.mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...nativeResolvedOptions.call(this), timeZone: 'UTC' };
      });
      const nearNewYear = Date.UTC(2024, 0, 1, 1);
      const vault = new MemoryVault();
      const store = (await LibraryFactStore.open(libraryKey, vault))!;
      await store.commitBatch('generation-a', 1, [entry(key(1), 1, movie(1, nearNewYear))], false);
      const partial = (await store.manifest())!;
      await expect(store.history(partial)).resolves.toBeNull();
      expect([...vault.values.keys()].some((storedKey) => storedKey.endsWith(':history'))).toBe(
        false,
      );

      await store.commitBatch(
        'generation-a',
        3,
        series(2, nearNewYear + 1).map((row, index) => entry(key(index + 2), index + 2, row)),
        true,
      );
      const complete = (await store.manifest())!;
      const utc = (await store.history(complete))!;
      expect(utc.page({ year: '2024' })?.total).toBe(2);

      resolvedOptions.mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...nativeResolvedOptions.call(this), timeZone: 'America/Los_Angeles' };
      });
      const pacific = (await store.history(complete))!;
      expect(pacific.page({ year: '2023' })?.total).toBe(2);
      expect(pacific.page({ year: '2024' })?.total).toBe(0);
      expect(pacific.page()!.items).toEqual(utc.page()!.items);
      expect(pacific.revision).not.toBe(utc.revision);
    } finally {
      resolvedOptions.mockRestore();
    }
  });

  it('atomically keeps a one-title replacement and rejects the predecessor source identity', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch('generation-a', 1, [entry(key(1), 1, movie(1, 1_000))], true);
    const beforeManifest = (await store.manifest())!;
    const before = snapshot(vault);

    vault.failCommit = true;
    await expect(
      store.keepRows('generation-a', [entry(key(1), 2, movie(1, 9_000))]),
    ).rejects.toThrow('injected atomic commit failure');
    expect(snapshot(vault)).toEqual(before);
    await expect(store.history(beforeManifest)).resolves.toMatchObject({ source: { version: 1 } });

    vault.failCommit = false;
    await store.keepRows('generation-a', [entry(key(1), 2, movie(1, 9_000))]);
    const afterManifest = (await store.manifest())!;
    expect(afterManifest.revision).not.toBe(beforeManifest.revision);
    await expect(store.history(beforeManifest)).resolves.toBeNull();
    expect((await store.history(afterManifest))?.page()!.items).toMatchObject([
      { title: { type: 'movie', id: 1 }, watchedAt: 9_000 },
    ]);
  });

  it('repairs a corrupt disposable checkpoint from authoritative documents', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch('generation-a', 1, [entry(key(1), 1, movie(1, 1_000))], true);
    const firstManifest = (await store.manifest())!;
    const historyKey = [...vault.values.keys()].find((storedKey) =>
      storedKey.endsWith(':history'),
    )!;
    vault.values.set(historyKey, new Uint8Array([1, 2, 3]));
    await expect(store.history(firstManifest)).resolves.toBeNull();
    await expect(store.document('generation-a', key(1))).resolves.toMatchObject({
      row: { kind: 'title', title: { type: 'movie', id: 1 } },
    });

    await store.commitBatch('generation-a', 1, [], true);
    const repairedManifest = (await store.manifest())!;
    expect(repairedManifest.revision).not.toBe(firstManifest.revision);
    expect((await store.history(repairedManifest))?.page()!.items).toMatchObject([
      { title: { type: 'movie', id: 1 }, watchedAt: 1_000 },
    ]);
  });

  it('replaces generation membership and atomically deletes a checkpoint for an incomplete source', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch('generation-a', 1, [entry(key(1), 1, movie(1, 1_000))], true);
    const complete = (await store.manifest())!;
    expect((await store.history(complete))?.page()!.items[0]?.title.id).toBe(1);

    const beforePartial = snapshot(vault);
    vault.failCommit = true;
    await expect(
      store.commitBatch('generation-b', 1, [entry(key(2), 1, movie(2, 2_000))], false),
    ).rejects.toThrow('injected atomic commit failure');
    expect(snapshot(vault)).toEqual(beforePartial);

    vault.failCommit = false;
    await store.commitBatch('generation-b', 1, [entry(key(2), 1, movie(2, 2_000))], false);
    const partial = (await store.manifest())!;
    expect(partial).toMatchObject({ generation: 'generation-b', complete: false });
    await expect(store.history(partial)).resolves.toBeNull();
    expect([...vault.values.keys()].some((storedKey) => storedKey.endsWith(':history'))).toBe(
      false,
    );

    await store.commitBatch('generation-b', 1, [], true);
    const replacement = (await store.manifest())!;
    expect((await store.history(replacement))?.page()!.items.map((item) => item.title.id)).toEqual([
      2,
    ]);
  });

  it('expires at a future-stamp deadline and rebuilds with the newly-effective projection', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 0, 1);
      const future = now + 86_400_000 + 60_000;
      const believableAt = now + 60_000;
      vi.setSystemTime(now);
      const vault = new MemoryVault();
      const store = (await LibraryFactStore.open(libraryKey, vault))!;
      await store.commitBatch('generation-a', 1, [entry(key(1), 1, movie(1, future))], true);
      const before = (await store.manifest())!;
      const initial = (await store.history(before))!;
      expect(initial.source.reconsiderAt).toBe(believableAt);
      expect(initial.page()!.items).toMatchObject([
        { title: { type: 'movie', id: 1 }, watchedAt: 0 },
      ]);

      vi.setSystemTime(believableAt);
      await expect(store.history(before)).resolves.toBeNull();

      // A normal complete reconciliation repairs the disposable checkpoint from the same authoritative document.
      await store.commitBatch('generation-a', 1, [], true);
      const after = (await store.manifest())!;
      const rebuilt = (await store.history(after))!;
      expect(rebuilt.source.reconsiderAt).toBeNull();
      expect(rebuilt.page()!.items).toMatchObject([
        { title: { type: 'movie', id: 1 }, watchedAt: future },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
