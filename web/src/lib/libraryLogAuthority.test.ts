import { describe, expect, it } from 'vitest';
import { blankTitle } from './actions';
import { openClockStore, type ClockStore } from './clockStore';
import { DownloadCoordinator } from './downloadCoordinator';
import { source } from './downloadTestLog';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { LibraryServiceAuthorityError } from './libraryServiceCore';
import { LIBRARY_SERVICE_PROTOCOL, LIBRARY_SERVICE_WIRE_LIMITS } from './libraryServiceProtocol';
import { decodeLibraryServiceServerMessage } from './libraryServiceProtocolCodec';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import { ensureSyncPolicy } from './syncLoader';
import type { TitleSource } from './titleSources';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const movie = { type: 'movie' as const, id: 7 };
const series = { type: 'tv' as const, id: 11 };

function memoryVault(): Vault {
  const data = new Map<string, Uint8Array>();
  return {
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
  };
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
  return new LibraryLogAuthority(log, clock, { mode, downloads, fetchImpl });
}

describe('LibraryLogAuthority', () => {
  it('owns minimal runtime discovery and the named retained Home values', async () => {
    const { log, authority } = await localAuthority();
    await expect(authority.select({ kind: 'runtime' })).resolves.toMatchObject({
      kind: 'runtime',
      pluginManifestUrls: [],
      privateRemuxUrl: null,
    });

    await expect(
      authority.command({ kind: 'api-key.set', service: 'tmdb', value: 'tmdb-secret' }, 'tmdb'),
    ).resolves.toMatchObject({
      affected: [{ kind: 'connections' }, { kind: 'runtime' }],
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
      tmdbKey: 'tmdb-secret',
      providerKeys: { tmdb: 'tmdb-secret' },
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
      heldRemovals: [],
    });
    expect(JSON.stringify(view)).not.toContain('private-token');
    expect(JSON.stringify(log.settings('keys'))).toContain('private-token');

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
    expect(log.settings('tracker-event:add-movie')).toBeDefined();
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
    expect(log.settings('tracker-event:episode-one-seen')).toBeDefined();
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
    expect(log.settings('tracker-event:season-seen:episode:1:2')).toBeDefined();
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
    expect(log.settings('tracker-event:series-unseen')).toBeDefined();
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
      const affectsRuntime =
        (command.kind === 'api-key.set' && command.service === 'tmdb') ||
        command.kind === 'plugin.install';
      await expect(authority.command(command, operation)).resolves.toMatchObject({
        outcome: 'applied',
        delivery: 'local',
        affected: [
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
        libraryFormat: 2,
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
    ).resolves.toMatchObject({ affected: [{ kind: 'connections' }] });
    expect(log.settings(`handoff:simkl:${tv}`)?.values.token?.value).toBeNull();
    await expect(authority.select({ kind: 'connections' })).resolves.toMatchObject({
      devices: [{ id: '0123456789abcdef' }],
      plugins: [{ pendingApprovalOn: [] }],
    });
    await expect(
      authority.command({ kind: 'device.remove', deviceId: '0123456789abcdef' }, 'remove-self'),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });

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
    const service = new LibraryLogAuthority(log, clock, { mode: 'local', downloads });
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
