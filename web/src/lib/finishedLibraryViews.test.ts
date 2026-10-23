import { describe, expect, it, vi } from 'vitest';
import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  readFinishedLibraryViews,
  staleFinishedLibraryViews,
  writeFinishedLibraryViews,
  type FinishedLibraryViewIdentity,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import type { Vault, VaultChange } from './localVault';
import { readEncryptedLibraryValue } from './libraryLocalValue';
import { LIBRARY_LOCAL_AUTHORITY } from './libraryLocalAuthority';
import { deriveKeys } from './wire';

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly commits: VaultChange[][] = [];
  async get(key: string) {
    this.reads.push(key);
    return this.values.get(key)?.slice();
  }
  async entries(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix));
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
    const next = new Map(this.values);
    for (const change of changes) {
      if (change.kind === 'put') next.set(change.key, change.value.slice());
      else next.delete(change.key);
    }
    this.values.clear();
    for (const [name, value] of next) this.values.set(name, value);
    this.commits.push([...changes]);
    return true;
  }
}

class BlockingVault implements Vault {
  private reached!: () => void;
  private releaseCommit!: () => void;
  readonly commitReached = new Promise<void>((resolve) => (this.reached = resolve));
  readonly commitReleased = new Promise<void>((resolve) => (this.releaseCommit = resolve));

  constructor(
    readonly shared: MemoryVault,
    readonly blockCommit = false,
  ) {}

  get(key: string) {
    return this.shared.get(key);
  }
  entries(prefix: string) {
    return this.shared.entries(prefix);
  }
  put(key: string, value: Uint8Array) {
    return this.shared.put(key, value);
  }
  delete(key: string) {
    return this.shared.delete(key);
  }
  remove(prefix: string) {
    return this.shared.remove(prefix);
  }
  async compareAndCommit(
    key: string,
    expected: Uint8Array | undefined,
    changes: readonly VaultChange[],
  ) {
    if (this.blockCommit) {
      this.reached();
      await this.commitReleased;
    }
    return this.shared.compareAndCommit(key, expected, changes);
  }
  release(): void {
    this.releaseCommit();
  }
}

const NAME_SUFFIX = ':finished-views.v1';
const raw = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const libraryKey = btoa(String.fromCharCode(...raw));

async function fixture(): Promise<FinishedLibraryViews> {
  const identity: FinishedLibraryViewIdentity = {
    libraryId: (await deriveKeys(raw)).id,
    generation: 'generation-a',
    head: 42,
    authorityRevision: '42:0',
    policyVersion: FINISHED_LIBRARY_POLICY,
    rowsVersion: 7,
    layoutVersion: 'layouts:3',
    recommendationVersion: FINISHED_LIBRARY_RECOMMENDATIONS,
    reconsiderAt: Date.now() + 60_000,
  };
  return {
    schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
    identity,
    pieces: {
      watchlist: { titles: [{ type: 'movie', id: 7 }] },
      continue: { view: { kind: 'continue', items: [], needsShapes: [] }, layouts: {} },
      recommendations: {
        owned: [{ type: 'movie', id: 7 }],
        watched: [],
        standings: [],
        weighted: [],
        seeds: { watched: [], watchlisted: [{ type: 'movie', id: 7 }] },
      },
    },
  };
}

describe('finished library views', () => {
  it('opens only explicitly requested encrypted pieces', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    await expect(writeFinishedLibraryViews(libraryKey, vault, value)).resolves.toBe(true);

    vault.reads.length = 0;
    const opened = await readFinishedLibraryViews(libraryKey, vault, ['watchlist', 'continue']);
    expect(opened?.pieces).toEqual({
      watchlist: value.pieces.watchlist,
      continue: value.pieces.continue,
    });
    expect(vault.reads).toHaveLength(3);
    expect(vault.reads.some((key) => key.endsWith(':recommendations'))).toBe(false);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['settings'])).resolves.toBeNull();
  });

  it('treats authentication failure as a disposable miss', async () => {
    const vault = new MemoryVault();
    await writeFinishedLibraryViews(libraryKey, vault, await fixture());
    const [name, bytes] = [...vault.values].find(([key]) => key.endsWith(':watchlist'))!;
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    vault.values.set(name, bytes);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toBeNull();
  });

  it('treats truncation and eviction as disposable misses', async () => {
    const vault = new MemoryVault();
    await writeFinishedLibraryViews(libraryKey, vault, await fixture());
    const [continued] = [...vault.values].find(([key]) => key.endsWith(':continue'))!;
    vault.values.set(continued, Uint8Array.of(1, 2, 3));
    await expect(readFinishedLibraryViews(libraryKey, vault, ['continue'])).resolves.toBeNull();
    vault.values.delete(continued);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['continue'])).resolves.toBeNull();
  });

  it('cannot open one library cache with another library key', async () => {
    const vault = new MemoryVault();
    await writeFinishedLibraryViews(libraryKey, vault, await fixture());
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(99)));
    await expect(readFinishedLibraryViews(other, vault, ['watchlist'])).resolves.toBeNull();
  });

  it('refuses malformed pieces before publishing them', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    value.pieces.watchlist = { titles: [{ type: 'movie', id: -1 }] } as never;
    await expect(writeFinishedLibraryViews(libraryKey, vault, value)).resolves.toBe(false);
    expect(vault.values.size).toBe(0);
  });

  it('does not mutate a cache whose adapter cannot publish conditionally', async () => {
    const supported = new MemoryVault();
    const vault: Vault = {
      get: (key) => supported.get(key),
      entries: (prefix) => supported.entries(prefix),
      put: (key, value) => supported.put(key, value),
      delete: (key) => supported.delete(key),
      remove: (prefix) => supported.remove(prefix),
    };
    await expect(writeFinishedLibraryViews(libraryKey, vault, await fixture())).resolves.toBe(
      false,
    );
    expect(supported.values.size).toBe(0);
  });

  it('writes only the pieces that changed, and removes the ones they replace', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    await writeFinishedLibraryViews(libraryKey, vault, value);
    const pieceKeys = () => [...vault.values.keys()].filter((key) => !key.endsWith(NAME_SUFFIX));
    const before = pieceKeys();
    const commit = vi.spyOn(vault, 'compareAndCommit');

    const next = structuredClone(value);
    next.identity.head += 1;
    next.pieces.watchlist = { titles: [{ type: 'movie', id: 8 }] };
    await writeFinishedLibraryViews(libraryKey, vault, next);
    expect(
      commit.mock.calls
        .at(-1)?.[2]
        .map((change) =>
          change.kind === 'put'
            ? `put:${change.key.split(':').at(-1)}`
            : `delete:${change.key.split(':').at(-1)}`,
        ),
    ).toEqual(['put:watchlist', 'put:finished-views.v1', 'delete:watchlist']);
    const after = pieceKeys();
    expect(after.filter((key) => !before.includes(key))).toHaveLength(1);
    expect(before.filter((key) => !after.includes(key))).toEqual(
      before.filter((key) => key.endsWith(':watchlist')),
    );
    await expect(
      readFinishedLibraryViews(libraryKey, vault, ['watchlist', 'continue', 'recommendations']),
    ).resolves.toMatchObject({ identity: next.identity, pieces: next.pieces });

    // Marked stale for a new revision, they are not opened; the revision's pieces all say the same, so only the
    // manifest is written again.
    await staleFinishedLibraryViews(libraryKey, vault);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toBeNull();
    commit.mockClear();
    const entries = vi.spyOn(vault, 'entries');
    const third = { ...next, identity: { ...next.identity, head: next.identity.head + 1 } };
    await writeFinishedLibraryViews(libraryKey, vault, third);
    expect(
      commit.mock.calls
        .at(-1)?.[2]
        .map((change) => `${change.kind}:${change.key.split(':').at(-1)}`),
    ).toEqual(['put:finished-views.v1']);
    expect(entries).not.toHaveBeenCalled();
    expect(pieceKeys()).toEqual(after);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject(
      {
        identity: third.identity,
      },
    );
  });

  it('writes nothing when the same views are kept already', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    await writeFinishedLibraryViews(libraryKey, vault, value);
    const kept = new Map(vault.values);
    const commit = vi.spyOn(vault, 'compareAndCommit');
    await expect(
      writeFinishedLibraryViews(libraryKey, vault, structuredClone(value)),
    ).resolves.toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[2]).toEqual([]);
    expect(vault.values).toEqual(kept);
    await expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject(
      { identity: value.identity },
    );
  });

  it('does not publish an old identity marker after another writer replaces its manifest', async () => {
    const shared = new MemoryVault();
    const first = await fixture();
    await writeFinishedLibraryViews(libraryKey, shared, first);
    const blocked = new BlockingVault(shared, true);
    const firstMarker = {
      generation: first.identity.generation,
      head: first.identity.head,
      authorityRevision: first.identity.authorityRevision,
      rowsVersion: first.identity.rowsVersion,
    };
    const unchanged = writeFinishedLibraryViews(
      libraryKey,
      blocked,
      structuredClone(first),
      firstMarker,
    );
    await blocked.commitReached;
    const newer = { ...first, identity: { ...first.identity, head: first.identity.head + 1 } };
    await expect(
      writeFinishedLibraryViews(libraryKey, shared, newer, {
        ...firstMarker,
        head: newer.identity.head,
      }),
    ).resolves.toBe(true);
    blocked.release();
    await expect(unchanged).resolves.toBe(false);
    await expect(
      readFinishedLibraryViews(libraryKey, shared, ['watchlist']),
    ).resolves.toMatchObject({ identity: newer.identity });
    await expect(
      readEncryptedLibraryValue<{ head: number }>(libraryKey, shared, LIBRARY_LOCAL_AUTHORITY),
    ).resolves.toMatchObject({ head: newer.identity.head });
  });

  it('keeps the previous complete manifest when replacement is interrupted', async () => {
    class InterruptingVault extends MemoryVault {
      interruptManifest = false;
      override async compareAndCommit(
        key: string,
        expected: Uint8Array | undefined,
        changes: readonly VaultChange[],
      ) {
        if (this.interruptManifest) throw new Error('interrupted');
        return super.compareAndCommit(key, expected, changes);
      }
    }
    const vault = new InterruptingVault();
    const first = await fixture();
    await writeFinishedLibraryViews(libraryKey, vault, first);
    const replacement = structuredClone(first);
    replacement.pieces.watchlist = { titles: [{ type: 'movie', id: 99 }] };
    vault.interruptManifest = true;
    await expect(writeFinishedLibraryViews(libraryKey, vault, replacement)).rejects.toThrow(
      'interrupted',
    );
    await expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject(
      {
        pieces: { watchlist: first.pieces.watchlist },
      },
    );
    vault.interruptManifest = false;
    await writeFinishedLibraryViews(libraryKey, vault, replacement);
    expect(vault.values.size).toBe(1 + Object.keys(replacement.pieces).length);
  });

  it('lets a competing publisher win without publishing or deleting from the stale attempt', async () => {
    const shared = new MemoryVault();
    const first = await fixture();
    await writeFinishedLibraryViews(libraryKey, shared, first);
    const stale = structuredClone(first);
    stale.identity.head += 1;
    stale.pieces.watchlist = { titles: [{ type: 'movie', id: 8 }] };
    const newer = structuredClone(stale);
    newer.identity.head += 1;
    newer.pieces.watchlist = { titles: [{ type: 'movie', id: 9 }] };

    const blocked = new BlockingVault(shared, true);
    const staleWrite = writeFinishedLibraryViews(libraryKey, blocked, stale);
    await blocked.commitReached;
    await expect(writeFinishedLibraryViews(libraryKey, shared, newer)).resolves.toBe(true);
    const afterWinner = new Map(shared.values);
    blocked.release();
    await expect(staleWrite).resolves.toBe(false);

    expect(shared.values).toEqual(afterWinner);
    expect(shared.values.size).toBe(1 + Object.keys(newer.pieces).length);
    await expect(
      readFinishedLibraryViews(libraryKey, shared, ['watchlist', 'continue', 'recommendations']),
    ).resolves.toMatchObject({ identity: newer.identity, pieces: newer.pieces });
  });

  it('does not let a delayed stale marker hide a concurrently published manifest', async () => {
    const shared = new MemoryVault();
    const first = await fixture();
    await writeFinishedLibraryViews(libraryKey, shared, first);
    const newer = structuredClone(first);
    newer.identity.head += 1;
    newer.pieces.watchlist = { titles: [{ type: 'movie', id: 9 }] };

    const blocked = new BlockingVault(shared, true);
    const markingStale = staleFinishedLibraryViews(libraryKey, blocked);
    await blocked.commitReached;
    await expect(writeFinishedLibraryViews(libraryKey, shared, newer)).resolves.toBe(true);
    blocked.release();
    await markingStale;

    await expect(
      readFinishedLibraryViews(libraryKey, shared, ['watchlist']),
    ).resolves.toMatchObject({
      identity: newer.identity,
      pieces: { watchlist: newer.pieces.watchlist },
    });
  });
});
