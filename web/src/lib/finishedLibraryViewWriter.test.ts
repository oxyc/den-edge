import { beforeAll, expect, it } from 'vitest';
import { readFinishedLibraryViews } from './finishedLibraryViews';
import { factViewIdentity, FinishedLibraryViewWriter } from './finishedLibraryViewWriter';
import { libraryLocalAuthorityRevision } from './libraryLocalAuthority';
import { LibraryFactStore } from './libraryFactStore';
import type { Vault, VaultChange } from './localVault';
import { ensureSyncPolicy } from './syncLoader';
import type { TitleRow } from './wire';

class FactVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  readonly conditionalCommits: VaultChange[][] = [];
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
    const next = new Map(this.values);
    for (const change of changes) {
      if (change.kind === 'put') next.set(change.key, change.value.slice());
      else next.delete(change.key);
    }
    this.values.clear();
    for (const [key, value] of next) this.values.set(key, value);
  }
  async compareAndCommit(
    key: string,
    expected: Uint8Array | undefined,
    changes: readonly VaultChange[],
  ) {
    const current = this.values.get(key);
    if (!(
      current === expected ||
      (!!current &&
        !!expected &&
        current.byteLength === expected.byteLength &&
        current.every((byte, index) => byte === expected[index]))
    ))
      return false;
    await this.commit(changes);
    this.conditionalCommits.push([...changes]);
    return true;
  }
}

class BlockingVault implements Vault {
  blockManifest = false;
  private reachManifest!: () => void;
  private releaseManifest!: () => void;
  readonly reachedManifest = new Promise<void>((resolve) => (this.reachManifest = resolve));
  readonly manifestReleased = new Promise<void>((resolve) => (this.releaseManifest = resolve));

  constructor(readonly shared: FactVault) {}
  get(key: string) {
    return this.shared.get(key);
  }
  entries(prefix: string) {
    return this.shared.entries(prefix);
  }
  page(prefix: string, after: string | undefined, limit: number) {
    return this.shared.page(prefix, after, limit);
  }
  put(key: string, value: Uint8Array) {
    return this.shared.put(key, value);
  }
  async compareAndCommit(
    key: string,
    expected: Uint8Array | undefined,
    changes: readonly VaultChange[],
  ) {
    if (this.blockManifest) {
      this.reachManifest();
      await this.manifestReleased;
    }
    return this.shared.compareAndCommit(key, expected, changes);
  }
  delete(key: string) {
    return this.shared.delete(key);
  }
  remove(prefix: string) {
    return this.shared.remove(prefix);
  }
  commit(changes: readonly VaultChange[]) {
    return this.shared.commit(changes);
  }
  release(): void {
    this.releaseManifest();
  }
}

const raw = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const libraryKey = btoa(String.fromCharCode(...raw));
const row = (id: number, status: TitleRow['status']['value'], at: number): TitleRow => ({
  kind: 'rec',
  schema: 2,
  title: { type: 'movie', id },
  status: { value: status, at: [at, 0, 'device'] },
  resume: { value: 0, at: [at, 0, 'device'], viewing: 0 },
  reaction: { value: null, at: [at, 0, 'device'] },
  deleted: { value: false, at: [at, 0, 'device'] },
  dismissed: { value: false, at: [0, 0, ''] },
  episodesReset: null,
  addedAt: at,
  watchedAt: status === 'watched' ? at : null,
});

beforeAll(async () => ensureSyncPolicy());

it('invalidates saved identities made from a manifest that predates fact revisions', () => {
  const legacy = {
    schema: 1 as const,
    generation: 'generation',
    head: 10,
    complete: true,
    profileTopology: false,
    newest: { stamp: [100, 0, 'device'] as [number, number, string], reconsiderAt: null },
  };
  expect(factViewIdentity('library', legacy, null).authorityRevision).not.toBe(
    libraryLocalAuthorityRevision(10, 10, legacy.newest.stamp),
  );
});

it('rewrites views when acknowledged rows change below the global newest stamp', async () => {
  const vault = new FactVault();
  const store = (await LibraryFactStore.open(libraryKey, vault))!;
  await store.commitBatch(
    'generation',
    10,
    [
      { k: 'a'.repeat(64), seq: 9, value: 'a', row: row(1, 'watchlist', 100) },
      { k: 'b'.repeat(64), seq: 10, value: 'b', row: row(2, 'watchlist', 50) },
    ],
    true,
  );
  const initial = new FinishedLibraryViewWriter(libraryKey, vault, store);
  initial.schedule();
  await initial.close();

  const before = (await store.manifest())!;
  const stale = await store.home(before.generation, ['watchlist', 'continue', 'recommendations']);
  const writer = new FinishedLibraryViewWriter(libraryKey, vault, store, () => ({
    generation: before.generation,
    head: before.head,
    home: stale.view,
    reconsiderAt: stale.reconsiderAt,
    shapes: new Map(),
  }));
  await store.keepRows('generation', [
    { k: 'b'.repeat(64), seq: 11, value: 'b2', row: row(2, 'watched', 60) },
  ]);
  await writer.close();

  const after = (await store.manifest())!;
  expect(after).toMatchObject({ head: 10, rowsVersion: 11 });
  expect(after.revision).not.toBe(before.revision);
  expect(
    (await readFinishedLibraryViews(libraryKey, vault, ['watchlist']))?.pieces.watchlist?.titles,
  ).toEqual([{ type: 'movie', id: 1 }]);
});

it('waits for an in-flight writer before transferring saved-view ownership', async () => {
  const shared = new FactVault();
  const oldVault = new BlockingVault(shared);
  const newVault = new BlockingVault(shared);
  const oldStore = (await LibraryFactStore.open(libraryKey, oldVault))!;
  await oldStore.commitBatch(
    'generation',
    10,
    [
      { k: 'a'.repeat(64), seq: 9, value: 'a', row: row(1, 'watchlist', 100) },
      { k: 'b'.repeat(64), seq: 10, value: 'b', row: row(2, 'watchlist', 50) },
    ],
    true,
  );

  oldVault.blockManifest = true;
  const oldWriter = new FinishedLibraryViewWriter(libraryKey, oldVault, oldStore);
  oldWriter.schedule(true);
  await oldVault.reachedManifest;
  let stopped = false;
  const stopping = oldWriter.abort().then(() => (stopped = true));
  await Promise.resolve();
  expect(stopped).toBe(false);
  oldVault.release();
  await stopping;

  const newStore = (await LibraryFactStore.open(libraryKey, newVault))!;
  await newStore.commitBatch(
    'generation',
    11,
    [{ k: 'b'.repeat(64), seq: 11, value: 'b2', row: row(2, 'watched', 110) }],
    true,
  );
  const newWriter = new FinishedLibraryViewWriter(libraryKey, newVault, newStore);
  newWriter.schedule(true);
  await newWriter.close();

  expect(
    shared.conditionalCommits
      .at(-1)
      ?.filter((change) => change.kind === 'put')
      .map((change) => change.key.slice(change.key.indexOf(':') + 1)),
  ).toEqual(expect.arrayContaining(['finished-views.v1', 'local-authority.v1']));

  await expect(readFinishedLibraryViews(libraryKey, shared, ['watchlist'])).resolves.toMatchObject({
    identity: { head: 11 },
    pieces: { watchlist: { titles: [{ type: 'movie', id: 1 }] } },
  });
});
