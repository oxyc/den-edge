import { expect, it, vi } from 'vitest';
import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  writeEncryptedLibraryValue,
  writeFinishedLibraryViews,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import { openFinishedLibraryViewAuthority } from './finishedLibraryViewAuthority';
import type { Vault } from './localVault';
import { LIBRARY_SERVICE_PROTOCOL, type LibraryServiceHello } from './libraryServiceProtocol';
import type { LibraryServiceAuthority } from './libraryServiceCore';
import { deriveKeys } from './wire';
import { libraryMetadataShapeDigest } from './libraryMetadata';
import { RETAINED_PREFERENCE_SEED } from './libraryRetainedViews';

class MemoryVault implements Vault {
  readonly values = new Map<string, Uint8Array>();
  async get(key: string) {
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

const raw = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const libraryKey = btoa(String.fromCharCode(...raw));
const request: LibraryServiceHello = {
  type: 'hello',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId: 'request',
  clientId: 'client',
  libraryKey,
  wire: 5,
  mode: 'online',
};
const content = { title: vi.fn(async () => ({ kind: 'missing' as const })) };

async function cached(vault: Vault): Promise<FinishedLibraryViews> {
  const value: FinishedLibraryViews = {
    schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
    identity: {
      libraryId: (await deriveKeys(raw)).id,
      generation: 'generation-a',
      head: 12,
      authorityRevision: 'revision-a',
      policyVersion: FINISHED_LIBRARY_POLICY,
      profileVersion: 'profile-a',
      layoutVersion: 'layout-a',
      recommendationVersion: FINISHED_LIBRARY_RECOMMENDATIONS,
      reconsiderAt: Date.now() + 60_000,
    },
    pieces: {
      watchlist: { titles: [{ type: 'movie', id: 7 }] },
      recommendations: {
        owned: [{ type: 'movie', id: 7 }],
        watched: [],
        standings: [],
        weighted: [],
        seeds: { watched: [], watchlisted: [{ type: 'movie', id: 7 }] },
      },
      continue: { view: { kind: 'continue', items: [], needsShapes: [] }, layouts: {} },
      settings: {
        kind: 'settings',
        preferences: {
          excludedGenres: [],
          excludedLanguages: [],
          hideAnime: false,
          hideWatched: false,
          shownSubtitleLanguages: [],
          subtitlesPerLanguage: 3,
          autoSkipSegments: false,
          autoplayTrailers: true,
          ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
          shownWarnings: [],
          services: [],
          servicesConfigured: false,
        },
        assistant: { read: false, write: false },
      },
      runtime: { kind: 'runtime', pluginManifestUrls: [], privateRemuxUrl: null },
    },
  } as unknown as FinishedLibraryViews;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  return value;
}

function fullAuthority(): LibraryServiceAuthority {
  return {
    generation: 'generation-a',
    async select(selection) {
      if (selection.kind === 'history') return { kind: 'history', items: [] };
      throw new Error(`unexpected ${selection.kind}`);
    },
    async command() {
      return { outcome: 'unchanged', delivery: 'synced', affected: [] };
    },
    async query(query) {
      if (query.kind === 'relay.membership') return { kind: 'relay.membership', capability: null };
      throw new Error(`unexpected ${query.kind}`);
    },
    async task(task) {
      throw new Error(`unexpected ${task.kind}`);
    },
    async observe() {
      return { outcome: 'unchanged', affected: [] };
    },
  };
}

it('serves capability-selected startup views without opening the document authority', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  expect(opened).not.toBeNull();
  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toEqual({
    kind: 'overview',
    ...value.pieces.recommendations,
    watchlist: value.pieces.watchlist!.titles,
  });
  await expect(opened!.authority.select({ kind: 'continue' })).resolves.toEqual(
    value.pieces.continue!.view,
  );
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toEqual(
    value.pieces.settings,
  );
  await expect(opened!.authority.query({ kind: 'relay.membership' })).resolves.toMatchObject({
    kind: 'relay.membership',
    capability: { libraryId: value.identity.libraryId },
  });
  expect(openFull).not.toHaveBeenCalled();
});

it('promotes an unsupported view to the authoritative document path', async () => {
  const vault = new MemoryVault();
  await cached(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  await expect(opened!.authority.select({ kind: 'history' })).resolves.toEqual({
    kind: 'history',
    items: [],
  });
  expect(openFull).toHaveBeenCalledOnce();
});

it('names cached shelves through content without opening library documents', async () => {
  const vault = new MemoryVault();
  await cached(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const named = {
    title: vi.fn(async () => ({
      kind: 'found' as const,
      value: { title: { type: 'movie' as const, id: 7, title: 'Seven' } },
    })),
  };
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, named, vi.fn());
  await expect(
    opened!.authority.query({ kind: 'library.metadata', titles: [{ type: 'movie', id: 7 }] }),
  ).resolves.toMatchObject({
    kind: 'library.metadata',
    titles: [{ type: 'movie', id: 7, title: 'Seven' }],
    shapes: [],
  });
  expect(openFull).not.toHaveBeenCalled();
});

it('keeps retained presentation hints without opening library documents', async () => {
  const vault = new MemoryVault();
  await cached(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  await expect(
    opened!.authority.command(
      { kind: 'retained.home-continue.set', present: true },
      'continue-hint',
    ),
  ).resolves.toEqual({ outcome: 'applied', delivery: 'local', affected: [] });
  await expect(opened!.authority.query({ kind: 'retained.home-continue.get' })).resolves.toEqual({
    kind: 'retained.home-continue',
    present: true,
  });
  await writeEncryptedLibraryValue(libraryKey, vault, RETAINED_PREFERENCE_SEED, {});
  await expect(
    opened!.authority.command({ kind: 'preferences.seed', household: {} }, 'preference-seed'),
  ).resolves.toEqual({ outcome: 'unchanged', delivery: 'synced', affected: [] });
  expect(openFull).not.toHaveBeenCalled();
});

it('keeps matching TV layouts lazy and promotes a changed layout', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  const oldShape = {
    title: { type: 'tv' as const, id: 8 },
    seasons: [{ season: 1, episodes: 10 }],
  };
  value.pieces.continue!.layouts['tv:8'] = libraryMetadataShapeDigest(oldShape);
  await writeFinishedLibraryViews(libraryKey, vault, value);
  const openFull = vi.fn(async () => fullAuthority());
  const layouts = {
    title: vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'found',
        value: {
          title: { type: 'tv', id: 8, title: 'Eight' },
          shape: { counts: new Map([[1, 10]]) },
        },
      })
      .mockResolvedValueOnce({
        kind: 'found',
        value: {
          title: { type: 'tv', id: 8, title: 'Eight' },
          shape: { counts: new Map([[1, 11]]) },
        },
      }),
  };
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, layouts, vi.fn());
  const query = { kind: 'library.metadata' as const, titles: [{ type: 'tv' as const, id: 8 }] };
  await opened!.authority.query(query);
  expect(openFull).not.toHaveBeenCalled();
  await opened!.authority.query(query);
  await vi.waitFor(() => expect(openFull).toHaveBeenCalledOnce());
});

it('keeps the cache on an unchanged head and promotes when reconciliation finds a change', async () => {
  vi.useFakeTimers();
  try {
    const vault = new MemoryVault();
    const value = await cached(vault);
    const openFull = vi.fn(async () => fullAuthority());
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ generation: value.identity.generation, head: 12, entries: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            generation: value.identity.generation,
            head: 13,
            entries: [{ k: 'changed' }],
          }),
          { status: 200 },
        ),
      );
    const opened = await openFinishedLibraryViewAuthority(
      request,
      vault,
      openFull,
      content,
      fetchImpl,
    );
    await opened!.authority.observe({
      kind: 'lifecycle',
      visible: true,
      online: true,
      playbackActive: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(openFull).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(openFull).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('misses before reading views when durable pending work exists', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  await vault.put(`${value.identity.libraryId}:runtime:pending:one`, Uint8Array.of(1));
  await expect(
    openFinishedLibraryViewAuthority(request, vault, async () => fullAuthority(), content, vi.fn()),
  ).resolves.toBeNull();
});

it('misses once Continue reaches its reconsideration time', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  value.identity.reconsiderAt = Date.now() - 1;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  await expect(
    openFinishedLibraryViewAuthority(request, vault, async () => fullAuthority(), content, vi.fn()),
  ).resolves.toBeNull();
});
