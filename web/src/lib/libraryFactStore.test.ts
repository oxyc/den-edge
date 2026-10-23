import { beforeAll, describe, expect, it } from 'vitest';
import { LibraryFactStore } from './libraryFactStore';
import type { Vault, VaultChange } from './localVault';
import { ensureSyncPolicy } from './syncLoader';
import type { TitleRow } from './wire';

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  failCommit = false;
  commits = 0;

  async get(key: string) {
    return this.values.get(key)?.slice();
  }
  async entries(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix));
  }
  async page(prefix: string, after: string | undefined, limit: number) {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([key, value]) => [key, value.slice()] as [string, Uint8Array]);
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
    if (this.failCommit) throw new Error('interrupted');
    this.commits++;
    const next = new Map(this.values);
    for (const change of changes) {
      if (change.kind === 'put') next.set(change.key, change.value.slice());
      else next.delete(change.key);
    }
    this.values.clear();
    for (const [key, value] of next) this.values.set(key, value);
  }
}

const raw = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const libraryKey = btoa(String.fromCharCode(...raw));

const title = (id: number, status: TitleRow['status']['value'], at: number): TitleRow => ({
  kind: 'rec',
  schema: 2,
  title: { type: id % 2 ? 'movie' : 'tv', id },
  status: { value: status, at: [at, 0, 'device'] },
  resume: {
    value: status === 'inProgress' ? 0.4 : 0,
    at: [at, 0, 'device'],
    viewing: 0,
  },
  reaction: { value: null, at: [at, 0, 'device'] },
  deleted: { value: false, at: [at, 0, 'device'] },
  dismissed: { value: false, at: [0, 0, ''] },
  episodesReset: null,
  addedAt: at,
  watchedAt: status === 'watched' ? at : null,
});

beforeAll(async () => ensureSyncPolicy());

describe('library fact store', () => {
  it('commits authority, selected facts, and the cursor atomically', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch(
      'generation-a',
      7,
      [{ k: 'a'.repeat(64), seq: 7, value: 'ciphertext', row: title(7, 'watchlist', 70) }],
      false,
    );
    await expect(store.manifest()).resolves.toEqual({
      schema: 1,
      generation: 'generation-a',
      head: 7,
      rowsVersion: 7,
      revision: expect.any(String),
      complete: false,
      profileTopology: false,
      newest: { stamp: [70, 0, 'device'], reconsiderAt: null },
    });
    const names = [...vault.values.keys()];
    expect(names.some((name) => name.includes(':document:'))).toBe(true);
    expect(names.some((name) => name.includes(':fact:watchlist:'))).toBe(true);
    expect(names.some((name) => name.includes(':fact:recommendations:'))).toBe(true);
    expect(names.some((name) => name.includes(':history:'))).toBe(false);
  });

  it('keeps the newest stamp of every row it has kept, across reads, own writes and generations', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const newest = async () => (await store.manifest())!.newest!.stamp;
    await store.commitBatch(
      'generation-a',
      2,
      [
        { k: 'a'.repeat(64), seq: 1, value: 'one', row: title(1, 'watchlist', 90) },
        { k: 'b'.repeat(64), seq: 2, value: 'two', row: title(3, 'watchlist', 40) },
      ],
      false,
    );
    expect(await newest()).toEqual([90, 0, 'device']);
    // A later page of older rows leaves it; a fresh store reading the same library carries it on.
    const again = (await LibraryFactStore.open(libraryKey, vault))!;
    await again.commitBatch(
      'generation-a',
      3,
      [{ k: 'c'.repeat(64), seq: 3, value: 'three', row: title(5, 'watchlist', 10) }],
      true,
    );
    expect(await newest()).toEqual([90, 0, 'device']);
    // A row this browser wrote, kept beside the cursor without moving it, raises it.
    await again.keepRows('generation-a', [
      { k: 'a'.repeat(64), seq: 4, value: '', row: title(1, 'watched', 120) },
    ]);
    expect((await store.manifest())!).toMatchObject({ head: 3, complete: true });
    expect(await newest()).toEqual([120, 0, 'device']);
    // A new generation starts from its own rows.
    await again.commitBatch(
      'generation-b',
      1,
      [{ k: 'd'.repeat(64), seq: 1, value: 'four', row: title(7, 'watchlist', 30) }],
      true,
    );
    expect(await newest()).toEqual([30, 0, 'device']);
  });

  it('does not revise facts or notify their writer for an unchanged empty refresh', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch('generation-a', 7, [], true, { profileTopology: true });
    const before = (await store.manifest())!;
    let changes = 0;
    store.listen(() => changes++);
    const commits = vault.commits;

    await store.commitBatch('generation-a', 7, [], true, { profileTopology: true });

    expect(vault.commits).toBe(commits);
    expect(changes).toBe(0);
    await expect(store.manifest()).resolves.toEqual(before);
  });

  it('reduces Watchlist and Continue independently without a watched-history fact', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch(
      'generation-a',
      9,
      [
        { k: 'a'.repeat(64), seq: 8, value: 'one', row: title(7, 'watchlist', 70) },
        { k: 'b'.repeat(64), seq: 9, value: 'two', row: title(9, 'inProgress', 80) },
      ],
      true,
    );

    await expect(store.home('generation-a', ['watchlist'])).resolves.toMatchObject({
      view: { watchlist: ['movie:7'], continueLibrary: { records: [] } },
    });
    await expect(store.home('generation-a', ['continue'])).resolves.toMatchObject({
      view: {
        watchlist: [],
        continueLibrary: {
          records: [expect.objectContaining({ title: expect.objectContaining({ id: 9 }) })],
        },
      },
    });
  });

  it('keeps the old complete transaction when a replacement is interrupted', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const key = 'c'.repeat(64);
    await store.commitBatch(
      'generation-a',
      1,
      [{ k: key, seq: 1, value: 'old', row: title(9, 'watchlist', 10) }],
      true,
    );
    vault.failCommit = true;
    await expect(
      store.commitBatch(
        'generation-a',
        2,
        [{ k: key, seq: 2, value: 'new', row: title(9, 'watched', 20) }],
        true,
      ),
    ).rejects.toThrow('interrupted');
    vault.failCommit = false;

    await expect(store.manifest()).resolves.toMatchObject({ head: 1, complete: true });
    await expect(store.home('generation-a', ['watchlist'])).resolves.toMatchObject({
      view: { watchlist: ['movie:9'] },
    });
  });

  it('retracts old facts when a key becomes unreadable or deleted', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const key = 'd'.repeat(64);
    await store.commitBatch(
      'generation-a',
      1,
      [{ k: key, seq: 1, value: 'old', row: title(11, 'watchlist', 10) }],
      true,
    );
    await store.commitBatch('generation-a', 2, [{ k: key, seq: 2, value: '', row: null }], true);
    await expect(store.home('generation-a', ['watchlist'])).resolves.toMatchObject({
      view: { watchlist: [] },
    });
  });

  it('drops an obsolete generation only after its replacement is complete', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    await store.commitBatch(
      'generation-old',
      1,
      [{ k: 'e'.repeat(64), seq: 1, value: 'old', row: title(13, 'watchlist', 1) }],
      true,
    );
    await store.commitBatch(
      'generation-new',
      1,
      [{ k: 'f'.repeat(64), seq: 1, value: 'new', row: title(15, 'watchlist', 2) }],
      false,
    );
    expect([...vault.values.keys()].some((key) => key.includes('generation-old'))).toBe(true);
    await store.commitBatch('generation-new', 1, [], true);
    expect([...vault.values.keys()].some((key) => key.includes('generation-old'))).toBe(false);
  });
});
