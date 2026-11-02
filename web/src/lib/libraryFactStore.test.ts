import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryFactStore } from './libraryFactStore';
import { libraryLocalMaterials, sealLibraryLocalValue } from './libraryLocalValue';
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
    this.gets.push(prefix);
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
      layout: 2,
    });
    const names = [...vault.values.keys()];
    expect(names.filter((name) => name.includes(':journal:'))).toHaveLength(1);
    expect(names.some((name) => name.includes(':document:'))).toBe(false);
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

    expect(vault.gets.filter((key) => key.includes(':kept:'))).toEqual([]);
    expect(vault.pages).toEqual([]);
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
    vault.gets.length = 0;
    await resumed.commitBatch('generation-a', 1, [], true);

    expect(vault.gets.some((key) => key.includes(':kept:'))).toBe(true);
    expect((await resumed.history((await resumed.manifest())!))?.page()?.items).toEqual([
      {
        title: { type: 'tv', id: 90 },
        watchedAt: 300,
        episode: { season: 2, episode: 3 },
        episodes: 1,
      },
    ]);
  });

  it('appends import derivations after commit without copying the growing map', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const document = (id: number, at: number): DocumentRow => ({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id },
      status: { value: 'watched', at: [at, 0, 'device'] },
      addedAt: at,
    });
    const entry = (id: number) => ({
      k: String(id).padStart(64, '0'),
      seq: id,
      value: `ciphertext-${id}`,
      row: document(id, id * 100),
    });
    const retained = () =>
      (
        store as unknown as {
          historyImport?: { documents: Map<string, unknown> };
        }
      ).historyImport?.documents;

    await store.commitBatch('generation-a', 1, [entry(1)], false);
    const first = retained();
    expect(first?.size).toBe(1);
    await store.commitBatch('generation-a', 2, [entry(2)], false);
    expect(retained()).toBe(first);
    expect(first?.size).toBe(2);

    vault.failCommit = true;
    await expect(store.commitBatch('generation-a', 3, [entry(3)], false)).rejects.toThrow(
      'interrupted',
    );
    expect(retained()).toBe(first);
    expect(first?.size).toBe(2);
    vault.failCommit = false;

    await store.commitBatch('generation-a', 3, [entry(3)], true);
    expect(retained()).toBeUndefined();
    expect((await store.history((await store.manifest())!))?.page()?.items).toHaveLength(3);
  });

  it('keeps the projection-time reconsider deadline when the clock crosses it during commit', async () => {
    const now = 1_800_000_000_000;
    const believableAt = now + 5_000;
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(believableAt + 1);
    try {
      const vault = new MemoryVault();
      const store = (await LibraryFactStore.open(libraryKey, vault))!;
      const row: DocumentRow = {
        format: 4,
        kind: 'season',
        title: { type: 'tv', id: 91 },
        season: 1,
        seasonReset: null,
        episodes: {
          1: {
            progress: {
              value: 1,
              at: [now + 86_400_000 + 5_000, 0, 'future'],
              viewing: 0,
            },
            imported: false,
            plays: { 0: now + 86_400_000 + 5_000 },
            cleared: null,
          },
        },
      };
      await store.commitBatch(
        'generation-a',
        1,
        [{ k: '8'.repeat(64), seq: 1, value: 'ciphertext', row }],
        true,
      );
      clock.mockReturnValue(now);

      const history = await store.history((await store.manifest())!);
      expect(history?.source.reconsiderAt).toBe(believableAt);
      expect(history?.page()?.items).toEqual([]);
    } finally {
      clock.mockRestore();
    }
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

/** A store as the build before the snapshot layout wrote it: one sealed record per document, a manifest without it. */
async function earlierLayout(
  vault: MemoryVault,
  documents: Array<{ k: string; seq: number; value: string; row: Row | null }>,
) {
  const { libraryId, key } = (await libraryLocalMaterials(libraryKey))!;
  const put = async (name: string, value: unknown) =>
    vault.put(`${libraryId}:${name}`, await sealLibraryLocalValue(key, name, value));
  for (const { k, seq, value, row } of documents)
    await put(`library-facts.v1:generation-a:document:${k}`, { schema: 1, seq, value, row });
  await put('library-facts.v1:manifest', {
    schema: 1,
    generation: 'generation-a',
    head: documents.length,
    rowsVersion: documents.length,
    revision: 'earlier',
    complete: true,
    profileTopology: false,
  });
}

const read = async (store: LibraryFactStore) => {
  const held: Array<[string, { seq: number; row: Row | null; value: string }]> = [];
  for await (const { key, document } of store.documents('generation-a'))
    held.push([key, { seq: document.seq, row: document.row, value: document.value }]);
  return held;
};

describe('the snapshot layout', () => {
  const documents = [
    { k: 'a'.repeat(64), seq: 1, value: 'ciphertext-1', row: title(1, 'watchlist', 10) },
    { k: 'b'.repeat(64), seq: 2, value: 'ciphertext-2', row: title(3, 'watched', 20) },
    // A row this build could not read is kept as its server ciphertext.
    { k: 'c'.repeat(64), seq: 3, value: 'ciphertext-3', row: null },
  ];

  it('converts a store the earlier build wrote, verified, then removes the old records', async () => {
    const vault = new MemoryVault();
    await earlierLayout(vault, documents);
    const store = (await LibraryFactStore.open(libraryKey, vault))!;

    expect(await read(store)).toEqual([
      ['a'.repeat(64), { seq: 1, row: documents[0]!.row, value: '' }],
      ['b'.repeat(64), { seq: 2, row: documents[1]!.row, value: '' }],
      ['c'.repeat(64), { seq: 3, row: null, value: 'ciphertext-3' }],
    ]);
    const keys = [...vault.values.keys()];
    expect(keys.some((key) => key.includes(':document:'))).toBe(false);
    expect(keys.filter((key) => key.endsWith(':snapshot'))).toHaveLength(1);
    expect(await store.manifest()).toMatchObject({ layout: 2, revision: 'earlier', head: 3 });

    // A new instance reads the snapshot alone.
    const reopened = (await LibraryFactStore.open(libraryKey, vault))!;
    vault.pages.length = 0;
    expect(await read(reopened)).toEqual(await read(store));
    expect(vault.pages).toEqual([]);
  });

  it('keeps the old records, and refuses a write, when the snapshot does not read back', async () => {
    const vault = new MemoryVault();
    await earlierLayout(vault, documents);
    const before = new Map(vault.values);
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    // The snapshot is lost as it is written: what reads back is not what was sealed.
    const put = vault.put.bind(vault);
    vault.put = async (key, value) => (key.endsWith(':snapshot') ? undefined : put(key, value));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await read(store)).map(([key]) => key)).toEqual(documents.map(({ k }) => k));
    } finally {
      warn.mockRestore();
    }
    expect(new Map(vault.values)).toEqual(before);
    await store.manifest();
    await expect(
      store.keepRows('generation-a', [
        { k: 'd'.repeat(64), seq: 4, value: '', row: title(5, 'watched', 40) },
      ]),
    ).rejects.toThrow('earlier layout');
    expect(new Map(vault.values)).toEqual(before);
  });

  it('folds the journal into the snapshot past its limit, and another writer sees every document', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const entry = (id: number) => ({
      k: String(id).padStart(64, '0'),
      seq: id,
      value: `ciphertext-${id}`,
      row: title(id, 'watchlist', id),
    });
    await store.commitBatch('generation-a', 1, [entry(1)], false);
    const other = (await LibraryFactStore.open(libraryKey, vault))!;
    expect(await read(other)).toHaveLength(1);
    for (let id = 2; id <= 40; id++)
      await store.commitBatch('generation-a', id, [entry(id)], id === 40);

    const journals = [...vault.values.keys()].filter((key) => key.includes(':journal:'));
    expect(journals.length).toBeLessThan(32);
    expect(await read(other)).toHaveLength(40);
    // A document written again replaces its earlier form, here and in a third reader.
    await other.manifest();
    await other.keepRows('generation-a', [{ ...entry(7), seq: 41, row: title(7, 'watched', 41) }]);
    const third = (await LibraryFactStore.open(libraryKey, vault))!;
    expect((await third.document('generation-a', entry(7).k))?.row).toMatchObject({
      status: { value: 'watched' },
    });
    expect((await store.document('generation-a', entry(7).k))?.seq).toBe(41);
  });

  it('reads every document while another writer folds the journal mid-read', async () => {
    const vault = new MemoryVault();
    const store = (await LibraryFactStore.open(libraryKey, vault))!;
    const entry = (id: number) => ({
      k: String(id).padStart(64, '0'),
      seq: id,
      value: `ciphertext-${id}`,
      row: title(id, 'watchlist', id),
    });
    // One batch short of the fold.
    for (let id = 1; id <= 31; id++)
      await store.commitBatch('generation-a', id, [entry(id)], false);
    const reader = (await LibraryFactStore.open(libraryKey, vault))!;
    await reader.manifest();
    // The reader yields once after its first read of the kept documents, and the writer's fold lands in that gap.
    const journals = () => [...vault.values.keys()].filter((key) => key.includes(':journal:'));
    let folded: Promise<void> | undefined;
    const fold = () => store.commitBatch('generation-a', 32, [entry(32)], false);
    const get = vault.get.bind(vault);
    const entries = vault.entries.bind(vault);
    const gap = async () => {
      folded ??= fold();
      await folded;
    };
    vault.get = async (key) => {
      const value = await get(key);
      if (key.endsWith(':snapshot') && !folded) await gap();
      return value;
    };
    vault.entries = async (prefix) => {
      const value = await entries(prefix);
      if (/:(kept|journal):$/.test(prefix) && !folded) await gap();
      return value;
    };
    const read = await reader.document('generation-a', entry(1).k);
    expect(folded).toBeDefined();
    expect(journals()).toHaveLength(0);
    expect(read?.seq).toBe(1);
    // The manifest has moved on since, so this reads again: the fold's snapshot, with the 32nd document in it.
    const all: string[] = [];
    for await (const { key } of reader.documents('generation-a')) all.push(key);
    expect(all).toHaveLength(32);
  });
});
