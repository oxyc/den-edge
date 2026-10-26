import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryFactStore } from './libraryFactStore';
import type { Vault, VaultChange } from './localVault';
import { ensureSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';
import type { DocumentRow, EpisodeRow, Row, TitleRow } from './wire';

vi.mock('./syncCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./syncCore')>();
  return { ...actual, syncPolicy: vi.fn(actual.syncPolicy) };
});

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  readonly gets: string[] = [];
  readonly pages: string[] = [];
  failCommit = false;
  commits = 0;

  async get(key: string) {
    this.gets.push(key);
    return this.values.get(key)?.slice();
  }
  async entries(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix));
  }
  async page(prefix: string, after: string | undefined, limit: number) {
    this.pages.push(prefix);
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

  it('derives Continue and the first History checkpoint in one projection pass', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const seasons = Array.from({ length: 40 }, (_, index): DocumentRow => ({
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: index + 1 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: {
          progress: { value: 1, at: [index + 1, 0, 'device'], viewing: 0 },
          imported: false,
          plays: { 0: index + 1 },
          cleared: null,
        },
      },
    }));
    const policy = vi.mocked(syncPolicy);
    policy.mockClear();
    await store.commitBatch(
      'generation-a',
      seasons.length,
      seasons.map((row, index) => ({
        k: String(index).padStart(64, '0'),
        seq: index + 1,
        value: `ciphertext-${index}`,
        row,
      })),
      false,
    );
    vault.gets.length = 0;
    vault.pages.length = 0;

    await store.commitBatch('generation-a', seasons.length, [], true);

    expect(vault.gets.filter((key) => key.includes(':document:'))).toEqual([]);
    expect(vault.pages.filter((key) => key.includes(':document:'))).toEqual([]);
    expect(policy.mock.calls.filter(([request]) => request.op === 'season_state_v4')).toHaveLength(
      seasons.length,
    );
    await expect(store.history((await store.manifest())!)).resolves.toMatchObject({
      source: { version: seasons.length },
    });
  });

  it('rebuilds History from stored authority when an incomplete import resumes in a new instance', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const row: DocumentRow = {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 90 },
      season: 2,
      seasonReset: null,
      episodes: {
        3: {
          progress: { value: 1, at: [300, 0, 'device'], viewing: 0 },
          imported: false,
          plays: { 0: 300 },
          cleared: null,
        },
      },
    };
    await store.commitBatch(
      'generation-a',
      1,
      [{ k: '9'.repeat(64), seq: 1, value: 'ciphertext', row }],
      false,
    );

    const resumed = (await LibraryFactStore.open(libraryKey, vault))!;
    await resumed.manifest();
    vault.pages.length = 0;
    await resumed.commitBatch('generation-a', 1, [], true);

    expect(vault.pages.some((prefix) => prefix.includes(':document:'))).toBe(true);
    expect((await resumed.history((await resumed.manifest())!))?.page()?.items).toEqual([
      {
        title: { type: 'tv', id: 90 },
        watchedAt: 300,
        episode: { season: 2, episode: 3 },
        episodes: 1,
      },
    ]);
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

  it('streams the exact compact shared-policy facts for season documents', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_800_000_000_000;
      vi.setSystemTime(now);
      const stamp = (at: number, device = 'device'): [number, number, string] => [at, 0, device];
      const episode = (
        value: number | null,
        at: number,
        options: { imported?: boolean; seconds?: number } = {},
      ) => ({
        progress:
          value === null
            ? null
            : {
                value,
                at: stamp(at),
                viewing: 2,
                ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
              },
        imported: options.imported ?? false,
        plays: value === null ? {} : { 0: at },
        cleared: null,
      });
      const season = (
        id: number,
        number: number,
        episodes: Record<number, ReturnType<typeof episode>>,
        seasonReset: [number, number, string] | null = null,
      ): DocumentRow => ({
        format: 4,
        kind: 'season',
        title: { type: 'tv', id },
        season: number,
        seasonReset,
        episodes,
      });
      const rows: Row[] = [
        // Specials, sparse numbers, a timeless import, equal-time ordering, furthest watched and live seconds/device.
        season(20, 0, {
          1: episode(null, now - 9_000, { imported: true }),
          3: episode(1, now - 5_000),
          8: episode(1, now - 5_000),
          13: episode(0.4, now - 1_000, { seconds: 713 }),
        }),
        // The season policy, not this test, applies the reset before episode_mark sees each projection.
        season(
          21,
          2,
          { 1: episode(1, now - 8_000), 4: episode(0.6, now - 1_000, { seconds: 404 }) },
          stamp(now - 4_000),
        ),
        // A future stamp stays on the same believability clock in projection and the stored reconsider deadline.
        season(22, 1, { 2: episode(0.5, now + 86_400_000 + 5_000, { seconds: 222 }) }),
        // Equal latest times keep the first projected row, including its identity and ordering.
        season(24, 4, {
          2: episode(0.4, now - 700, { seconds: 402 }),
          5: episode(0.6, now - 700, { seconds: 405 }),
        }),
        // A legacy row remains on the unchanged project/apply/compact path.
        {
          kind: 'ep',
          schema: 2,
          title: { type: 'tv', id: 23 },
          season: 3,
          episode: 7,
          progress: { value: 0.75, viewing: 1, seconds: 307, at: stamp(now - 500, 'legacy') },
        } satisfies EpisodeRow,
      ];
      const vault = new MemoryVault();
      const store = (await LibraryFactStore.open(libraryKey, vault))!;
      await store.commitBatch(
        'generation-a',
        rows.length,
        rows.map((row, index) => ({
          k: String(index).padStart(64, String(index)),
          seq: index + 1,
          value: `ciphertext-${index}`,
          row,
        })),
        true,
      );

      const opened = await store.home('generation-a', ['continue']);
      expect(
        opened.view.continueLibrary.marks.map(({ id, season, episode, fraction }) => [
          id,
          season,
          episode,
          fraction,
        ]),
      ).toEqual([
        [20, 0, 13, 0.4],
        [20, 0, 8, 1],
        [21, 2, 4, 0.6],
        [24, 4, 2, 0.4],
        [23, 3, 7, 0.75],
      ]);
      expect([...(opened.view.continueLibrary.flags?.values() ?? [])]).toEqual([
        { type: 'tv', id: 20, season: 0, episode: 1 },
      ]);
      expect(opened.view.continueLibrary.marks).toContainEqual(
        expect.objectContaining({
          id: 20,
          season: 0,
          episode: 13,
          seconds: 713,
          updatedBy: 'device',
        }),
      );
      expect(opened.view.continueLibrary.marks).toContainEqual(
        expect.objectContaining({
          id: 23,
          season: 3,
          episode: 7,
          seconds: 307,
          updatedBy: 'legacy',
        }),
      );
      // Empty future-only facts retain the existing baseline predicate; manifest.newest owns their deadline.
      expect(opened.reconsiderAt).toBeNull();
      await expect(store.manifest()).resolves.toMatchObject({
        newest: { reconsiderAt: now + 5_000 },
      });
    } finally {
      vi.useRealTimers();
    }
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
