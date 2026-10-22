import { describe, expect, it } from 'vitest';
import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  readFinishedLibraryViews,
  writeFinishedLibraryViews,
  type FinishedLibraryViewIdentity,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import type { Vault } from './localVault';
import { deriveKeys } from './wire';

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
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
}

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

  it('removes superseded immutable pieces after publishing their replacement', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    await writeFinishedLibraryViews(libraryKey, vault, value);
    const previousPieces = [...vault.values.keys()].filter(
      (key) => !key.endsWith(':finished-views.v1'),
    );
    await writeFinishedLibraryViews(libraryKey, vault, value);
    expect(previousPieces.every((key) => !vault.values.has(key))).toBe(true);
  });

  it('merges independently selected pieces from the same authority revision', async () => {
    const vault = new MemoryVault();
    const value = await fixture();
    await writeFinishedLibraryViews(libraryKey, vault, value);
    await writeFinishedLibraryViews(libraryKey, vault, {
      ...value,
      pieces: { watchlist: { titles: [{ type: 'movie', id: 99 }] } },
    });

    await expect(
      readFinishedLibraryViews(libraryKey, vault, ['watchlist', 'continue', 'recommendations']),
    ).resolves.toMatchObject({
      pieces: {
        watchlist: { titles: [{ id: 99 }] },
        continue: value.pieces.continue,
        recommendations: value.pieces.recommendations,
      },
    });
  });

  it('keeps the previous complete manifest when replacement is interrupted', async () => {
    class InterruptingVault extends MemoryVault {
      interruptManifest = false;
      override async put(key: string, value: Uint8Array) {
        if (this.interruptManifest && key.endsWith(':finished-views.v1'))
          throw new Error('interrupted');
        await super.put(key, value);
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
});
