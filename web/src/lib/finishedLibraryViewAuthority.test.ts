import { expect, it, vi } from 'vitest';
import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  readFinishedLibraryViews,
  writeFinishedLibraryViews,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import { LIBRARY_LOCAL_AUTHORITY } from './libraryLocalAuthority';
import { writeEncryptedLibraryValue } from './libraryLocalValue';
import { openFinishedLibraryViewAuthority } from './finishedLibraryViewAuthority';
import { LibraryFactStore } from './libraryFactStore';
import type { Vault, VaultChange } from './localVault';
import { LIBRARY_SERVICE_PROTOCOL, type LibraryServiceHello } from './libraryServiceProtocol';
import type { LibraryServiceAuthority } from './libraryServiceCore';
import { deriveKeys, seal, type SettingsRow, type TitleRow } from './wire';
import { libraryMetadataShapeDigest } from './libraryMetadata';
import { RETAINED_PREFERENCE_SEED } from './libraryRetainedViews';
import { ensureSyncPolicy } from './syncLoader';
import { ContinueProjector } from './library';

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

class FactVault extends MemoryVault {
  async page(prefix: string, after: string | undefined, limit: number) {
    return [...this.values]
      .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit);
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

const factTitle = (status: TitleRow['status']['value'], at: number): TitleRow => ({
  kind: 'rec',
  schema: 2,
  title: { type: 'movie', id: 77 },
  status: { value: status, at: [at, 0, 'device'] },
  resume: { value: 0, at: [at, 0, 'device'], viewing: 0 },
  reaction: { value: null, at: [at, 0, 'device'] },
  deleted: { value: false, at: [at, 0, 'device'] },
  dismissed: { value: false, at: [0, 0, ''] },
  episodesReset: null,
  addedAt: at,
  watchedAt: status === 'watched' ? at : null,
});

async function cached(vault: Vault): Promise<FinishedLibraryViews> {
  const value: FinishedLibraryViews = {
    schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
    identity: {
      libraryId: (await deriveKeys(raw)).id,
      generation: 'generation-a',
      head: 12,
      authorityRevision: 'revision-a',
      policyVersion: FINISHED_LIBRARY_POLICY,
      rowsVersion: 3,
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
      devices: {
        kind: 'devices',
        devices: [{ id: 'living-room', name: 'Living Room', kind: 'tv' }],
      },
    },
  } as unknown as FinishedLibraryViews;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  await writeEncryptedLibraryValue(libraryKey, vault, LIBRARY_LOCAL_AUTHORITY, {
    generation: value.identity.generation,
    head: value.identity.head,
    authorityRevision: value.identity.authorityRevision,
    rowsVersion: value.identity.rowsVersion,
  });
  return value;
}

function fullAuthority(): LibraryServiceAuthority {
  return {
    generation: 'generation-a',
    async select(selection) {
      if (selection.kind === 'history') return { kind: 'history', items: [] };
      if (selection.kind === 'continue') return { kind: 'continue', items: [], needsShapes: [] };
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
  vault.reads.length = 0;
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  expect(opened).not.toBeNull();
  expect(vault.reads).toHaveLength(2);
  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toEqual({
    kind: 'overview',
    ...value.pieces.recommendations,
    watchlist: value.pieces.watchlist!.titles,
  });
  expect(vault.reads.some((key) => key.endsWith(':continue'))).toBe(false);
  expect(vault.reads.some((key) => key.endsWith(':settings'))).toBe(false);
  expect(vault.reads.some((key) => key.endsWith(':runtime'))).toBe(false);
  expect(vault.reads.some((key) => key.endsWith(':devices'))).toBe(false);
  await expect(opened!.authority.select({ kind: 'continue' })).resolves.toEqual(
    value.pieces.continue!.view,
  );
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toEqual(
    value.pieces.settings,
  );
  await expect(opened!.authority.select({ kind: 'devices' })).resolves.toEqual(
    value.pieces.devices,
  );
  await expect(opened!.authority.query({ kind: 'relay.membership' })).resolves.toMatchObject({
    kind: 'relay.membership',
    capability: { libraryId: value.identity.libraryId },
  });
  expect(openFull).not.toHaveBeenCalled();
});

it('opens completed capability facts without a monolithic snapshot or finished-view cache', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const keys = await deriveKeys(raw);
  const row = factTitle('watchlist', 10);
  const encrypted = await seal(keys, row);
  const facts = (await LibraryFactStore.open(libraryKey, vault))!;
  await facts.commitBatch(
    'generation-a',
    12,
    [{ k: encrypted.k, seq: 12, value: encrypted.v, row }],
    true,
  );
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    kind: 'overview',
    watchlist: [{ type: 'movie', id: 77 }],
  });
  expect(openFull).not.toHaveBeenCalled();
  await opened!.authority.select({ kind: 'history' });
  expect(openFull).toHaveBeenCalledOnce();
});

/**
 * den-edge's `/changes` over `entries`: oldest first after `since`, and — unless `older`, a den-edge that predates them
 * and reads every request as one from `since=0` — newest first below `before` and the named `keys`. `limit` defaults
 * as den-edge's does; `fail` throws for the requests it names; `counted` reports the library's rows with a
 * newest-first page, as a newer den-edge does.
 */
function changesEdge(
  entries: ReadonlyArray<{ k: string; seq: number; v: string }>,
  generation: string,
  {
    older = false,
    fail,
    counted = false,
  }: { older?: boolean; fail?: (url: URL) => boolean; counted?: boolean } = {},
) {
  const requests: URL[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'https://den.test');
    if (url.pathname.endsWith('/member')) return new Response(null, { status: 204 });
    requests.push(url);
    if (fail?.(url)) throw new Error('device stopped');
    const limit = Number(url.searchParams.get('limit') ?? 500);
    const head = Math.max(0, ...entries.map((entry) => entry.seq));
    const keys = url.searchParams.get('keys');
    const before = url.searchParams.get('before');
    let body: Record<string, unknown>;
    if (!older && keys !== null) {
      const named = new Set(keys.split(','));
      body = {
        entries: entries.filter((entry) => named.has(entry.k)),
        more: false,
        selected: true,
      };
    } else if (!older && before !== null) {
      const below = entries.filter((entry) => entry.seq < Number(before)).reverse();
      body = {
        entries: below.slice(0, limit),
        more: below.length > limit,
        order: 'desc',
        ...(counted ? { rows: entries.length } : {}),
      };
    } else {
      const since = Number(url.searchParams.get('since') ?? 0);
      const after = entries.filter((entry) => entry.seq > since);
      body = { entries: after.slice(0, limit), more: after.length > limit };
    }
    return new Response(JSON.stringify({ generation, head, ...body }), { status: 200 });
  });
  return { fetchImpl, requests };
}

it('cold-imports bounded pages from an older den-edge and serves the main startup capabilities without full hydration', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const keys = await deriveKeys(raw);
  const entries = await Promise.all(
    Array.from({ length: 130 }, async (_, index) => {
      const row = { ...factTitle(index % 2 ? 'watchlist' : 'watched', index + 1) };
      row.title = { type: 'movie', id: index + 1 };
      const encrypted = await seal(keys, row);
      return { ...encrypted, seq: index + 1 };
    }),
  );
  const pageSizes: number[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'https://den.test');
    if (url.pathname.endsWith('/member')) return new Response(null, { status: 204 });
    // An older den-edge reads a newest-first or by-key request as one from `since=0`, unmarked.
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
    if (url.searchParams.has('since')) pageSizes.push(limit);
    const page = entries.filter((entry) => entry.seq > since).slice(0, limit);
    return new Response(
      JSON.stringify({
        generation: 'generation-cold',
        head: entries.length,
        more: page.at(-1)?.seq !== entries.length,
        entries: page,
      }),
      { status: 200 },
    );
  });
  const openFull = vi.fn(async () => fullAuthority());
  const commitBatch = vi.spyOn(LibraryFactStore.prototype, 'commitBatch');
  const progress = vi.fn();
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    fetchImpl,
    progress,
  );

  // Asked newest first, it answered unmarked: one oldest-first read of the whole history follows, each committed
  // checkpoint bounded and saying how far it is, after a 0 before the first request.
  expect(pageSizes).toEqual([1000]);
  expect(commitBatch.mock.calls.map(([, , batch]) => batch.length)).toEqual([64, 64, 2]);
  commitBatch.mockRestore();
  expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 64 / 130, 128 / 130, 1]);
  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    watchlist: expect.arrayContaining([{ type: 'movie', id: 2 }]),
  });
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toMatchObject({
    kind: 'settings',
    assistant: { read: false, write: false },
  });
  await expect(opened!.authority.select({ kind: 'devices' })).resolves.toEqual({
    kind: 'devices',
    devices: [],
  });
  expect(openFull).not.toHaveBeenCalled();
  expect([...vault.values.keys()].some((key) => /:log\.v[14]$/.test(key))).toBe(false);
  expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
    generation: 'generation-cold',
    head: 130,
    complete: true,
  });
});

it('resumes a cold import from an older den-edge from the last atomically committed page', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const keys = await deriveKeys(raw);
  const entries = await Promise.all(
    Array.from({ length: 90 }, async (_, index) => {
      const value = { ...factTitle('watchlist', index + 1) };
      value.title = { type: 'movie', id: index + 1 };
      return { ...(await seal(keys, value)), seq: index + 1 };
    }),
  );
  const interrupted = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'https://den.test');
    if (url.pathname.endsWith('/member')) return new Response(null, { status: 204 });
    // The device stops once the first page is read; an older den-edge answers every other request as `since=0`.
    if (Number(url.searchParams.get('since') ?? 0) > 0) throw new Error('device stopped');
    return new Response(
      JSON.stringify({
        generation: 'generation-resume',
        head: entries.length,
        more: true,
        entries: entries.slice(0, 64),
      }),
      { status: 200 },
    );
  });
  await expect(
    openFinishedLibraryViewAuthority(request, vault, vi.fn(), content, interrupted),
  ).resolves.toBeNull();
  expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
    generation: 'generation-resume',
    head: 64,
    complete: false,
  });

  const resumedSince: number[] = [];
  const resumed = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'https://den.test');
    if (url.pathname.endsWith('/member')) return new Response(null, { status: 204 });
    const since = Number(url.searchParams.get('since'));
    resumedSince.push(since);
    const page = entries.filter((entry) => entry.seq > since).slice(0, 64);
    return new Response(
      JSON.stringify({
        generation: 'generation-resume',
        head: entries.length,
        more: page.at(-1)?.seq !== entries.length,
        entries: page,
      }),
      { status: 200 },
    );
  });
  const opened = await openFinishedLibraryViewAuthority(request, vault, vi.fn(), content, resumed);
  expect(resumedSince).toEqual([64]);
  expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
    head: 90,
    complete: true,
  });
  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    watchlist: expect.arrayContaining([{ type: 'movie', id: 90 }]),
  });
});

/** A library whose oldest row is its preferences (anime hidden), then `titles` watchlisted titles, newest last. */
async function settledLongAgo(titles: number) {
  const keys = await deriveKeys(raw);
  const prefs: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'prefs',
    values: { 'den.hideAnime': { value: { bool: true }, at: [1, 0, 'device'] } },
  };
  const entries = [{ ...(await seal(keys, prefs)), seq: 1 }];
  for (let id = 1; id <= titles; id += 1) {
    const row = { ...factTitle('watchlist', id + 1), title: { type: 'movie' as const, id } };
    entries.push({ ...(await seal(keys, row)), seq: id + 1 });
  }
  return entries;
}

it('draws a first open from its newest page and its settings by key, then reads the rest behind it', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const entries = await settledLongAgo(1_100);
  const edge = changesEdge(entries, 'generation-newest');
  // The rest of the history waits until the first page has been looked at.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const before = new URL(String(input), 'https://den.test').searchParams.get('before');
    if (before !== null && Number(before) < Number.MAX_SAFE_INTEGER) await released;
    return edge.fetchImpl(input, init);
  });
  const openFull = vi.fn(async () => fullAuthority());
  const progress = vi.fn();
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    fetchImpl,
    progress,
  );

  // Answered after one newest-first page, with the settings read by key beside it.
  expect(edge.requests.map((url) => [...url.searchParams.keys()].sort().join('&'))).toEqual([
    'before&limit',
    'keys',
  ]);
  const first = (await opened!.authority.select({ kind: 'overview' })) as { watchlist: unknown[] };
  expect(first.watchlist).toContainEqual({ type: 'movie', id: 1_100 });
  expect(first.watchlist).not.toContainEqual({ type: 'movie', id: 1 });
  // The oldest row of all, yet already applied.
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toMatchObject({
    preferences: { hideAnime: true },
  });
  expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
    head: 1_101,
    complete: false,
    floor: 102,
  });
  expect(progress.mock.calls.at(-1)![0]).toBeLessThan(1);

  const changed = vi.fn();
  opened!.authority.listen?.(changed);
  release();
  await vi.waitFor(async () =>
    expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
      head: 1_101,
      complete: true,
    }),
  );
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'changed',
        affected: expect.arrayContaining([{ kind: 'overview' }]),
      }),
    ),
  );
  const filled = (await opened!.authority.select({ kind: 'overview' })) as { watchlist: unknown[] };
  expect(filled.watchlist).toContainEqual({ type: 'movie', id: 1 });
  expect(progress.mock.calls.at(-1)![0]).toBe(1);
  expect(openFull).not.toHaveBeenCalled();
}, 10_000);

it('waits for a newest-first import before reading a title from the completed facts', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const entries = await settledLongAgo(1_100);
  const edge = changesEdge(entries, 'generation-title-during-fill');
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const before = new URL(String(input), 'https://den.test').searchParams.get('before');
    if (before !== null && Number(before) < Number.MAX_SAFE_INTEGER) await released;
    return edge.fetchImpl(input, init);
  });
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    fetchImpl,
  );

  // This title is in the older page that is still being imported. Opening it must join that read rather than start
  // a second, oldest-first read of the whole library.
  let selected = false;
  const selection = opened!.authority.select({
    kind: 'title',
    title: { type: 'movie', id: 1 },
  });
  void selection.then(
    () => (selected = true),
    () => (selected = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selected).toBe(false);
  expect(openFull).not.toHaveBeenCalled();

  release();
  await expect(selection).resolves.toMatchObject({
    kind: 'title',
    title: { type: 'movie', id: 1 },
  });
  await expect((await LibraryFactStore.open(libraryKey, vault))!.manifest()).resolves.toMatchObject(
    {
      complete: true,
    },
  );
  expect(openFull).not.toHaveBeenCalled();
});

it('counts a first open’s progress in rows, and asks for the second page as the first arrives', async () => {
  await ensureSyncPolicy();
  // Older rows replaced over the years: below the newest 1,000, the history's sequence numbers are ten apart.
  const settled = [...(await settledLongAgo(1_100))].sort((a, b) => a.seq - b.seq);
  const older = settled.length - 1_000;
  const entries = settled.map((entry, at) => ({
    ...entry,
    seq: at < older ? 1 + at * 10 : 1 + older * 10 + (at - older),
  }));
  const top = entries.at(-1)!.seq;
  const firstPageFloor = entries.at(-1_000)!.seq;
  const progressAfterFirstPage = async (counted: boolean) => {
    const vault = new FactVault();
    const edge = changesEdge(entries, 'generation-rows', { counted });
    const pagesAsked = () => edge.requests.filter((url) => url.searchParams.has('before')).length;
    // How many history pages had been asked for when the first batch was kept.
    let askedAtFirstSave = 0;
    const progress = vi.fn((value: number) => {
      if (value > 0 && !askedAtFirstSave) askedAtFirstSave = pagesAsked();
    });
    const opened = await openFinishedLibraryViewAuthority(
      request,
      vault,
      vi.fn(async () => fullAuthority()),
      content,
      edge.fetchImpl,
      progress,
    );
    expect(opened).not.toBeNull();
    const firstPage = progress.mock.calls.map(([value]) => value).filter((value) => value < 1);
    return { last: firstPage.at(-1)!, askedAtFirstSave };
  };

  const counted = await progressAfterFirstPage(true);
  // 1,000 of 1,100 rows kept: what the line says, not how far below the head the page reached.
  expect(counted.last).toBeCloseTo(1_000 / entries.length, 2);
  expect(counted.askedAtFirstSave).toBe(2);
  // An older den-edge says no count: the share of sequence numbers read, as before.
  const uncounted = await progressAfterFirstPage(false);
  expect(uncounted.last).toBeCloseTo(1 - (firstPageFloor - 1) / top, 2);
  expect(uncounted.last).toBeLessThan(counted.last);
}, 10_000);

it('ends a first open’s progress when its read gives up, so the line never outlives it', async () => {
  await ensureSyncPolicy();
  const edge = changesEdge(await settledLongAgo(10), 'generation-gives-up', {
    fail: (url) => url.searchParams.has('before'),
  });
  const progress = vi.fn();
  await openFinishedLibraryViewAuthority(
    request,
    new FactVault(),
    vi.fn(async () => fullAuthority()),
    content,
    edge.fetchImpl,
    progress,
  );
  expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 1]);
});

it('resumes a newest-first import below the last committed page, and opens the log when the rest stops', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const entries = await settledLongAgo(1_100);
  // The device stops once the first page is kept.
  const interrupted = changesEdge(entries, 'generation-newest', {
    fail: (url) => Number(url.searchParams.get('before') ?? Infinity) < Number.MAX_SAFE_INTEGER,
  });
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    interrupted.fetchImpl,
  );
  expect(opened).not.toBeNull();
  // The stopped read leaves Home to the full log rather than to half a history.
  await vi.waitFor(() => expect(openFull).toHaveBeenCalledOnce());
  await opened!.authority.close?.();

  const resumed = changesEdge(entries, 'generation-newest');
  const reopened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    vi.fn(async () => fullAuthority()),
    content,
    resumed.fetchImpl,
  );
  // Below the floor the first open kept, without reading the settings again.
  expect(resumed.requests.map((url) => url.searchParams.get('before'))).toEqual(['102']);
  expect(await (await LibraryFactStore.open(libraryKey, vault))!.manifest()).toMatchObject({
    head: 1_101,
    complete: true,
  });
  await expect(reopened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    watchlist: expect.arrayContaining([{ type: 'movie', id: 1 }]),
  });
});

it('applies one changed document to capability facts without opening unrelated documents', async () => {
  vi.useFakeTimers();
  try {
    await ensureSyncPolicy();
    const vault = new FactVault();
    const keys = await deriveKeys(raw);
    const old = factTitle('watchlist', 10);
    const replacement = factTitle('watched', 20);
    const before = await seal(keys, old);
    const after = await seal(keys, replacement);
    expect(after.k).toBe(before.k);
    const facts = (await LibraryFactStore.open(libraryKey, vault))!;
    await facts.commitBatch(
      'generation-a',
      12,
      [{ k: before.k, seq: 12, value: before.v, row: old }],
      true,
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          generation: 'generation-a',
          head: 13,
          more: false,
          entries: [{ k: after.k, seq: 13, v: after.v }],
        }),
        { status: 200 },
      ),
    );
    const openFull = vi.fn(async () => fullAuthority());
    const opened = await openFinishedLibraryViewAuthority(
      request,
      vault,
      openFull,
      content,
      fetchImpl,
    );
    await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
      watchlist: [{ type: 'movie', id: 77 }],
    });
    await opened!.authority.observe({
      kind: 'lifecycle',
      visible: true,
      online: true,
      playbackActive: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(facts.manifest()).resolves.toMatchObject({ head: 13 }));
    await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
      watchlist: [],
      watched: [{ type: 'movie', id: 77 }],
    });
    expect(openFull).not.toHaveBeenCalled();
    expect(await facts.manifest()).toMatchObject({ head: 13, complete: true });
  } finally {
    vi.useRealTimers();
  }
});

/** A series in the fact store as Library v4 documents: its title, and season 1 with episodes 1–2 watched, 3 half. */
/** A series in progress on `device`; `seconds` is where its third episode was left, when given. */
async function seriesFacts(vault: FactVault, seconds?: number) {
  const keys = await deriveKeys(raw);
  const at: [number, number, string] = [Date.now() - 86_400_000, 0, 'device'];
  const episode = (value: number, position?: number) => ({
    // A position is the series' newest mark: Continue's live position comes from that one.
    progress:
      position === undefined
        ? { value, at, viewing: 0 }
        : { value, at: [at[0] + 1_000, 0, 'device'], viewing: 0, seconds: position },
    imported: false,
    plays: { 0: at[0] },
    cleared: null,
  });
  const rows = [
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 55 },
      status: { value: 'inProgress', at },
      addedAt: at[0],
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 55 },
      season: 1,
      seasonReset: null,
      episodes: { 1: episode(1), 2: episode(1), 3: episode(0.5, seconds) },
    },
  ] as unknown as Parameters<typeof seal>[1][];
  const entries = await Promise.all(
    rows.map(async (row, index) => {
      const sealed = await seal(keys, row);
      return { k: sealed.k, seq: 10 + index, value: sealed.v, row };
    }),
  );
  const facts = (await LibraryFactStore.open(libraryKey, vault))!;
  await facts.commitBatch('generation-a', 12, entries, true);
}

const seriesShape = {
  kind: 'title-shape' as const,
  title: { type: 'tv' as const, id: 55 },
  seasons: [{ season: 1, episodes: 3 }],
};

it('reads a title’s view from its own documents, as the full log builds it, without opening the log', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await expect(opened!.authority.observe(seriesShape)).resolves.toEqual({
    outcome: 'applied',
    affected: [{ kind: 'title', title: { type: 'tv', id: 55 } }],
  });
  const view = await opened!.authority.select({ kind: 'title', title: { type: 'tv', id: 55 } });
  expect(view).toMatchObject({
    kind: 'title',
    listed: true,
    watched: false,
    standing: 'in-progress',
    episodes: [
      { season: 1, episode: 1, watched: true, fraction: 1 },
      { season: 1, episode: 2, watched: true, fraction: 1 },
      { season: 1, episode: 3, watched: false, fraction: 0.5 },
    ],
  });
  expect(openFull).not.toHaveBeenCalled();
});

it('counts a served series’ episodes once naming finds its shape, and keeps other shapes from the log', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault);
  const shaped = (id: number) => ({
    kind: 'found' as const,
    value: {
      title: { type: 'tv' as const, id, title: `Series ${id}` },
      shape: { counts: new Map([[1, 3]]) },
    },
  });
  const named = { title: vi.fn(async (ref: { id: number }) => shaped(ref.id)) };
  const full = fullAuthority();
  const observe = vi.spyOn(full, 'observe');
  const openFull = vi.fn(async () => full);
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, named, vi.fn());
  const changed: unknown[] = [];
  opened!.authority.listen!((event) => changed.push(event));
  const series = { type: 'tv' as const, id: 55 };

  // The page is open before its shape is known: no episodes yet.
  await expect(opened!.authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
    episodes: [],
  });
  // Naming finds the shape of the series on screen, and of another only named.
  await opened!.authority.query({
    kind: 'library.metadata',
    titles: [series, { type: 'tv', id: 56 }],
  });
  expect(changed).toContainEqual({ kind: 'changed', affected: [{ kind: 'title', title: series }] });
  expect(JSON.stringify(changed)).not.toContain('"id":56');
  await expect(opened!.authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
    episodes: [
      { season: 1, episode: 1, watched: true },
      { season: 1, episode: 2, watched: true },
      { season: 1, episode: 3, watched: false, fraction: 0.5 },
    ],
  });
  // A write opens the log: it is told the served series' shape, not the one only named.
  await opened!.authority.command(
    { kind: 'watchlist.add', title: { type: 'movie', id: 9 } },
    'operation',
  );
  expect(observe.mock.calls.map(([observation]) => observation)).toEqual([
    expect.objectContaining({ kind: 'title-shape', title: series }),
  ]);
  expect(openFull).toHaveBeenCalledOnce();
});

it('names the device a Continue item was watched on, as the full log does', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault, 600);
  // The device `seriesFacts` stamps its episodes with.
  const devices = {
    kind: 'set',
    schema: 2,
    name: 'devices',
    values: { 'device.name': { value: { string: 'Living Room' }, at: [1_000, 0, 'device'] } },
  } as unknown as Parameters<typeof seal>[1];
  const sealed = await seal(await deriveKeys(raw), devices);
  const facts = (await LibraryFactStore.open(libraryKey, vault))!;
  await facts.commitBatch(
    'generation-a',
    13,
    [{ k: sealed.k, seq: 13, value: sealed.v, row: devices }],
    true,
  );
  const named = {
    title: vi.fn(async () => ({
      kind: 'found' as const,
      value: {
        title: { type: 'tv' as const, id: 55, title: 'Fifty-five' },
        shape: { counts: new Map([[1, 3]]) },
      },
    })),
  };
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    vi.fn(async () => fullAuthority()),
    named,
    vi.fn(),
  );
  await opened!.authority.select({ kind: 'continue' });
  await opened!.authority.query({ kind: 'library.metadata', titles: [{ type: 'tv', id: 55 }] });
  await expect(opened!.authority.select({ kind: 'continue' })).resolves.toMatchObject({
    items: [{ title: { type: 'tv', id: 55 }, device: 'Living Room' }],
  });
  await opened!.authority.close?.();
});

/** Every root view a LibraryModel selects (`libraryModel.svelte.ts`). */
const roots = ['overview', 'continue', 'settings', 'runtime', 'devices'] as const;

it('does not save false assistant flags and promotes Settings for live grant/read rows', async () => {
  const vault = new FactVault();
  const keys = await deriveKeys(raw);
  const stamp: [number, number, string] = [10, 0, '0123456789abcdef'];
  const prefs: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'prefs',
    values: { 'den.hideAnime': { value: { bool: true }, at: stamp } },
  };
  const grants: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'assistant-grants',
    values: {
      '0123456789abcdef0123456789abcdef': {
        value: {
          string: JSON.stringify({
            v: 1,
            client: 'Claude',
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 86_400_000,
            revokedAt: null,
            cap: 100,
            ops: ['seen'],
            pk: 'a'.repeat(43),
          }),
        },
        at: stamp,
      },
    },
  };
  const reads: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'assistant-read',
    values: {
      fedcba9876543210fedcba9876543210: {
        value: {
          string: JSON.stringify({
            v: 1,
            client: 'ChatGPT',
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 86_400_000,
            revokedAt: null,
            key: 'b'.repeat(43),
          }),
        },
        at: stamp,
      },
    },
  };
  const entries = await Promise.all(
    [prefs, grants, reads].map(async (row, index) => {
      const encrypted = await seal(keys, row);
      return { k: encrypted.k, seq: index + 1, value: encrypted.v, row };
    }),
  );
  const facts = (await LibraryFactStore.open(libraryKey, vault))!;
  await facts.commitBatch('generation-assistant', 3, entries, true);
  const full = fullAuthority();
  vi.spyOn(full, 'select').mockImplementation(async (selection) => {
    if (selection.kind === 'settings')
      return {
        kind: 'settings',
        preferences: { hideAnime: true },
        assistant: { read: true, write: true },
      } as never;
    throw new Error(`unexpected ${selection.kind}`);
  });
  const openFull = vi.fn(async () => full);
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  // The background writer keeps the assistant-independent Home pieces, but must not turn the live rows into a
  // durable disabled Settings answer before Settings asks.
  await expect(opened!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    kind: 'overview',
    watchlist: [],
  });
  expect(openFull).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject({
      pieces: { watchlist: { titles: [] } },
    }),
  );
  await expect(readFinishedLibraryViews(libraryKey, vault, ['settings'])).resolves.toBeNull();
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toMatchObject({
    preferences: { hideAnime: true },
    assistant: { read: true, write: true },
  });
  expect(openFull).toHaveBeenCalledOnce();
  await opened!.authority.close?.();

  // A later visit must still use the partial Home cache without treating its absent Settings as disabled flags.
  openFull.mockClear();
  const returning = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    vi.fn(),
  );
  await expect(returning!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
    kind: 'overview',
    watchlist: [],
  });
  expect(openFull).not.toHaveBeenCalled();
  await expect(returning!.authority.select({ kind: 'settings' })).resolves.toMatchObject({
    assistant: { read: true, write: true },
  });
  expect(openFull).toHaveBeenCalledOnce();
  await returning!.authority.close?.();
});

it('keeps the views a facts visit read, once Continue has its layouts, and the next visit draws them without den-core', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault);
  const series = { type: 'tv' as const, id: 55 };
  const named = {
    title: vi.fn(async () => ({
      kind: 'found' as const,
      value: {
        title: { type: 'tv' as const, id: 55, title: 'Fifty-five' },
        shape: { counts: new Map([[1, 3]]) },
      },
    })),
  };
  const first = await openFinishedLibraryViewAuthority(
    request,
    vault,
    vi.fn(async () => fullAuthority()),
    named,
    vi.fn(),
  );
  for (const kind of roots) await first!.authority.select({ kind });
  // Continue still lacks the series' layout: nothing is kept that the next visit would draw differently.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect(readFinishedLibraryViews(libraryKey, vault, [])).resolves.toBeNull();
  await first!.authority.query({ kind: 'library.metadata', titles: [series] });
  const drawn = await first!.authority.select({ kind: 'continue' });
  expect(drawn).toMatchObject({ items: [{ title: series }], needsShapes: [] });
  await vi.waitFor(() =>
    expect(readFinishedLibraryViews(libraryKey, vault, ['continue'])).resolves.toMatchObject({
      pieces: { continue: { view: drawn } },
    }),
  );
  await first!.authority.close?.();

  const project = vi.spyOn(ContinueProjector.prototype, 'project');
  try {
    const openFull = vi.fn(async () => fullAuthority());
    const second = await openFinishedLibraryViewAuthority(request, vault, openFull, named, vi.fn());
    await expect(second!.authority.select({ kind: 'continue' })).resolves.toEqual(drawn);
    for (const kind of roots) await second!.authority.select({ kind });
    // The kept layout matches the series' shape: still drawn without the log.
    await second!.authority.query({ kind: 'library.metadata', titles: [series] });
    expect(project).not.toHaveBeenCalled();
    expect(openFull).not.toHaveBeenCalled();
    await second!.authority.close?.();
  } finally {
    project.mockRestore();
  }
});

it('keeps no views while the history is still read, and keeps them once it is whole', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const edge = changesEdge(await settledLongAgo(1_100), 'generation-kept-after-fill');
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const before = new URL(String(input), 'https://den.test').searchParams.get('before');
    if (before !== null && Number(before) < Number.MAX_SAFE_INTEGER) await released;
    return edge.fetchImpl(input, init);
  });
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    vi.fn(async () => fullAuthority()),
    content,
    fetchImpl,
  );
  for (const kind of roots) await opened!.authority.select({ kind });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect(readFinishedLibraryViews(libraryKey, vault, [])).resolves.toBeNull();
  release();
  await vi.waitFor(
    () =>
      expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject({
        identity: { generation: 'generation-kept-after-fill', head: 1_101 },
        pieces: { watchlist: { titles: expect.arrayContaining([{ type: 'movie', id: 1 }]) } },
      }),
    { timeout: 5_000 },
  );
  await opened!.authority.close?.();
});

it('catches kept views up from facts when den-edge moved on, and keeps the new ones', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const keys = await deriveKeys(raw);
  const old = factTitle('watchlist', 10);
  const before = await seal(keys, old);
  const after = await seal(keys, factTitle('watched', 20));
  const facts = (await LibraryFactStore.open(libraryKey, vault))!;
  await facts.commitBatch(
    'generation-a',
    12,
    [{ k: before.k, seq: 12, value: before.v, row: old }],
    true,
  );
  const first = await openFinishedLibraryViewAuthority(
    request,
    vault,
    vi.fn(async () => fullAuthority()),
    content,
    vi.fn(),
  );
  for (const kind of roots) await first!.authority.select({ kind });
  await first!.authority.close?.();
  await expect(readFinishedLibraryViews(libraryKey, vault, [])).resolves.toMatchObject({
    identity: { head: 12 },
  });

  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          generation: 'generation-a',
          head: 13,
          more: false,
          entries: [{ k: after.k, seq: 13, v: after.v }],
        }),
        { status: 200 },
      ),
  );
  const project = vi.spyOn(ContinueProjector.prototype, 'project');
  try {
    const openFull = vi.fn(async () => fullAuthority());
    const second = await openFinishedLibraryViewAuthority(
      request,
      vault,
      openFull,
      content,
      fetchImpl,
    );
    for (const kind of roots) await second!.authority.select({ kind });
    await expect(second!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
      watchlist: [{ type: 'movie', id: 77 }],
    });
    // Drawn from the kept views: den-core has not projected Continue.
    expect(project).not.toHaveBeenCalled();
    const changed = vi.fn();
    second!.authority.listen?.(changed);
    await second!.authority.observe({
      kind: 'lifecycle',
      visible: true,
      online: true,
      playbackActive: false,
    });
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'changed',
          affected: expect.arrayContaining([{ kind: 'continue' }, { kind: 'overview' }]),
        }),
      ),
    );
    expect(project).toHaveBeenCalled();
    await expect(second!.authority.select({ kind: 'overview' })).resolves.toMatchObject({
      watchlist: [],
      watched: [{ type: 'movie', id: 77 }],
    });
    await vi.waitFor(() =>
      expect(readFinishedLibraryViews(libraryKey, vault, ['watchlist'])).resolves.toMatchObject({
        identity: { head: 13 },
        pieces: { watchlist: { titles: [] } },
      }),
    );
    expect(openFull).not.toHaveBeenCalled();
    await second!.authority.close?.();
  } finally {
    project.mockRestore();
  }
});

it('reads Continue again from facts at the same head when the kept one is past its reconsider time', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const value = await cached(vault);
  value.identity.reconsiderAt = Date.now() - 1;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  const keys = await deriveKeys(raw);
  const row = factTitle('watchlist', 10);
  const encrypted = await seal(keys, row);
  await (await LibraryFactStore.open(libraryKey, vault))!.commitBatch(
    'generation-a',
    12,
    [{ k: encrypted.k, seq: 12, value: encrypted.v, row }],
    true,
  );
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  await expect(opened!.authority.select({ kind: 'continue' })).resolves.toEqual({
    kind: 'continue',
    items: [],
    needsShapes: [],
  });
  expect(openFull).not.toHaveBeenCalled();
  await opened!.authority.close?.();
});

it('tells the log the shapes it was given when a write opens it', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault);
  const full = fullAuthority();
  const observe = vi.spyOn(full, 'observe');
  const openFull = vi.fn(async () => full);
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await opened!.authority.observe(seriesShape);
  await opened!.authority.command(
    { kind: 'watchlist.add', title: { type: 'movie', id: 9 } },
    'operation',
  );
  expect(openFull).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(seriesShape);
});

it.each([
  ['not yet due, publishes nothing without opening the log', 60_000, 0],
  ['due, opens the log to decide', -1, 1],
])('an assistant publication %s', async (_, dueIn, opens) => {
  const vault = new MemoryVault();
  await cached(vault);
  await writeEncryptedLibraryValue(libraryKey, vault, 'assistant.records.v1', {
    revoked: [],
    applied: {},
    renewedAt: 0,
    dropped: [],
    publication: { key: 'built-from', dueAt: Date.now() + dueIn, sent: {}, layouts: {} },
  });
  const full = fullAuthority();
  vi.spyOn(full, 'task').mockResolvedValue({
    result: { kind: 'assistant.publish', published: 0 },
    affected: [],
  });
  const openFull = vi.fn(async () => full);
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await expect(
    opened!.authority.task({ kind: 'assistant.publish' }, 'publish'),
  ).resolves.toMatchObject({ result: { kind: 'assistant.publish', published: 0 } });
  expect(openFull).toHaveBeenCalledTimes(opens);
});

it('answers a drain that found nothing from the drop-box row, without opening the log', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  await seriesFacts(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await expect(
    opened!.authority.task({ kind: 'assistant.apply', messages: [] }, 'drain'),
  ).resolves.toEqual({
    result: { kind: 'assistant.apply', results: [], ack: null, dropbox: null },
    affected: [],
  });
  expect(openFull).not.toHaveBeenCalled();
});

it('promotes an assistant renewal so live grant rows are renewed by the document authority', async () => {
  const vault = new MemoryVault();
  await cached(vault);
  const full = fullAuthority();
  vi.spyOn(full, 'task').mockResolvedValue({
    result: { kind: 'assistant.renew', renewed: 2 },
    affected: [],
  });
  const openFull = vi.fn(async () => full);
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());

  await expect(
    opened!.authority.task(
      {
        kind: 'assistant.renew',
        grants: ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'],
      },
      'renew',
    ),
  ).resolves.toEqual({
    result: { kind: 'assistant.renew', renewed: 2 },
    affected: [],
  });
  expect(openFull).toHaveBeenCalledOnce();
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

it('promotes when uncached metadata needs credentials from the document authority', async () => {
  const vault = new MemoryVault();
  await cached(vault);
  const openFull = vi.fn(async () => fullAuthority());
  const unavailable = { title: vi.fn(async () => ({ kind: 'not-configured' as const })) };
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    unavailable,
    vi.fn(),
  );
  await expect(
    opened!.authority.query({ kind: 'library.metadata', titles: [{ type: 'movie', id: 7 }] }),
  ).resolves.toMatchObject({
    kind: 'library.metadata',
    retryable: [{ type: 'movie', id: 7 }],
  });
  await vi.waitFor(() => expect(openFull).toHaveBeenCalledOnce());
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

it('decides a first open’s preference seed from its settings facts, opening the log only to write one', async () => {
  await ensureSyncPolicy();
  const vault = new FactVault();
  const edge = changesEdge(await settledLongAgo(10), 'generation-seed');
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    edge.fetchImpl,
  );
  // The profile has decided the one preference the household holds: nothing to write, and nothing kept said so.
  const decided = { 'den.hideAnime': { value: { bool: false }, at: [1, 0, 'household'] } };
  await expect(
    opened!.authority.command({ kind: 'preferences.seed', household: decided }, 'seed-1'),
  ).resolves.toEqual({ outcome: 'unchanged', delivery: 'synced', affected: [] });
  expect(openFull).not.toHaveBeenCalled();
  // One it has not decided is written, by the log.
  const undecided = { 'den.hideWatched': { value: { bool: true }, at: [1, 0, 'household'] } };
  await opened!.authority.command({ kind: 'preferences.seed', household: undecided }, 'seed-2');
  expect(openFull).toHaveBeenCalledOnce();
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

it('returns from reconnecting to ready after an unchanged reconciliation succeeds', async () => {
  vi.useFakeTimers();
  try {
    const vault = new MemoryVault();
    const value = await cached(vault);
    const openFull = vi.fn(async () => fullAuthority());
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ generation: value.identity.generation, head: 12, entries: [] }),
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
    const events: unknown[] = [];
    opened!.authority.listen?.((event) => events.push(event));
    await opened!.authority.observe({
      kind: 'lifecycle',
      visible: true,
      online: true,
      playbackActive: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toEqual([
      { kind: 'status', status: { kind: 'reconnecting' } },
      { kind: 'status', status: { kind: 'ready' } },
    ]);
    expect(openFull).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('does not promote a changed reconciliation after the cached authority closes', async () => {
  vi.useFakeTimers();
  try {
    const vault = new MemoryVault();
    const value = await cached(vault);
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    const openFull = vi.fn(async () => fullAuthority());
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
    await opened!.authority.close?.();
    answer(
      new Response(
        JSON.stringify({ generation: value.identity.generation, head: 13, entries: [{}] }),
        { status: 200 },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(openFull).not.toHaveBeenCalled();
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

it('keeps unrelated capabilities lazy and promotes Continue after its reconsideration time', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  value.identity.reconsiderAt = Date.now() - 1;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  const openFull = vi.fn(async () => fullAuthority());
  const opened = await openFinishedLibraryViewAuthority(request, vault, openFull, content, vi.fn());
  expect(opened).not.toBeNull();
  await expect(opened!.authority.select({ kind: 'settings' })).resolves.toEqual(
    value.pieces.settings,
  );
  expect(openFull).not.toHaveBeenCalled();
  await expect(opened!.authority.select({ kind: 'continue' })).resolves.toEqual({
    kind: 'continue',
    items: [],
    needsShapes: [],
  });
  expect(openFull).toHaveBeenCalledOnce();
});

it('promotes an open cached Continue authority when its reconsideration deadline arrives', async () => {
  vi.useFakeTimers();
  try {
    const vault = new MemoryVault();
    const value = await cached(vault);
    value.identity.reconsiderAt = Date.now() + 1_000;
    await writeFinishedLibraryViews(libraryKey, vault, value);
    const openFull = vi.fn(async () => fullAuthority());
    const opened = await openFinishedLibraryViewAuthority(
      request,
      vault,
      openFull,
      content,
      vi.fn(),
    );
    await opened!.authority.select({ kind: 'continue' });
    expect(openFull).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(openFull).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(openFull).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('misses after a policy or recommendation version changes', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  value.identity.policyVersion++;
  value.identity.recommendationVersion++;
  await writeFinishedLibraryViews(libraryKey, vault, value);
  await expect(
    openFinishedLibraryViewAuthority(request, vault, async () => fullAuthority(), content, vi.fn()),
  ).resolves.toBeNull();
});

it('promotes when the remote generation changes at the same head', async () => {
  vi.useFakeTimers();
  try {
    const vault = new MemoryVault();
    const value = await cached(vault);
    const openFull = vi.fn(async () => fullAuthority());
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ generation: 'generation-b', head: value.identity.head, entries: [] }),
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
    expect(openFull).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('misses when the locally saved authority has advanced beyond the finished views', async () => {
  const vault = new MemoryVault();
  const value = await cached(vault);
  await writeEncryptedLibraryValue(libraryKey, vault, LIBRARY_LOCAL_AUTHORITY, {
    generation: value.identity.generation,
    head: value.identity.head + 1,
    authorityRevision: 'newer-local-authority',
    rowsVersion: value.identity.rowsVersion,
  });
  await expect(
    openFinishedLibraryViewAuthority(request, vault, async () => fullAuthority(), content, vi.fn()),
  ).resolves.toBeNull();
});
