import { describe, expect, it, vi } from 'vitest';
import { blankTitle } from './actions';
import { ContentAuthority, type ContentReader } from './contentAuthority';
import { openClockStore, type ClockStore } from './clockStore';
import { DownloadCoordinator } from './downloadCoordinator';
import { source } from './downloadTestLog';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { LibraryServiceAuthorityError } from './libraryServiceCore';
import { LIBRARY_SERVICE_PROTOCOL, LIBRARY_SERVICE_WIRE_LIMITS } from './libraryServiceProtocol';
import { decodeLibraryServiceServerMessage } from './libraryServiceProtocolCodec';
import type { Vault, VaultChange } from './localVault';
import { LibraryLog } from './log';
import type { ProfileDirectoryDocument } from './profileDirectory';
import { validateKidTitleApprovals, type KidTitleApprovalsDocument } from './kidTitleApprovals';
import { profilesApplyCreate } from './profilesCore';
import { ensureSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';
import profileFixture from '../vendor/den-core/profiles-v1.json';
import type { TitleSource } from './titleSources';
import { readApiKey } from './prefs';
import { TMDB_PROXY_KEY } from './tmdbCache';
import { readFinishedLibraryViews } from './finishedLibraryViews';
import { LIBRARY_LOCAL_AUTHORITY } from './libraryLocalAuthority';
import type { DocumentRow } from './wire';

// The real policy, counted: which den-core operations a selection costs.
vi.mock('./syncCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./syncCore')>();
  return { ...actual, syncPolicy: vi.fn(actual.syncPolicy) };
});

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const movie = { type: 'movie' as const, id: 7 };
const series = { type: 'tv' as const, id: 11 };
const missingContent = {
  title: async () => ({ kind: 'missing' as const }),
} satisfies Pick<ContentReader, 'title'>;

function memoryVault(withFacts = false): Vault {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (key) => data.get(key)?.slice(),
    entries: async (prefix) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, value.slice()]),
    put: async (key, value) => void data.set(key, value.slice()),
    delete: async (key) => void data.delete(key),
    remove: async (prefix) => {
      for (const key of data.keys()) if (key.startsWith(prefix)) data.delete(key);
    },
    compareAndCommit: async (
      key: string,
      expected: Uint8Array | undefined,
      changes: readonly VaultChange[],
    ) => {
      const current = data.get(key);
      if (!(
        current === expected ||
        (!!current &&
          !!expected &&
          current.byteLength === expected.byteLength &&
          current.every((byte, index) => byte === expected[index]))
      ))
        return false;
      for (const change of changes) {
        if (change.kind === 'put') data.set(change.key, change.value.slice());
        else data.delete(change.key);
      }
      return true;
    },
  };
  if (withFacts) {
    vault.commit = async (changes) => {
      for (const change of changes) {
        if (change.kind === 'put') data.set(change.key, change.value.slice());
        else data.delete(change.key);
      }
    };
    vault.page = async (prefix, after, limit) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => [key, value.slice()]);
  }
  return vault;
}

async function localAuthority() {
  const vault = memoryVault();
  const log = (await LibraryLog.openLocal(KEY, vault))!;
  const clock = await openClockStore(vault, {
    key: 'authority-test-clock',
    createDevice: () => '0123456789abcdef',
  });
  return { log, authority: authority(log, clock, 'local') };
}

function authority(
  log: LibraryLog,
  clock: ClockStore,
  mode: 'online' | 'local',
  fetchImpl?: typeof fetch,
  tmdbFetchImpl?: typeof fetch,
  extra: { libraryKey?: string; vault?: Vault } = {},
) {
  const downloads = new DownloadCoordinator(log, clock, {
    prepare: async () => ({ state: 'preparing', progress: 0 }),
    cancel: async () => true,
    resolve: async () => ({
      sources: [
        {
          identity: 'release-one',
          filename: 'Release One',
          label: 'Release One',
          url: '/scout/p/secret-one',
          size: 7_000,
          cached: true,
          badges: [],
          languages: [],
          probed: false,
          attributes: {},
        },
        {
          identity: 'release-two',
          filename: 'Release Two',
          label: 'Release Two',
          url: '/scout/p/secret-two',
          badges: [],
          languages: [],
          probed: false,
          attributes: {},
        },
      ],
    }),
    ticket: (url) => (url.startsWith('/scout/') ? url : null),
  });
  const content = tmdbFetchImpl
    ? new ContentAuthority(
        {
          tmdb: () => readApiKey(log.settings('keys'), 'tmdb') ?? TMDB_PROXY_KEY,
          omdb: () => undefined,
          contentWarnings: () => undefined,
        },
        { tmdbFetch: tmdbFetchImpl },
      )
    : missingContent;
  return new LibraryLogAuthority(log, clock, { mode, downloads, content, fetchImpl, ...extra });
}

async function pinDeliveryServer() {
  const stored = new Map<string, { k: string; seq: number; v: string }>();
  let head = 0;
  let acceptWrites = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        writes?: { k: string; base: number; v: string }[];
      };
      if (!body.writes) return new Response('{}');
      if (!acceptWrites) return new Response('{"error":"unavailable"}', { status: 503 });
      const applied: { k: string; seq: number }[] = [];
      const conflicts: { k: string; seq: number; v: string | null }[] = [];
      for (const write of body.writes) {
        const current = stored.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
        } else {
          stored.set(write.k, { k: write.k, seq: ++head, v: write.v });
          applied.push({ k: write.k, seq: head });
        }
      }
      return new Response(JSON.stringify({ head, applied, conflicts }));
    }
    const since = Number(new URL(String(input), 'https://den.example').searchParams.get('since'));
    const entries = [...stored.values()].filter((entry) => entry.seq > since);
    return new Response(JSON.stringify({ entries, head, more: false, generation: 'pin-test' }));
  };
  return { fetchImpl, allowWrites: () => (acceptWrites = true) };
}

describe('LibraryLogAuthority', () => {
  const cacheSelections = async (opened: LibraryLogAuthority) => {
    await opened.select({ kind: 'overview' });
    await opened.select({ kind: 'continue' });
    await opened.select({ kind: 'settings' });
    await opened.select({ kind: 'runtime' });
    await opened.select({ kind: 'devices' });
  };

  const cachedWatchlist = (vault: Vault) => readFinishedLibraryViews(KEY, vault, ['watchlist']);

  it.each(['overview', 'history'] as const)(
    'publishes fresh Home and Continue at an unchanged document deadline after %s-only selection',
    async (initialSelection) => {
      await ensureSyncPolicy();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const base = 1_789_000_000_000;
        const future = base + 86_400_000 + 5_000;
        vi.setSystemTime(base);
        const document: DocumentRow = {
          format: 4,
          kind: 'season',
          title: { type: 'tv', id: 1399 },
          season: 2,
          seasonReset: null,
          episodes: {
            1: {
              progress: {
                value: 0.5,
                at: [future, 0, 'aaaaaaaaaaaaaaaa'],
                viewing: 7,
                seconds: 900,
              },
              imported: false,
              plays: {},
              cleared: null,
            },
            2: {
              progress: {
                value: 0.6,
                at: [future + 2_000, 0, 'aaaaaaaaaaaaaaaa'],
                viewing: 8,
                seconds: 901,
              },
              imported: false,
              plays: {},
              cleared: null,
            },
            3: {
              progress: {
                value: 0.7,
                at: [future + 4_000, 0, 'aaaaaaaaaaaaaaaa'],
                viewing: 9,
                seconds: 902,
              },
              imported: false,
              plays: {},
              cleared: null,
            },
          },
        };
        const vault = memoryVault();
        const log = (await LibraryLog.openLocal(KEY, vault))!;
        expect(await log.writeRows([document])).toBe(true);
        const clock = await openClockStore(vault, {
          key: 'future-projection-clock',
          createDevice: () => '0123456789abcdef',
        });
        const opened = authority(log, clock, 'local');
        const events: unknown[] = [];
        opened.listen((event) => events.push(event));

        if (initialSelection === 'history') {
          // History still arms the authority deadline even though it no longer builds Home.
          await expect(opened.select({ kind: 'history' })).resolves.toMatchObject({ items: [] });
        } else {
          await expect(opened.select({ kind: 'overview' })).resolves.toMatchObject({
            standings: [],
          });
          await expect(opened.select({ kind: 'continue' })).resolves.toMatchObject({ items: [] });
        }
        await vi.advanceTimersByTimeAsync(4_999);
        expect(events).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(events).toEqual([{ kind: 'changed', affected: [{ kind: 'all' }] }]);
        // The next future stamp is scheduled without depending on a listener selecting a projection after the first.
        await vi.advanceTimersByTimeAsync(1_999);
        expect(events).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(events).toEqual([
          { kind: 'changed', affected: [{ kind: 'all' }] },
          { kind: 'changed', affected: [{ kind: 'all' }] },
        ]);
        await expect(opened.select({ kind: 'overview' })).resolves.toMatchObject({
          standings: [{ title: { type: 'tv', id: 1399 }, standing: 'in-progress' }],
        });
        await expect(opened.select({ kind: 'continue' })).resolves.toMatchObject({
          items: [
            {
              title: { type: 'tv', id: 1399 },
              fraction: 0.6,
              seconds: 901,
              updatedAt: future + 2_000,
            },
          ],
        });
        vi.setSystemTime(base);
        await expect(opened.select({ kind: 'overview' })).resolves.toMatchObject({ standings: [] });
        await expect(opened.select({ kind: 'continue' })).resolves.toMatchObject({ items: [] });
        await opened.close();

        events.length = 0;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(events).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('asks den-core about each document once whether History opens alone or after Home', async () => {
    await ensureSyncPolicy();
    const stamp = (at: number): [number, number, string] => [at, 0, 'aaaaaaaaaaaaaaaa'];
    const episode = (value: number, at: number) => ({
      progress: { value, at: stamp(at), viewing: 1 },
      imported: false,
      plays: { 0: at },
      cleared: null,
    });
    const vault = memoryVault();
    const seed = (await LibraryLog.openLocal(KEY, vault))!;
    expect(
      await seed.writeRows([
        ...[1, 2].map((season): DocumentRow => ({
          format: 4,
          kind: 'season',
          title: series,
          season,
          seasonReset: null,
          episodes: { 1: episode(1, 3_000 + season), 2: episode(0.4, 4_000 + season) },
        })),
        {
          format: 4,
          kind: 'title',
          title: movie,
          status: { value: 'watched', at: stamp(1_000) },
          addedAt: 900,
        },
        {
          format: 4,
          kind: 'title',
          title: series,
          status: { value: 'watchlist', at: stamp(2_000) },
          addedAt: 900,
        },
      ]),
    ).toBe(true);
    seed.close();

    const policy = vi.mocked(syncPolicy);
    const visit = async (kinds: Array<'overview' | 'continue' | 'history'>) => {
      // A newly opened log holds new document objects, so no projection carries over from another visit.
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'policy-count-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local');
      policy.mockClear();
      const values = [];
      for (const kind of kinds) values.push(await opened.select({ kind }));
      const calls: Record<string, number> = {};
      for (const [request] of policy.mock.calls) {
        const op = String(request.op);
        if (op === 'title_state' || op === 'season_state_v4') calls[op] = (calls[op] ?? 0) + 1;
      }
      await opened.close();
      return { values, calls };
    };

    const history = await visit(['history']);
    const home = await visit(['overview', 'continue']);
    const homeThenHistory = await visit(['overview', 'continue', 'history']);
    expect(history.calls).toEqual({ title_state: 2, season_state_v4: 2 });
    expect(home.calls).toEqual(history.calls);
    expect(homeThenHistory.calls).toEqual(history.calls);
    expect(homeThenHistory.values.slice(0, 2)).toEqual(home.values);
    expect(homeThenHistory.values[2]).toEqual(history.values[0]);
    expect(history.values[0]).toMatchObject({
      items: [
        {
          title: series,
          watchedAt: 3_002,
          episode: { season: 2, episode: 1 },
          episodes: 2,
          seen: [
            { season: 1, episode: 1 },
            { season: 2, episode: 1 },
          ],
        },
        { title: movie, watchedAt: 1_000, episodes: 0 },
      ],
    });
    expect(home.values[1]).toMatchObject({
      items: [{ title: series, fraction: 0.4, episode: { season: 2, episode: 2 } }],
    });
  });

  it('reschedules a future deadline learned when a deferred delivery changes the log', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const base = 1_789_000_000_000;
      const future = base + 86_400_000 + 5_000;
      vi.setSystemTime(base);
      const vault = memoryVault();
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'future-arrival-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local');
      const events: unknown[] = [];
      opened.listen((event) => events.push(event));
      expect(
        await log.writeRows([
          {
            format: 4,
            kind: 'season',
            title: { type: 'tv', id: 1400 },
            season: 1,
            seasonReset: null,
            episodes: {
              1: {
                progress: {
                  value: 0.5,
                  at: [future, 0, 'aaaaaaaaaaaaaaaa'],
                  viewing: 1,
                  seconds: 100,
                },
                imported: false,
                plays: {},
                cleared: null,
              },
            },
          },
        ]),
      ).toBe(true);
      // The deferred response lands after command() has returned. No selection follows it to discover the deadline.
      log.onDeferred!({ outcome: 'sent', changed: true });
      expect(events).toEqual([{ kind: 'changed', affected: [{ kind: 'all' }] }]);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual([
        { kind: 'changed', affected: [{ kind: 'all' }] },
        { kind: 'changed', affected: [{ kind: 'all' }] },
      ]);
      await opened.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep a second saved-view copy of a browser-local library', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const vault = memoryVault();
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'finished-view-invalidation-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local', undefined, undefined, {
        libraryKey: KEY,
        vault,
      });
      await cacheSelections(opened);
      await vi.advanceTimersByTimeAsync(250);
      await expect(cachedWatchlist(vault)).resolves.toBeNull();

      await opened.command({ kind: 'watchlist.add', title: movie }, 'add-seven');
      await opened.close();
      await expect(cachedWatchlist(vault)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a debounced finished view when its authority revision changes', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const vault = memoryVault();
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'finished-view-debounce-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local', undefined, undefined, {
        libraryKey: KEY,
        vault,
      });
      await cacheSelections(opened);
      await opened.command({ kind: 'watchlist.add', title: movie }, 'add-seven');
      await vi.advanceTimersByTimeAsync(250);
      await opened.close();
      await expect(cachedWatchlist(vault)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves browser-local saved views absent through an administrative merge', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const vault = memoryVault();
      const sourceKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));
      const sourceLog = (await LibraryLog.openLocal(sourceKey, vault))!;
      const sourceClock = await openClockStore(vault, {
        key: 'finished-view-merge-source-clock',
        createDevice: () => 'fedcba9876543210',
      });
      const source = authority(sourceLog, sourceClock, 'local');
      await source.command({ kind: 'watchlist.add', title: movie }, 'source-add-seven');
      await source.close();

      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'finished-view-merge-target-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local', undefined, undefined, {
        libraryKey: KEY,
        vault,
      });
      await cacheSelections(opened);
      await vi.advanceTimersByTimeAsync(250);
      await expect(cachedWatchlist(vault)).resolves.toBeNull();

      await expect(
        opened.task({ kind: 'local-library.merge', sourceLibraryKey: sourceKey }, 'merge-local'),
      ).resolves.toMatchObject({ result: { outcome: 'merged' } });
      await opened.close();
      await expect(cachedWatchlist(vault)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an accepted local edit before the handoff source query answers', async () => {
    await ensureSyncPolicy();
    const vault = memoryVault();
    const log = (await LibraryLog.openLocal(KEY, vault))!;
    const clock = await openClockStore(vault, {
      key: 'local-handoff-persistence-clock',
      createDevice: () => '0123456789abcdef',
    });
    const opened = authority(log, clock, 'local');
    await opened.command({ kind: 'watchlist.add', title: movie }, 'add-before-handoff');

    const put = vault.put;
    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => (releaseSnapshot = resolve));
    let snapshotStarted!: () => void;
    const snapshotWriting = new Promise<void>((resolve) => (snapshotStarted = resolve));
    vault.put = async (key, value) => {
      if (key.endsWith(':log.v1')) {
        snapshotStarted();
        await snapshotReleased;
      }
      await put(key, value);
    };
    let answered = false;
    const barrier = opened.query({ kind: 'preferences.raw' }).then((result) => {
      answered = true;
      return result;
    });
    await snapshotWriting;
    await Promise.resolve();
    expect(answered).toBe(false);

    releaseSnapshot();
    await expect(barrier).resolves.toMatchObject({ kind: 'preferences.raw' });
    const reopened = await LibraryLog.openExistingLocal(KEY, vault);
    expect(reopened?.title(movie)?.status.value).toBe('watchlist');
    reopened?.close();
    await opened.close();
  });

  it('does not write finished views for unchanged browser-local libraries', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const vault = memoryVault();
      const puts: string[] = [];
      const put = vault.put;
      vault.put = async (key, value) => {
        if (key.includes(':finished-views.v1')) puts.push(key);
        return put(key, value);
      };
      const all = [
        'watchlist',
        'continue',
        'recommendations',
        'settings',
        'runtime',
        'devices',
      ] as const;
      const visit = async (edit: boolean) => {
        const log = (await LibraryLog.openLocal(KEY, vault))!;
        const clock = await openClockStore(vault, {
          key: 'finished-view-reopen-clock',
          createDevice: () => '0123456789abcdef',
        });
        const opened = authority(log, clock, 'local', undefined, undefined, {
          libraryKey: KEY,
          vault,
        });
        if (edit) {
          await opened.command({ kind: 'watchlist.add', title: movie }, 'add-seven');
          await opened.command({ kind: 'watchlist.add', title: series }, 'add-eleven');
        }
        await cacheSelections(opened);
        await vi.advanceTimersByTimeAsync(250);
        await opened.close();
        return readFinishedLibraryViews(KEY, vault, [...all]);
      };
      const first = await visit(true);
      expect(first).toBeNull();
      puts.length = 0;
      const second = await visit(false);
      expect({ puts, second }).toEqual({ puts: [], second: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn browser-local layouts into saved library views', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const vault = memoryVault();
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'finished-view-layouts-clock',
        createDevice: () => '0123456789abcdef',
      });
      const opened = authority(log, clock, 'local', undefined, undefined, {
        libraryKey: KEY,
        vault,
      });
      await opened.command(
        {
          kind: 'episode-watched.set',
          episode: { ...series, season: 1, episode: 1 },
          watched: true,
        },
        'watched-one',
      );
      await cacheSelections(opened);
      await vi.advanceTimersByTimeAsync(250);
      // Its series' layout is not known yet: a Continue kept now would be partial.
      await expect(cachedWatchlist(vault)).resolves.toBeNull();

      await opened.observe({
        kind: 'title-shape',
        title: series,
        seasons: [{ season: 1, episodes: 2 }],
        lastAired: { season: 1, episode: 2 },
      });
      await expect(opened.select({ kind: 'continue' })).resolves.toMatchObject({
        needsShapes: [],
      });
      await cacheSelections(opened);
      await vi.advanceTimersByTimeAsync(250);
      await expect(readFinishedLibraryViews(KEY, vault, ['continue'])).resolves.toBeNull();
      await opened.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist browser-local Continue layouts in either observation order', async () => {
    await ensureSyncPolicy();
    vi.useFakeTimers();
    try {
      const other = { type: 'tv' as const, id: 12 };
      const kept = async (order: (typeof series)[]) => {
        const vault = memoryVault();
        const log = (await LibraryLog.openLocal(KEY, vault))!;
        const clock = await openClockStore(vault, {
          key: 'finished-view-layout-order-clock',
          createDevice: () => '0123456789abcdef',
        });
        const opened = authority(log, clock, 'local', undefined, undefined, {
          libraryKey: KEY,
          vault,
        });
        for (const title of [series, other])
          await opened.command(
            {
              kind: 'episode-watched.set',
              episode: { ...title, season: 1, episode: 1 },
              watched: true,
            },
            `watched-${title.id}`,
          );
        for (const title of order)
          await opened.observe({
            kind: 'title-shape',
            title,
            seasons: [{ season: 1, episodes: 2 }],
            lastAired: { season: 1, episode: 2 },
          });
        await cacheSelections(opened);
        await vi.advanceTimersByTimeAsync(250);
        await opened.close();
        return JSON.stringify(
          (await readFinishedLibraryViews(KEY, vault, ['continue']))?.pieces.continue?.layouts,
        );
      };
      const forwards = await kept([series, other]);
      expect(forwards).toBeUndefined();
      expect(await kept([other, series])).toBe(forwards);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps fact-derived views under one identity through whole-log reads and edits', async () => {
    await ensureSyncPolicy();
    const vault = memoryVault(true);
    const server = await pinDeliveryServer();
    server.allowWrites();
    const all = [
      'watchlist',
      'continue',
      'recommendations',
      'settings',
      'runtime',
      'devices',
    ] as const;
    const open = async () => {
      const log = (await LibraryLog.open(KEY, server.fetchImpl, undefined, vault))!;
      const clock = await openClockStore(vault, {
        key: 'facts-views-clock',
        createDevice: () => '0123456789abcdef',
      });
      return Object.assign(
        authority(log, clock, 'online', undefined, undefined, { libraryKey: KEY, vault }),
        { log },
      );
    };
    const first = await open();
    await first.command({ kind: 'watchlist.add', title: movie }, 'add-seven');
    await vi.waitFor(() => expect(first.log.pendingActions).toBe(0));
    await first.close();
    // A visit that has read the write back from den-edge draws Home, and keeps its views at that head.
    const home = await open();
    await home.log.refresh();
    expect(home.log.logHead).toBeGreaterThan(0);
    await cacheSelections(home);
    const written = await vi.waitFor(async () => {
      const views = await readFinishedLibraryViews(KEY, vault, [...all]);
      expect(views?.identity.head).toBe(home.log.logHead);
      expect(views?.identity.authorityRevision.startsWith('facts:')).toBe(false);
      return views!;
    });
    await home.close();

    // The Watchlist reads the whole log for its history, and selects the overview but not Continue.
    const derivedWrites: string[] = [];
    const put = vault.put;
    vault.put = async (key, value) => {
      if (key.includes('finished-views') || key.includes(LIBRARY_LOCAL_AUTHORITY))
        derivedWrites.push(key);
      return put(key, value);
    };
    const watchlist = await open();
    await watchlist.select({ kind: 'overview' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await watchlist.close();
    await expect(readFinishedLibraryViews(KEY, vault, [...all])).resolves.toMatchObject({
      identity: { authorityRevision: written.identity.authorityRevision },
    });
    expect(derivedWrites).toEqual([]);

    const edits = await open();
    await edits.select({ kind: 'overview' });
    await edits.command({ kind: 'watchlist.add', title: series }, 'add-eleven');
    await vi.waitFor(() => expect(edits.log.pendingActions).toBe(0));
    await edits.close();
    const after = await open();
    await after.log.refresh();
    await cacheSelections(after);
    await after.close();
    await expect(readFinishedLibraryViews(KEY, vault, ['watchlist'])).resolves.toMatchObject({
      pieces: { watchlist: { titles: expect.arrayContaining([series]) } },
    });
  });

  it('keeps a projected PIN non-authoritative across reload until its exact row syncs', async () => {
    await ensureSyncPolicy();
    const vault = memoryVault();
    const server = await pinDeliveryServer();
    const firstLog = (await LibraryLog.open(KEY, server.fetchImpl, undefined, vault))!;
    const firstClock = await openClockStore(vault, {
      key: 'queued-pin-clock',
      createDevice: () => '0123456789abcdef',
    });
    const first = authority(firstLog, firstClock, 'online');

    await expect(
      first.command({ kind: 'parental-pin.set', pin: '1234' }, 'first'),
    ).resolves.toMatchObject({
      outcome: 'applied',
      delivery: 'queued',
    });
    await expect(first.select({ kind: 'connections' })).resolves.toMatchObject({
      parentalPinConfigured: true,
      parentalPinDelivery: 'queued',
    });
    await expect(first.query({ kind: 'parental-pin.verify', pin: '1234' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: false,
    });
    firstLog.close();

    const reopenedLog = (await LibraryLog.open(KEY, server.fetchImpl, undefined, vault))!;
    const reopenedClock = await openClockStore(vault, {
      key: 'queued-pin-clock',
      createDevice: () => '0123456789abcdef',
    });
    const reopened = authority(reopenedLog, reopenedClock, 'online');
    await expect(reopened.select({ kind: 'connections' })).resolves.toMatchObject({
      parentalPinConfigured: true,
      parentalPinDelivery: 'queued',
    });
    await expect(
      reopened.command({ kind: 'parental-pin.set', pin: '1234' }, 'retry-offline'),
    ).resolves.toMatchObject({ outcome: 'unchanged', delivery: 'queued' });
    await expect(reopened.query({ kind: 'parental-pin.verify', pin: '1234' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: false,
    });
    await expect(
      reopened.command({ kind: 'parental-pin.set', pin: '4321' }, 'replace-offline'),
    ).resolves.toMatchObject({ outcome: 'applied', delivery: 'queued' });
    await expect(reopened.query({ kind: 'parental-pin.verify', pin: '4321' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: false,
    });

    server.allowWrites();
    await expect(
      reopened.command({ kind: 'parental-pin.set', pin: '4321' }, 'retry-online'),
    ).resolves.toMatchObject({ outcome: 'unchanged', delivery: 'synced' });
    await expect(reopened.select({ kind: 'connections' })).resolves.toMatchObject({
      parentalPinConfigured: true,
      parentalPinDelivery: 'synced',
    });
    await expect(reopened.query({ kind: 'parental-pin.verify', pin: '1234' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: false,
    });
    await expect(reopened.query({ kind: 'parental-pin.verify', pin: '4321' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: true,
    });
    reopenedLog.close();
  });

  it('changes a Kid’s policy in the directory only behind the Owner PIN', async () => {
    await ensureSyncPolicy();
    const vault = memoryVault();
    const server = await pinDeliveryServer();
    server.allowWrites();
    const log = (await LibraryLog.open(KEY, server.fetchImpl, undefined, vault))!;
    const clock = await openClockStore(vault, {
      key: 'policy-pin-clock',
      createDevice: () => '0123456789abcdef',
    });
    const owned = authority(log, clock, 'online');
    await owned.command({ kind: 'parental-pin.set', pin: '1234' }, 'set-pin');
    await expect(
      owned.command({ kind: 'parental-pin.set', pin: '1234' }, 'confirm-pin'),
    ).resolves.toMatchObject({ delivery: 'synced' });

    // An Owner and a Kid at 12 and under, read fresh from "den-edge" on every attempt.
    const ownerEntry = Object.values(
      (structuredClone(profileFixture.migrationBase) as unknown as ProfileDirectoryDocument)
        .profiles,
    )[0]!;
    const kid = 'b'.repeat(32);
    const entry = structuredClone(ownerEntry) as unknown as {
      library: { value: unknown };
      policy: { value: unknown };
    } & Record<string, unknown>;
    Object.assign(entry, { id: kid, role: 'kid' });
    entry.library.value = {
      keyVersion: 1,
      key: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    };
    entry.policy.value = { maximumAge: 12, unknownRatings: 'block' };
    let directory = profilesApplyCreate({
      document: structuredClone(
        profileFixture.migrationBase,
      ) as unknown as ProfileDirectoryDocument,
      profile: kid,
      entry,
    });
    const read = vi
      .spyOn(log, 'readKidProfileDirectory')
      .mockImplementation(async () => ({ directory, authority: { base: 1, generation: 'g' } }));
    const write = vi
      .spyOn(log, 'casKidProfileDirectory')
      .mockImplementation(async (_authority, next) => {
        directory = next;
        return 'committed';
      });
    const policy = (pin: string) =>
      owned.task(
        { kind: 'profile.policy.set', profile: kid, maximumAge: 8, unknownRatings: 'block', pin },
        `policy-${pin}`,
      );

    await expect(policy('0000')).rejects.toMatchObject({ failure: { code: 'unauthorized' } });
    expect(write).not.toHaveBeenCalled();
    expect(directory.profiles[kid]!.policy.value.maximumAge).toBe(12);

    await expect(policy('1234')).resolves.toMatchObject({
      result: { kind: 'profile.policy.set', outcome: 'changed' },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(directory.profiles[kid]!.policy.value).toEqual({
      maximumAge: 8,
      unknownRatings: 'block',
    });
    // The same policy again writes nothing.
    await expect(policy('1234')).resolves.toMatchObject({
      result: { kind: 'profile.policy.set', outcome: 'unchanged' },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalled();
    log.close();
  });

  it('allows and tombstones one Kid title only behind the Owner PIN', async () => {
    await ensureSyncPolicy();
    const vault = memoryVault();
    const server = await pinDeliveryServer();
    server.allowWrites();
    const log = (await LibraryLog.open(KEY, server.fetchImpl, undefined, vault))!;
    const clock = await openClockStore(vault, {
      key: 'approval-pin-clock',
      createDevice: () => '0123456789abcdef',
    });
    const owned = authority(log, clock, 'online');
    await owned.command({ kind: 'parental-pin.set', pin: '1234' }, 'set-pin');
    await owned.command({ kind: 'parental-pin.set', pin: '1234' }, 'confirm-pin');

    const ownerDirectory = structuredClone(
      profileFixture.migrationBase,
    ) as unknown as ProfileDirectoryDocument;
    const owner = Object.values(ownerDirectory.profiles)[0]!;
    const kid = 'b'.repeat(32);
    const entry = structuredClone(owner) as unknown as {
      library: { value: unknown };
      policy: { value: unknown };
    } & Record<string, unknown>;
    Object.assign(entry, { id: kid, role: 'kid' });
    entry.library.value = {
      keyVersion: 1,
      key: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    };
    entry.policy.value = { maximumAge: 8, unknownRatings: 'block' };
    const directory = profilesApplyCreate({ document: ownerDirectory, profile: kid, entry });
    let document: KidTitleApprovalsDocument | null = null;
    vi.spyOn(log, 'readKidTitleApprovals').mockImplementation(async () => ({
      directory,
      document,
      base: document ? 2 : 0,
      generation: 'g',
    }));
    const write = vi.spyOn(log, 'casKidTitleApprovals').mockImplementation(async (_a, next) => {
      document = validateKidTitleApprovals(next, directory);
      return 'committed';
    });
    const set = (allow: boolean, pin: string) =>
      owned.task({ kind: 'kid-title-approval.set', profile: kid, title: movie, allow, pin }, 'set');

    await expect(set(true, '0000')).rejects.toMatchObject({
      failure: { code: 'unauthorized' },
    });
    expect(write).not.toHaveBeenCalled();
    await expect(set(true, '1234')).resolves.toMatchObject({
      result: { kind: 'kid-title-approval.set', outcome: 'changed' },
    });
    expect(document!.approvals['movie:7']!.value).toBe('allow');
    await expect(set(false, '1234')).resolves.toMatchObject({
      result: { kind: 'kid-title-approval.set', outcome: 'changed' },
    });
    expect(document!.approvals['movie:7']!.value).toBe('tombstone');
    log.close();
  });

  it('keeps the compound key reset behind its source route and a fresh Owner PIN', async () => {
    let enrolled = false;
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (!url.endsWith('/exclusive-operation/source'))
          throw new Error(`unexpected request ${url}`);
        if (!enrolled) return new Response('{"error":"not_found"}', { status: 404 });
        return new Response(JSON.stringify({ source: { generation: 1, head: 'a'.repeat(64) } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    try {
      const vault = memoryVault();
      const log = (await LibraryLog.openLocal(KEY, vault))!;
      const clock = await openClockStore(vault, {
        key: 'key-reset-clock',
        createDevice: () => '0123456789abcdef',
      });
      const reset = authority(log, clock, 'local', undefined, undefined, {
        libraryKey: KEY,
        vault,
      });
      const destination = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));
      const tasks = [
        { kind: 'profile-key-reset.start', pin: '1234', destinationLibraryKey: destination },
        { kind: 'profile-key-reset.resume' },
        {
          kind: 'profile-key-reset.recover',
          pin: '1234',
          recoveryAttempt: 'fedcba9876543210fedcba9876543210',
          successorKey: null,
        },
      ] as const;

      // Profile reset off: every entry is unavailable, and the only request is the source read.
      for (const task of tasks)
        await expect(reset.task(task, `off-${task.kind}`)).resolves.toMatchObject({
          result: { kind: task.kind, outcome: 'unavailable' },
        });
      expect(requests.every((request) => request.endsWith('/exclusive-operation/source'))).toBe(
        true,
      );

      // Confirming asks nothing of den-edge and nothing of the gate: with no journal there is nothing to confirm.
      const confirm = {
        kind: 'profile-key-reset.confirm',
        destinationLibraryKey: destination,
      } as const;
      await expect(reset.task(confirm, 'confirm-off')).resolves.toMatchObject({
        result: { kind: 'profile-key-reset.confirm', outcome: 'none' },
      });

      enrolled = true;
      await expect(reset.task(tasks[1], 'resume')).resolves.toMatchObject({
        result: { kind: 'profile-key-reset.resume', outcome: 'none' },
      });
      await expect(reset.task(confirm, 'confirm-on')).resolves.toMatchObject({
        result: { kind: 'profile-key-reset.confirm', outcome: 'none' },
      });
      // No Owner PIN is delivered to this household: start and recover are refused before any other request.
      for (const task of [tasks[0], tasks[2]])
        await expect(reset.task(task, `pin-${task.kind}`)).rejects.toEqual(
          expect.objectContaining<Partial<LibraryServiceAuthorityError>>({
            failure: expect.objectContaining({ code: 'unauthorized' }),
          }),
        );
      await expect(
        reset.task(
          { kind: 'profile-key-reset.start', pin: '1234', destinationLibraryKey: KEY },
          'same-key',
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LibraryServiceAuthorityError>>({
          failure: expect.objectContaining({ code: 'invalid-request' }),
        }),
      );
      expect(requests.every((request) => request.endsWith('/exclusive-operation/source'))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('replaces but never removes the parental PIN while a restricted profile is live', async () => {
    const { log, authority } = await localAuthority();
    await authority.command({ kind: 'parental-pin.set', pin: '1234' }, 'set');
    const directory = (kidDeleted: boolean) =>
      ({
        owner: 'owner',
        profiles: {
          owner: { role: 'owner', deleted: { value: false } },
          kid: { role: 'kid', deleted: { value: kidDeleted } },
        },
      }) as never;
    const spy = vi.spyOn(log, 'profileDirectory').mockReturnValue(directory(false));

    await expect(
      authority.command({ kind: 'parental-pin.set', pin: null }, 'clear'),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });
    await expect(
      authority.command({ kind: 'parental-pin.set', pin: '4321' }, 'replace'),
    ).resolves.toMatchObject({ outcome: 'applied' });

    spy.mockReturnValue(directory(true));
    await expect(
      authority.command({ kind: 'parental-pin.set', pin: null }, 'clear-after-delete'),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  it('owns minimal runtime discovery and the named retained Home values', async () => {
    const { log, authority } = await localAuthority();
    await expect(authority.select({ kind: 'profiles' })).resolves.toEqual({
      kind: 'profiles',
      state: 'absent',
      owner: null,
      profiles: [],
    });
    // A profiles row that failed validation, or a wire minimum only a committed split reaches, is never "absent".
    const topology = vi.spyOn(log, 'profileTopologyPresent', 'get').mockReturnValue(true);
    await expect(authority.select({ kind: 'profiles' })).resolves.toMatchObject({
      state: 'invalid',
    });
    topology.mockReturnValue(false);
    const minimum = vi.spyOn(log, 'wireMinimum', 'get').mockReturnValue(5);
    await expect(authority.select({ kind: 'profiles' })).resolves.toMatchObject({
      state: 'invalid',
    });
    minimum.mockReturnValue(4);
    await expect(authority.select({ kind: 'profiles' })).resolves.toMatchObject({
      state: 'absent',
    });
    topology.mockRestore();
    minimum.mockRestore();
    await expect(authority.select({ kind: 'runtime' })).resolves.toMatchObject({
      kind: 'runtime',
      pluginManifestUrls: [],
      privateRemuxUrl: null,
    });

    await expect(
      authority.command({ kind: 'api-key.set', service: 'tmdb', value: 'tmdb-secret' }, 'tmdb'),
    ).resolves.toMatchObject({
      affected: [{ kind: 'connections' }],
    });
    await authority.command(
      { kind: 'plugin.install', manifestUrl: 'https://plugins.example/scout/manifest.json' },
      'plugin',
    );
    await authority.command(
      { kind: 'discovery.remux.remember', url: 'https://remux.tailnet.ts.net/' },
      'remux',
    );
    const runtime = await authority.select({ kind: 'runtime' });
    expect(runtime).toEqual({
      kind: 'runtime',
      pluginManifestUrls: ['https://plugins.example/scout/manifest.json'],
      privateRemuxUrl: 'https://remux.tailnet.ts.net',
    });
    expect(JSON.stringify(runtime)).not.toContain('omdb');

    await log.keep('services.v1', { arbitrary: 'old-or-corrupt' });
    await expect(authority.query({ kind: 'retained.services.get' })).resolves.toEqual({
      kind: 'retained.services',
      value: null,
    });
    const services = {
      routes: { remux: [{ url: 'https://remux.example' }] },
      scout: { install: 'https://plugins.example/scout', base: '/scout' },
      atlas: '/atlas',
      reel: '/reel',
      remux: 'https://remux.example',
    };
    await expect(
      authority.command({ kind: 'retained.services.set', value: services }, 'services'),
    ).resolves.toEqual({ outcome: 'applied', delivery: 'local', affected: [] });
    await expect(authority.query({ kind: 'retained.services.get' })).resolves.toEqual({
      kind: 'retained.services',
      value: services,
    });

    await authority.command({ kind: 'retained.home-continue.set', present: true }, 'continue-hint');
    await expect(authority.query({ kind: 'retained.home-continue.get' })).resolves.toEqual({
      kind: 'retained.home-continue',
      present: true,
    });

    const scope = { kind: 'personal' as const, facet: null, fresh: false };
    const billboard = {
      kind: 'personal' as const,
      at: 1_800_000_000_000,
      titles: [{ type: 'movie' as const, id: 7, title: 'Seven', why: { reason: 'similar' } }],
    };
    await authority.command(
      { kind: 'retained.billboard.set', scope, value: billboard },
      'billboard',
    );
    await expect(log.kept('billboard.personal.v1.all')).resolves.toEqual({
      at: billboard.at,
      titles: billboard.titles,
    });
    await expect(authority.query({ kind: 'retained.billboard.get', scope })).resolves.toEqual({
      kind: 'retained.billboard',
      scope,
      value: billboard,
    });

    const sharedScope = { kind: 'shared' as const, facet: 'movie' as const, fresh: true };
    const sharedTitles = [{ type: 'movie' as const, id: 8, title: 'Eight' }];
    await log.keep('billboard.v4.fresh.movie', sharedTitles);
    await expect(
      authority.query({ kind: 'retained.billboard.get', scope: sharedScope }),
    ).resolves.toEqual({
      kind: 'retained.billboard',
      scope: sharedScope,
      value: { kind: 'shared', titles: sharedTitles },
    });
  });

  it('fetches a bounded library metadata batch with its private TMDB key and owns TV shapes', async () => {
    const vault = memoryVault();
    const log = (await LibraryLog.openLocal(KEY, vault))!;
    const clock = await openClockStore(vault, {
      key: 'metadata-authority-test-clock',
      createDevice: () => '0123456789abcdef',
    });
    const asked: string[] = [];
    const tmdbFetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      asked.push(url);
      return new Response(
        JSON.stringify(
          url.includes('/tv/')
            ? {
                id: 11,
                name: 'Eleven',
                first_air_date: '2020-01-02',
                seasons: [{ season_number: 1, episode_count: 8 }],
                last_episode_to_air: { season_number: 1, episode_number: 7 },
              }
            : { id: 7, title: 'Seven', release_date: '' },
        ),
        { status: 200 },
      );
    };
    const service = authority(log, clock, 'local', undefined, tmdbFetchImpl);
    await service.command({ kind: 'api-key.set', service: 'tmdb', value: 'worker-secret' }, 'key');
    const events: unknown[] = [];
    service.listen((event) => events.push(event));

    await expect(
      service.query({ kind: 'library.metadata', titles: [movie, series] }),
    ).resolves.toEqual({
      kind: 'library.metadata',
      titles: [
        { ...movie, title: 'Seven' },
        { ...series, title: 'Eleven', year: 2020, releaseDate: '2020-01-02' },
      ],
      shapes: [
        {
          title: series,
          seasons: [{ season: 1, episodes: 8 }],
          lastAired: { season: 1, episode: 7 },
        },
      ],
      retryable: [],
    });
    expect(asked).toHaveLength(2);
    expect(asked.every((url) => url.includes('api_key=worker-secret'))).toBe(true);
    expect(events).toEqual([
      {
        kind: 'changed',
        affected: [{ kind: 'title', title: series }, { kind: 'continue' }],
      },
    ]);

    events.length = 0;
    await service.query({ kind: 'library.metadata', titles: [series] });
    expect(events).toEqual([]);
  });

  it('joins overlapping metadata flights and reports transient provider failures for retry', async () => {
    const vault = memoryVault();
    const log = (await LibraryLog.openLocal(KEY, vault))!;
    const clock = await openClockStore(vault, {
      key: 'metadata-flight-test-clock',
      createDevice: () => '0123456789abcdef',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    const tmdbFetchImpl: typeof fetch = async (input) => {
      requests++;
      if (String(input).includes('/movie/8?')) return new Response('{}', { status: 503 });
      await gate;
      return new Response(JSON.stringify({ id: 7, title: 'Seven' }), { status: 200 });
    };
    const service = authority(log, clock, 'local', undefined, tmdbFetchImpl);

    const first = service.query({ kind: 'library.metadata', titles: [movie] });
    const overlapping = service.query({ kind: 'library.metadata', titles: [movie] });
    await vi.waitFor(() => expect(requests).toBe(1));
    release();
    await expect(Promise.all([first, overlapping])).resolves.toEqual([
      {
        kind: 'library.metadata',
        titles: [{ ...movie, title: 'Seven' }],
        shapes: [],
        retryable: [],
      },
      {
        kind: 'library.metadata',
        titles: [{ ...movie, title: 'Seven' }],
        shapes: [],
        retryable: [],
      },
    ]);

    const failed = { type: 'movie' as const, id: 8 };
    await expect(service.query({ kind: 'library.metadata', titles: [failed] })).resolves.toEqual({
      kind: 'library.metadata',
      titles: [],
      shapes: [],
      retryable: [failed],
      retryAfterMs: 60_000,
    });
  });

  it('owns SIMKL credentials and exposes only normalized connection state', async () => {
    const vault = memoryVault();
    const log = (await LibraryLog.openLocal(KEY, vault))!;
    const clock = await openClockStore(vault, {
      key: 'simkl-authority-test-clock',
      createDevice: () => '0123456789abcdef',
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === '/config')
        return new Response(JSON.stringify({ simklClientId: 'public-client' }));
      if (url.endsWith('/users/settings'))
        return new Response(JSON.stringify({ user: { id: 42 } }));
      return new Response('{}', { status: 404 });
    };
    const service = authority(log, clock, 'local', fetchImpl);

    await expect(service.select({ kind: 'simkl' })).resolves.toEqual({
      kind: 'simkl',
      connected: false,
      heldRemovals: [],
    });
    await expect(
      service.command({ kind: 'simkl.connect', token: 'private-token' }, 'connect'),
    ).resolves.toMatchObject({ outcome: 'applied', affected: [{ kind: 'simkl' }] });
    const view = await service.select({ kind: 'simkl' });
    expect(view).toEqual({
      kind: 'simkl',
      connected: true,
      account: '42',
      heldRemovals: [],
    });
    expect(JSON.stringify(view)).not.toContain('private-token');
    expect(JSON.stringify(log.settings('trackers'))).toContain('private-token');

    await expect(
      service.command({ kind: 'simkl.disconnect' }, 'disconnect'),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(service.select({ kind: 'simkl' })).resolves.toMatchObject({ connected: false });
  });

  it('owns title actions and returns only semantic title views', async () => {
    const { log, authority } = await localAuthority();

    await expect(authority.select({ kind: 'title', title: movie })).resolves.toEqual({
      kind: 'title',
      title: movie,
      listed: false,
      watched: false,
      reaction: null,
      standing: null,
      progress: null,
      episodes: [],
    });

    const added = await authority.command({ kind: 'watchlist.add', title: movie }, 'add-movie');
    expect(added).toEqual({
      outcome: 'applied',
      delivery: 'local',
      affected: [
        { kind: 'title', title: movie },
        { kind: 'presence', title: movie },
        { kind: 'overview' },
        { kind: 'history' },
        { kind: 'continue' },
      ],
    });
    expect(log.settings('tracker-event:add-movie')).toBeUndefined();
    await expect(
      authority.command({ kind: 'watchlist.add', title: movie }, 'add-again'),
    ).resolves.toMatchObject({ outcome: 'unchanged', affected: [] });

    await expect(
      authority.command({ kind: 'reaction.set', title: movie, reaction: 'love' }, 'love-movie'),
    ).resolves.toMatchObject({
      affected: [
        { kind: 'title', title: movie },
        { kind: 'presence', title: movie },
        { kind: 'overview' },
      ],
    });
    const progress = await authority.command(
      {
        kind: 'progress.record',
        title: movie,
        fraction: 0.4,
        seconds: 240,
        observedAt: 5_000,
      },
      'progress-is-not-a-tracker-event',
    );
    expect(progress.delivery).toBe('local');
    await expect(
      authority.command(
        { kind: 'continue-dismissed.set', title: movie, dismissed: true },
        'dismissal-is-not-a-tracker-event',
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      affected: [{ kind: 'continue' }],
    });
    await expect(authority.query({ kind: 'playback.prepare', title: movie })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'resume',
      target: movie,
      resume: { fraction: 0.4, seconds: 240 },
    });
    await expect(authority.select({ kind: 'title', title: movie })).resolves.toMatchObject({
      listed: true,
      reaction: 'love',
      standing: 'in-progress',
      progress: { fraction: 0.4, seconds: 240 },
    });
  });

  it('saves a reaction on a series that is not in the library yet', async () => {
    const { authority } = await localAuthority();

    await expect(
      authority.command({ kind: 'reaction.set', title: series, reaction: 'love' }, 'love-series'),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
      reaction: 'love',
    });
  });

  it('uses observed series shape for episode commands, whole-series writes and playback', async () => {
    const { log, authority } = await localAuthority();

    await expect(
      authority.command({ kind: 'watched.set', title: series, watched: true }, 'series-seen'),
    ).rejects.toMatchObject({
      failure: { code: 'not-ready', retryable: true },
    });
    await expect(
      authority.observe({
        kind: 'title-shape',
        title: series,
        seasons: [
          { season: 0, episodes: 2 },
          { season: 1, episodes: 3 },
        ],
        lastAired: { season: 1, episode: 2 },
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      affected: [{ kind: 'title', title: series }, { kind: 'continue' }],
    });

    await authority.command(
      {
        kind: 'progress.record',
        title: series,
        episode: { ...series, season: 1, episode: 1 },
        fraction: 0.3,
        seconds: 300,
        observedAt: 6_000,
      },
      'series-progress',
    );
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'resume',
      target: { ...series, season: 1, episode: 1 },
      resume: { fraction: 0.3, seconds: 300 },
    });

    await authority.command(
      {
        kind: 'episode-watched.set',
        episode: { ...series, season: 1, episode: 1 },
        watched: true,
      },
      'episode-one-seen',
    );
    expect(log.settings('tracker-event:episode-one-seen')).toBeUndefined();
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'next',
      target: { ...series, season: 1, episode: 2 },
      resume: null,
    });

    await authority.command(
      {
        kind: 'season-watched.set',
        title: series,
        season: 1,
        episodes: [1, 2],
        watched: true,
      },
      'season-seen',
    );
    expect(log.settings('tracker-event:season-seen:episode:1:1')).toBeUndefined();
    expect(log.settings('tracker-event:season-seen:episode:1:2')).toBeUndefined();
    await expect(authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
      listed: true,
      watched: true,
      standing: 'in-progress',
      episodes: [
        { season: 1, episode: 1, watched: true },
        { season: 1, episode: 2, watched: true },
      ],
    });
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'start',
      target: { ...series, season: 1, episode: 1 },
      resume: null,
    });

    await authority.command(
      { kind: 'watched.set', title: series, watched: false },
      'series-unseen',
    );
    expect(log.settings('tracker-event:series-unseen')).toBeUndefined();
    await expect(authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
      watched: false,
      episodes: [
        { season: 1, episode: 1, watched: false, fraction: 0 },
        { season: 1, episode: 2, watched: false, fraction: 0 },
      ],
    });
  });

  it('preserves queued and refused outcomes from an online log', async () => {
    await ensureSyncPolicy();
    const clock = {
      device: '0123456789abcdef',
      issue: async () => [2_000, 0, '0123456789abcdef'] as [number, number, string],
      historical: async (times: readonly number[]) =>
        times.map((at, index) => [at, index + 1, '0123456789abcdef'] as [number, number, string]),
      see: async () => undefined,
      current: async () => [2_000, 0, '0123456789abcdef'] as [number, number, string],
    };
    let pending = 0;
    const queuedLog = {
      currentGeneration: 'generation-1',
      moved: false,
      readOnly: false,
      refusal: null,
      get pendingActions() {
        return pending;
      },
      get queuedActions() {
        return pending;
      },
      title: () => undefined,
      newestStamp: () => [0, 0, ''] as [number, number, string],
      writeAction: async () => {
        pending++;
        return blankTitle(movie, 1);
      },
    } as unknown as LibraryLog;
    const queued = authority(queuedLog, clock, 'online');
    await expect(
      queued.command({ kind: 'watchlist.add', title: movie }, 'queued'),
    ).resolves.toMatchObject({ outcome: 'applied', delivery: 'queued' });

    const refusedLog = {
      ...queuedLog,
      refusal: 'library_full',
      get pendingActions() {
        return 0;
      },
      writeAction: async () => null,
    } as unknown as LibraryLog;
    const refused = authority(refusedLog, clock, 'online');
    await expect(
      refused.command({ kind: 'watchlist.add', title: movie }, 'refused'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LibraryServiceAuthorityError>>({
        failure: {
          code: 'refused',
          message: 'library write was refused: library_full',
          retryable: false,
        },
      }),
    );
  });

  it('tells the page how an edit answered before it was sent came to end', async () => {
    const { log, authority } = await localAuthority();
    const events: unknown[] = [];
    authority.listen((event) => events.push(event));
    const deferred = log.onDeferred!;

    deferred({ outcome: 'sent', changed: false });
    expect(events.splice(0)).toEqual([{ kind: 'changed', affected: [{ kind: 'connections' }] }]);

    deferred({ outcome: 'sent', changed: true });
    expect(events.splice(0)).toEqual([{ kind: 'changed', affected: [{ kind: 'all' }] }]);

    // Refused for good, it was taken back out: every view reads again, and the page says it was not kept.
    deferred({ outcome: 'refused', changed: true });
    expect(events.splice(0)).toEqual([
      { kind: 'changed', affected: [{ kind: 'all' }] },
      {
        kind: 'status',
        status: { kind: 'read-only', reason: 'Couldn’t save your last change. It was not kept.' },
      },
    ]);

    deferred({ outcome: 'kept', changed: false });
    expect(events.splice(0)).toEqual([
      { kind: 'changed', affected: [{ kind: 'connections' }] },
      {
        kind: 'status',
        status: {
          kind: 'read-only',
          reason:
            'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.',
        },
      },
    ]);

    // Kept because an exclusive profile migration holds the household: say so, rather than "offline".
    log.noteMigrationLocked();
    deferred({ outcome: 'kept', changed: false });
    expect(events.splice(0)).toEqual([
      { kind: 'changed', affected: [{ kind: 'connections' }] },
      {
        kind: 'status',
        status: {
          kind: 'read-only',
          reason:
            'Profile setup is in progress on another device. Your change is saved on this device and will sync when it finishes.',
        },
      },
    ]);

    authority.close();
    expect(log.onDeferred).toBeNull();
  });

  it('projects normalized overview, presence, Continue, and history views', async () => {
    const { authority } = await localAuthority();

    await authority.command({ kind: 'watchlist.add', title: movie }, 'overview-movie');
    await authority.command(
      { kind: 'reaction.set', title: movie, reaction: 'love' },
      'overview-love',
    );
    await authority.command(
      {
        kind: 'episode-watched.set',
        episode: { ...series, season: 1, episode: 1 },
        watched: true,
      },
      'history-episode',
    );

    await expect(authority.select({ kind: 'overview' })).resolves.toMatchObject({
      kind: 'overview',
      owned: [movie],
      watchlist: [movie],
      standings: expect.arrayContaining([
        { title: movie, standing: 'watchlist' },
        { title: series, standing: 'in-progress' },
      ]),
      weighted: [{ title: movie, weight: 1.6, updatedAt: expect.any(Number) }],
      seeds: { watched: [movie], watchlisted: [movie] },
    });
    await expect(authority.select({ kind: 'presence', titles: [series, movie] })).resolves.toEqual({
      kind: 'presence',
      items: [
        { title: series, standing: 'in-progress', reaction: null },
        { title: movie, standing: 'watchlist', reaction: 'love' },
      ],
    });
    await expect(authority.select({ kind: 'continue' })).resolves.toEqual({
      kind: 'continue',
      items: [],
      needsShapes: [series],
    });
    await expect(authority.select({ kind: 'history' })).resolves.toMatchObject({
      kind: 'history',
      items: [
        {
          title: series,
          watchedAt: expect.any(Number),
          episode: { season: 1, episode: 1 },
          episodes: 1,
        },
      ],
    });

    await authority.observe({
      kind: 'title-shape',
      title: series,
      seasons: [{ season: 1, episodes: 2 }],
      lastAired: { season: 1, episode: 2 },
    });
    await expect(authority.select({ kind: 'continue' })).resolves.toEqual({
      kind: 'continue',
      items: [
        {
          title: series,
          fraction: 0,
          episode: { season: 1, episode: 2 },
        },
      ],
      needsShapes: [],
    });
  });

  it('projects an in-progress movie as a protocol-only title reference', async () => {
    const { authority } = await localAuthority();
    await authority.command(
      {
        kind: 'progress.record',
        title: movie,
        fraction: 0.4,
        seconds: 240,
        observedAt: 5_000,
      },
      'movie-progress',
    );

    const value = await authority.select({ kind: 'continue' });
    expect(value).toEqual({
      kind: 'continue',
      items: [
        {
          title: movie,
          deviceId: '0123456789abcdef',
          fraction: 0.4,
          seconds: 240,
          updatedAt: expect.any(Number),
        },
      ],
      needsShapes: [],
    });
    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'continue',
        version: { instance: 'test', generation: null, revision: 0 },
        value,
      }).ok,
    ).toBe(true);
  });

  it('owns every synced preference with semantic default and explicit-empty patches', async () => {
    const { log, authority } = await localAuthority();

    await expect(authority.select({ kind: 'settings' })).resolves.toEqual({
      kind: 'settings',
      preferences: {
        excludedGenres: [],
        excludedLanguages: [],
        hideAnime: false,
        hideWatched: false,
        minReleaseYear: undefined,
        audioLanguage: undefined,
        subtitleLanguage: undefined,
        shownSubtitleLanguages: [],
        subtitlesPerLanguage: 3,
        autoSkipSegments: false,
        autoplayTrailers: true,
        ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
        shownWarnings: [],
        watchRegion: undefined,
        services: [],
        servicesConfigured: false,
        maturityCeiling: undefined,
      },
      assistant: { write: false, read: false },
    });

    await expect(
      authority.command(
        {
          kind: 'preferences.patch',
          patch: {
            excludedGenres: [878, 27],
            excludedLanguages: ['sv', 'fi'],
            hideAnime: true,
            hideWatched: true,
            minReleaseYear: 2000,
            audioLanguage: 'fi',
            subtitleLanguage: 'sv',
            shownSubtitleLanguages: ['sv', 'en'],
            subtitlesPerLanguage: 0,
            autoSkipSegments: true,
            autoplayTrailers: false,
            ratingSources: { kind: 'values', values: [] },
            shownWarnings: ['Spoiler', 'Abuse'],
            watchRegion: 'FI',
            services: {
              kind: 'values',
              values: [
                { id: 119, country: 'FI' },
                { id: 8, country: 'FI' },
              ],
            },
            maturityCeiling: 'r',
          },
        },
        'preferences-all',
      ),
    ).resolves.toEqual({
      outcome: 'applied',
      delivery: 'local',
      affected: [{ kind: 'settings' }],
    });

    const row = log.settings('prefs')!;
    expect(row.values['den.excludedGenreIDs']?.value).toEqual({ ints: [27, 878] });
    expect(row.values['den.myServicePicks']?.value).toEqual({ strings: ['8@FI', '119@FI'] });
    expect(new Set(Object.values(row.values).map(({ at }) => JSON.stringify(at))).size).toBe(1);
    expect(
      log
        .rows()
        .filter((held) => held.kind === 'set')
        .map((held) => held.name),
    ).toEqual(['prefs']);
    await expect(authority.select({ kind: 'settings' })).resolves.toMatchObject({
      preferences: {
        excludedGenres: [27, 878],
        excludedLanguages: ['fi', 'sv'],
        hideAnime: true,
        hideWatched: true,
        minReleaseYear: 2000,
        audioLanguage: 'fi',
        subtitleLanguage: 'sv',
        shownSubtitleLanguages: ['en', 'sv'],
        subtitlesPerLanguage: 0,
        autoSkipSegments: true,
        autoplayTrailers: false,
        ratingSources: [],
        shownWarnings: ['Abuse', 'Spoiler'],
        watchRegion: 'FI',
        services: [
          { id: 8, country: 'FI' },
          { id: 119, country: 'FI' },
        ],
        servicesConfigured: true,
        maturityCeiling: 'r',
      },
    });

    await expect(
      authority.command(
        {
          kind: 'preferences.patch',
          patch: {
            audioLanguage: null,
            minReleaseYear: null,
            ratingSources: { kind: 'default' },
            services: { kind: 'default' },
            watchRegion: null,
            maturityCeiling: null,
          },
        },
        'preferences-defaults',
      ),
    ).resolves.toMatchObject({ affected: [{ kind: 'settings' }] });
    await expect(authority.select({ kind: 'settings' })).resolves.toMatchObject({
      preferences: {
        audioLanguage: undefined,
        minReleaseYear: undefined,
        ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
        watchRegion: undefined,
        services: [],
        servicesConfigured: false,
        maturityCeiling: undefined,
      },
    });
    await expect(
      authority.command(
        {
          kind: 'preferences.patch',
          patch: {
            ratingSources: { kind: 'default' },
            services: { kind: 'default' },
          },
        },
        'preferences-noop',
      ),
    ).resolves.toEqual({
      outcome: 'unchanged',
      delivery: 'local',
      affected: [],
    });
  });

  it('gives a profile library the household preferences it has not decided, with their stamps, once', async () => {
    const { log, authority } = await localAuthority();
    const stamp = [1_000, 0, 'a1b2c3d4e5f60718'] as [number, number, string];
    const household = {
      'den.watchRegion': { value: { string: 'SE' }, at: stamp },
      'den.myServicePicks': { value: { strings: ['337@SE'] }, at: stamp },
    };
    await authority.command(
      { kind: 'preferences.patch', patch: { watchRegion: 'FI' } },
      'region-1',
    );
    await authority.command(
      { kind: 'preferences.patch', patch: { watchRegion: null } },
      'region-2',
    );
    await expect(authority.query({ kind: 'preferences.raw' })).resolves.toMatchObject({
      kind: 'preferences.raw',
    });
    await expect(
      authority.command({ kind: 'preferences.seed', household }, 'seed-1'),
    ).resolves.toMatchObject({ outcome: 'applied', affected: [{ kind: 'settings' }] });
    const values = log.settings('prefs')!.values;
    expect(values['den.myServicePicks']).toEqual(household['den.myServicePicks']);
    // The region was cleared in the profile before: a decision, so the household's is not given over it.
    expect(values['den.watchRegion']?.value).toBeNull();
    await expect(
      authority.command({ kind: 'preferences.seed', household }, 'seed-2'),
    ).resolves.toMatchObject({ outcome: 'unchanged' });
  });

  it('owns normalized connections and semantic settings commands without exposing rows', async () => {
    const { log, authority } = await localAuthority();
    const manifestUrl = 'https://addon.example/manifest.json';
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const tv = 'fedcba9876543210';
    const at = [1_000, 0, tv] as [number, number, string];
    await log.write({
      kind: 'set',
      schema: 2,
      name: 'devices',
      values: {
        [`${tv}.name`]: { value: { string: 'Apple TV' }, at },
        [`${tv}.kind`]: { value: { string: 'tv' }, at },
        [`${tv}.seen`]: { value: { int: 900 }, at },
        [`${tv}.format`]: { value: { int: 3 }, at },
        [`${tv}.pending`]: { value: { strings: [manifestUrl] }, at },
      },
    });
    await log.write({
      kind: 'set',
      schema: 2,
      name: `handoff:simkl:${tv}`,
      values: { token: { value: { string: 'handoff-secret' }, at } },
    });

    for (const [command, operation] of [
      [{ kind: 'api-key.set', service: 'tmdb', value: 'tmdb-secret' }, 'tmdb'],
      [{ kind: 'api-key.set', service: 'content-warnings', value: 'warnings-secret' }, 'warnings'],
      [{ kind: 'parental-pin.set', pin: '1234' }, 'pin'],
      [
        {
          kind: 'remote-access.set',
          credentials: { clientId: 'access-id', clientSecret: 'access-secret' },
        },
        'access',
      ],
      [{ kind: 'plugin.install', manifestUrl }, 'plugin'],
      [{ kind: 'plugin-trust.set', manifestUrl, publicKey: `ed25519:${publicKey}` }, 'trust'],
      [
        {
          kind: 'server.patch',
          server: 'jellyfin',
          value: {
            url: 'http://jellyfin.local:8096',
            user: 'viewer',
            credential: 'server-secret',
          },
        },
        'server',
      ],
      [{ kind: 'device.heartbeat', name: 'MacBook' }, 'heartbeat'],
    ] as const) {
      const affectsRuntime = command.kind === 'plugin.install';
      const affectsDevices = command.kind === 'device.heartbeat';
      await expect(authority.command(command, operation)).resolves.toMatchObject({
        outcome: 'applied',
        delivery: 'local',
        affected: [
          ...(affectsDevices ? ([{ kind: 'devices' }] as const) : []),
          { kind: 'connections' },
          ...(affectsRuntime ? ([{ kind: 'runtime' }] as const) : []),
        ],
      });
    }

    const connections = await authority.select({ kind: 'connections' });
    expect(connections).toEqual({
      kind: 'connections',
      apiKeys: {
        tmdb: { configured: true, masked: '••••cret' },
        'content-warnings': { configured: true, masked: '••••cret' },
      },
      parentalPinConfigured: true,
      parentalPinDelivery: 'local',
      remoteAccessConfigured: true,
      plugins: [
        {
          manifestUrl,
          signingKey: publicKey,
          pendingApprovalOn: [{ id: tv, name: 'Apple TV' }],
        },
      ],
      servers: [{ kind: 'jellyfin', url: 'http://jellyfin.local:8096', user: 'viewer' }],
      devices: [
        {
          id: '0123456789abcdef',
          name: 'MacBook',
          kind: 'browser',
          lastSeenAt: expect.any(Number),
          libraryFormat: 3,
        },
        { id: tv, name: 'Apple TV', kind: 'tv', lastSeenAt: 900, libraryFormat: 3 },
      ],
      diagnostics: {
        libraryFormat: 4,
        pendingChanges: 0,
        selfDeviceId: '0123456789abcdef',
      },
    });
    expect(JSON.stringify(connections)).not.toContain('tmdb-secret');
    expect(JSON.stringify(connections)).not.toContain('warnings-secret');
    const serialized = JSON.stringify(await authority.select({ kind: 'connections' }));
    expect(serialized).not.toContain('server-secret');
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('parentalPIN');
    expect(serialized).not.toContain('"values"');
    await expect(authority.query({ kind: 'parental-pin.verify', pin: '1234' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: true,
    });
    await expect(authority.query({ kind: 'parental-pin.verify', pin: '4321' })).resolves.toEqual({
      kind: 'parental-pin.verify',
      matches: false,
    });
    await expect(
      authority.command({ kind: 'parental-pin.set', pin: '1234' }, 'same-pin'),
    ).resolves.toMatchObject({ outcome: 'unchanged', affected: [] });
    await expect(authority.query({ kind: 'relay.membership' })).resolves.toEqual({
      kind: 'relay.membership',
      capability: null,
    });

    await expect(
      authority.command({ kind: 'device.remove', deviceId: tv }, 'remove-tv'),
    ).resolves.toMatchObject({
      affected: [{ kind: 'devices' }, { kind: 'connections' }],
    });
    expect(log.settings(`handoff:simkl:${tv}`)?.values.token?.value).toBeNull();
    await expect(authority.select({ kind: 'connections' })).resolves.toMatchObject({
      devices: [{ id: '0123456789abcdef' }],
      plugins: [{ pendingApprovalOn: [] }],
    });
    await expect(
      authority.command({ kind: 'device.remove', deviceId: '0123456789abcdef' }, 'remove-self'),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });

    // A TV checks in with its household play key, and records a play sent from elsewhere starting on it.
    const playKey = 'A'.repeat(43);
    await authority.command(
      { kind: 'device.heartbeat', name: 'MacBook', deviceKind: 'tv', playKey },
      'tv-heartbeat',
    );
    expect(log.settings('devices')?.values['0123456789abcdef.play']?.value).toEqual({
      string: playKey,
    });
    await expect(authority.command({ kind: 'device.played' }, 'played')).resolves.toMatchObject({
      outcome: 'applied',
      affected: [{ kind: 'devices' }],
    });
    expect(log.settings('devices')?.values['0123456789abcdef.played']?.value).toEqual({
      int: expect.any(Number),
    });

    await authority.command(
      { kind: 'server.patch', server: 'jellyfin', value: null },
      'remove-server',
    );
    await authority.command({ kind: 'plugin.remove', manifestUrl }, 'remove-plugin');
    await expect(authority.select({ kind: 'connections' })).resolves.toMatchObject({
      servers: [],
      plugins: [],
    });
    expect(log.settings('keys')?.values.jellyfin?.value).toBeNull();
  });

  it('returns only the relay-scoped member capability from an online log', async () => {
    const capability = { libraryId: 'a'.repeat(32), memberToken: 'b'.repeat(64) };
    const onlineLog = {
      currentGeneration: 'generation-1',
      relayMembership: async () => capability,
    } as unknown as LibraryLog;
    const onlineClock = {
      device: '0123456789abcdef',
      issue: async () => [1, 0, '0123456789abcdef'],
      historical: async (times) => times.map((at, index) => [at, index + 1, '0123456789abcdef']),
      see: async () => undefined,
      current: async () => [1, 0, '0123456789abcdef'],
    } as ClockStore;
    const onlineAuthority = authority(onlineLog, onlineClock, 'online');

    const result = await onlineAuthority.query({ kind: 'relay.membership' });
    expect(result).toEqual({ kind: 'relay.membership', capability });
    expect(JSON.stringify(result)).not.toContain('libraryKey');
  });

  it('owns download enqueue, alternate, projection, and removal without exposing tickets', async () => {
    const { authority } = await localAuthority();
    await expect(authority.select({ kind: 'downloads' })).resolves.toEqual({
      kind: 'downloads',
      items: [],
    });

    const title = {
      target: movie,
      name: 'Seven',
      imdbId: 'tt0000007',
      posterPath: '/seven.jpg',
      originalLanguage: 'en',
    };
    const release = {
      identity: 'release-one',
      label: 'Release One',
      url: '/scout/p/secret-one',
      sizeBytes: 7_000,
      cached: true,
    };
    await expect(
      authority.command(
        { kind: 'download.enqueue', title, release, candidates: 2 },
        'download-enqueue',
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      affected: [{ kind: 'downloads' }],
    });
    await expect(authority.select({ kind: 'downloads' })).resolves.toMatchObject({
      kind: 'downloads',
      items: [
        {
          content: 'movie:7:-1:-1',
          queuedBy: { device: '0123456789abcdef', isSelf: true },
          title: movie,
          name: 'Seven',
          imdbId: 'tt0000007',
          posterPath: '/seven.jpg',
          queuedAt: expect.any(Number),
          release: {
            identity: 'release-one',
            label: 'Release One',
            sizeBytes: 7_000,
            cached: true,
          },
          status: { phase: 'downloading', stalled: false },
          tried: 1,
          candidates: 2,
          announced: false,
        },
      ],
    });
    const projected = await authority.select({ kind: 'downloads' });
    expect(JSON.stringify(projected)).not.toContain('secret-one');
    const alternatives = await authority.query({ kind: 'download.sources', title });
    expect(alternatives.kind).toBe('download.sources');
    if (alternatives.kind !== 'download.sources') throw new Error('wrong query result');
    expect(alternatives.sources?.[0]).toMatchObject({
      identity: 'release-one',
      filename: 'Release One',
      badges: [],
      languages: [],
      probed: false,
    });
    expect(JSON.stringify(alternatives)).not.toContain('/scout/');
    expect(JSON.stringify(alternatives)).not.toContain('attributes');

    await expect(
      authority.command(
        {
          kind: 'download.release.try',
          target: movie,
          identity: 'release-two',
        },
        'download-alternate',
      ),
    ).resolves.toMatchObject({ affected: [{ kind: 'downloads' }] });
    await expect(authority.select({ kind: 'downloads' })).resolves.toMatchObject({
      items: [{ alternate: { identity: 'release-two', label: 'Release Two' } }],
    });

    await expect(
      authority.command({ kind: 'download.remove', target: movie }, 'download-remove'),
    ).resolves.toMatchObject({ affected: [{ kind: 'downloads' }] });
    await expect(authority.select({ kind: 'downloads' })).resolves.toEqual({
      kind: 'downloads',
      items: [],
    });
  });

  it('bounds and sanitizes provider download data before it reaches the wire', async () => {
    const vault = memoryVault();
    const log = (await LibraryLog.openLocal(KEY, vault))!;
    const clock = await openClockStore(vault, {
      key: 'provider-boundary-test-clock',
      createDevice: () => '0123456789abcdef',
    });
    const malformed = {
      identity: 'malformed-release',
      filename: 'f'.repeat(5_000),
      label: 'l'.repeat(5_000),
      url: '/scout/p/malformed',
      size: Number.POSITIVE_INFINITY,
      cached: 'yes',
      seeders: 1.5,
      packSize: Number.MAX_SAFE_INTEGER + 1,
      badges: [...Array.from({ length: 40 }, () => 'b'.repeat(300)), '', 4],
      languages: [...Array.from({ length: 70 }, () => 'language'.repeat(20)), '', null],
      probed: 'yes',
      attributes: {},
    } as unknown as TitleSource;
    const providerSources = [
      malformed,
      ...Array.from({ length: LIBRARY_SERVICE_WIRE_LIMITS.downloadSources }, (_, index) =>
        source(`release-${index}.mkv`),
      ),
    ];
    const downloads = new DownloadCoordinator(log, clock, {
      prepare: async () => ({ state: 'preparing', progress: 0 }),
      cancel: async () => true,
      resolve: async () => ({
        sources: providerSources,
        answer: {
          kind: 'partial',
          missing: Number.POSITIVE_INFINITY,
          outage: { builtAt: Number.NaN },
        },
      }),
      ticket: (url) => (url.startsWith('/scout/') ? url : null),
    });
    const service = new LibraryLogAuthority(log, clock, {
      mode: 'local',
      downloads,
      content: missingContent,
    });
    const title = { target: movie, name: 'Seven' };
    const alternatives = await service.query({ kind: 'download.sources', title });
    expect(alternatives.kind).toBe('download.sources');
    if (alternatives.kind !== 'download.sources') throw new Error('wrong query result');
    expect(alternatives.sources).toHaveLength(LIBRARY_SERVICE_WIRE_LIMITS.downloadSources);
    expect(alternatives.sources?.[0]).toMatchObject({
      identity: 'malformed-release',
      probed: false,
    });
    expect(alternatives.sources?.[0]).not.toHaveProperty('cached');
    expect(alternatives.sources?.[0]).not.toHaveProperty('sizeBytes');
    expect(alternatives.sources?.[0]).not.toHaveProperty('seeders');
    expect(alternatives.sources?.[0]).not.toHaveProperty('packSizeBytes');
    expect(alternatives.sources?.[0]?.label).toHaveLength(4_096);
    expect(alternatives.sources?.[0]?.filename).toHaveLength(4_096);
    expect(alternatives.sources?.[0]?.badges).toHaveLength(32);
    expect(alternatives.sources?.[0]?.badges.every((badge) => badge.length === 256)).toBe(true);
    expect(alternatives.sources?.[0]?.languages).toHaveLength(64);
    expect(alternatives.sources?.[0]?.languages.every((language) => language.length === 64)).toBe(
      true,
    );
    expect(alternatives.answer).toBeUndefined();
    expect(
      decodeLibraryServiceServerMessage({
        type: 'query-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'bounded-provider-sources',
        version: { instance: 'worker', generation: null, revision: 0 },
        result: alternatives,
      }),
    ).toMatchObject({ ok: true });

    const internalTitle = { mediaType: 'movie' as const, mediaId: 7, title: 'Seven' };
    await downloads.enqueue(internalTitle, providerSources[1]!, providerSources.length);
    const queued = downloads.list()[0]!;
    downloads.answers.set(queued.name, {
      state: 'preparing',
      progress: 0,
      fetch: { state: 'fetching', seeds: 2, peers: 3, service: 's'.repeat(300) },
    });
    const projected = await service.select({ kind: 'downloads' });
    expect(projected.kind).toBe('downloads');
    if (projected.kind !== 'downloads') throw new Error('wrong selection');
    expect(projected.items[0]?.status.fetch?.service).toHaveLength(256);
    expect(projected.items[0]?.status.service).toHaveLength(256);
    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'downloads',
        version: { instance: 'worker', generation: null, revision: 0 },
        value: projected,
      }),
    ).toMatchObject({ ok: true });
  });
});
