import { expect, it, vi } from 'vitest';
import { LibraryModel } from './libraryModel.svelte';
import { LibraryServiceError, type LibraryServiceOpenOptions } from './libraryServiceClient';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';
import type {
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceCommandResult,
  LibraryServiceFailure,
  LibrarySessionStatus,
  LibraryTask,
  LibraryTaskResult,
  LibraryVersion,
  TitleRef,
} from './libraryServiceProtocol';
import type { LibrarySelectionSnapshot } from './libraryServiceSupervisor';

type Subscription = {
  selection: LibrarySelection;
  listener: (snapshot: LibrarySelectionSnapshot) => void;
  stopped: boolean;
};

const version = (revision: number): LibraryVersion => ({
  instance: 'worker-1',
  generation: 'generation-1',
  revision,
});

const failure: LibraryServiceFailure = {
  code: 'unavailable',
  message: 'could not open library',
  retryable: true,
};

class FakeService {
  readonly subscriptions: Subscription[] = [];
  readonly statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  readonly opened: LibraryServiceOpenOptions[] = [];
  readonly commands: Array<{ command: LibraryCommand; operationId?: string }> = [];
  readonly queries: LibraryQuery[] = [];
  readonly observations: LibraryObservation[] = [];
  readonly close = vi.fn();
  readonly retry = vi.fn(async () => version(9));
  openFailure?: LibraryServiceFailure;
  subscriptionsSeenAtOpen: LibrarySelection[] = [];

  async open(options: LibraryServiceOpenOptions): Promise<LibraryVersion> {
    this.opened.push(options);
    this.subscriptionsSeenAtOpen = this.subscriptions.map(({ selection }) => selection);
    if (this.openFailure) throw new LibraryServiceError(this.openFailure);
    this.publish({ kind: 'overview' }, overviewValue(), 1);
    this.publish({ kind: 'continue' }, continueValue(), 2);
    this.publish({ kind: 'settings' }, settingsValue(), 4);
    this.publish({ kind: 'runtime' }, runtimeValue(), 4);
    this.status({ kind: 'ready', version: version(4) });
    return version(4);
  }

  async command(
    command: LibraryCommand,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    this.commands.push({ command, ...(operationId ? { operationId } : {}) });
    return {
      type: 'command-result',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'request-1',
      operationId: operationId ?? 'generated-operation',
      outcome: 'applied',
      delivery: 'queued',
      version: version(5),
    };
  }

  async query(
    query: LibraryQuery,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    this.queries.push(query);
    if (query.kind === 'parental-pin.verify')
      return {
        result: { kind: 'parental-pin.verify', matches: query.pin === '1234' },
        version: version(6),
      };
    if (query.kind === 'download.refresh')
      return { result: { kind: 'download.refresh', refreshed: true }, version: version(6) };
    if (query.kind === 'download.sources')
      return { result: { kind: 'download.sources', sources: [] }, version: version(6) };
    if (query.kind === 'download.artwork')
      return { result: { kind: 'download.artwork', stillPath: null }, version: version(6) };
    if (query.kind === 'retained.services.get')
      return {
        result: { kind: 'retained.services', value: retainedServicesValue() },
        version: version(6),
      };
    if (query.kind === 'retained.home-continue.get')
      return {
        result: { kind: 'retained.home-continue', present: true },
        version: version(6),
      };
    if (query.kind === 'retained.billboard.get')
      return {
        result: {
          kind: 'retained.billboard',
          scope: query.scope,
          value:
            query.scope.kind === 'personal'
              ? { kind: 'personal', at: 1_000, titles: [] }
              : { kind: 'shared', titles: [] },
        },
        version: version(6),
      };
    if (query.kind === 'library.metadata')
      return {
        result: {
          kind: 'library.metadata',
          titles: query.titles.map((title) => ({ ...title, title: `#${title.id}` })),
          shapes: [],
          retryable: [],
        },
        version: version(6),
      };
    if (query.kind !== 'playback.prepare') throw new Error('unsupported query in fake service');
    return {
      result: {
        kind: 'playback.prepare',
        action: 'resume',
        target: query.episode ?? { ...query.title, type: 'movie' },
        resume: { fraction: 0.4, seconds: 800 },
      } as LibraryQueryResult,
      version: version(6),
    };
  }

  async task(_task: LibraryTask): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    throw new Error('unsupported task in fake service');
  }

  async observe(observation: LibraryObservation): Promise<LibraryVersion> {
    this.observations.push(observation);
    return version(7);
  }

  subscribeSnapshot(
    selection: LibrarySelection,
    listener: (snapshot: LibrarySelectionSnapshot) => void,
  ): () => void {
    const subscription = { selection, listener, stopped: false };
    this.subscriptions.push(subscription);
    listener({ selection, connection: 'connecting' });
    return () => {
      subscription.stopped = true;
    };
  }

  onStatus(listener: (status: LibrarySessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  status(status: LibrarySessionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  publish(selection: LibrarySelection, value: LibrarySelectionValue, revision: number): void {
    const key = JSON.stringify(selection);
    for (const subscription of this.subscriptions)
      if (!subscription.stopped && JSON.stringify(subscription.selection) === key)
        subscription.listener({
          selection: subscription.selection,
          connection: 'ready',
          value,
          version: version(revision),
        });
  }
}

const options: LibraryServiceOpenOptions = {
  libraryKey: 'library-1',
  mode: 'online',
};

const overviewValue = (): LibrarySelectionValue => ({
  kind: 'overview',
  owned: [{ type: 'movie', id: 1 }],
  watched: [],
  watchlist: [{ type: 'movie', id: 1 }],
  standings: [{ title: { type: 'movie', id: 1 }, standing: 'watchlist' }],
  weighted: [],
  seeds: { watched: [], watchlisted: [{ type: 'movie', id: 1 }] },
});

const continueValue = (): LibrarySelectionValue => ({
  kind: 'continue',
  items: [{ title: { type: 'movie', id: 1 }, fraction: 0.4 }],
  needsShapes: [],
});

const historyValue = (): LibrarySelectionValue => ({
  kind: 'history',
  items: [{ title: { type: 'movie', id: 2 }, watchedAt: 100, episodes: 0 }],
});

const connectionsValue = (): LibrarySelectionValue => ({
  kind: 'connections',
  apiKeys: { tmdb: { configured: true, masked: '•••' } },
  parentalPinConfigured: true,
  remoteAccessConfigured: false,
  plugins: [],
  servers: [],
  devices: [],
  diagnostics: { libraryFormat: 4, pendingChanges: 0, selfDeviceId: '0123456789abcdef' },
});

const downloadsValue = (): LibrarySelectionValue => ({
  kind: 'downloads',
  items: [],
});

const simklValue = (): LibrarySelectionValue => ({
  kind: 'simkl',
  connected: true,
  account: '42',
  heldRemovals: [{ type: 'movie', id: 550 }],
  approvalId: 'shown-batch',
});

const settingsValue = (): LibrarySelectionValue => ({
  kind: 'settings',
  preferences: {
    excludedGenres: [],
    excludedLanguages: [],
    hideAnime: false,
    hideWatched: false,
    shownSubtitleLanguages: [],
    subtitlesPerLanguage: 0,
    autoSkipSegments: false,
    autoplayTrailers: true,
    ratingSources: ['imdb', 'tmdb'],
    shownWarnings: [],
    services: [],
    servicesConfigured: false,
  },
});

const runtimeValue = (): LibrarySelectionValue => ({
  kind: 'runtime',
  pluginManifestUrls: ['https://plugins.example/scout/manifest.json'],
  privateRemuxUrl: 'https://remux.tailnet.ts.net',
});

const retainedServicesValue = () => ({
  routes: { remux: [{ url: 'https://remux.example' }] },
  scout: { install: 'https://plugins.example/scout', base: '/scout' },
  atlas: '/atlas',
  reel: '/reel',
  remux: 'https://remux.example',
});

it('opens only Home-critical roots and keeps history and downloads lazy', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);

  expect(service.subscriptionsSeenAtOpen).toEqual([
    { kind: 'overview' },
    { kind: 'continue' },
    { kind: 'settings' },
    { kind: 'runtime' },
  ]);
  await expect(model.ready).resolves.toEqual(version(4));

  expect(model.connection).toBe('ready');
  expect(model.status).toEqual({ kind: 'ready', version: version(4) });
  expect(model.overview).toMatchObject({
    connection: 'ready',
    value: { kind: 'overview', owned: [{ id: 1 }] },
    version: version(1),
  });
  expect(model.continueWatching.value?.items[0]).toMatchObject({ fraction: 0.4 });
  expect(model.settings.value?.preferences.autoplayTrailers).toBe(true);
  expect(model.runtime.value).toMatchObject({
    pluginManifestUrls: ['https://plugins.example/scout/manifest.json'],
  });
  expect(Object.isFrozen(model.overview)).toBe(true);

  const history = model.history();
  expect(service.subscriptions.at(-1)?.selection).toEqual({ kind: 'history' });
  service.publish({ kind: 'history' }, historyValue(), 5);
  expect(history.snapshot.value?.items[0]).toMatchObject({ watchedAt: 100 });
  history.release();
  expect(service.subscriptions.at(-1)?.stopped).toBe(true);

  const connections = model.connections();
  service.publish({ kind: 'connections' }, connectionsValue(), 6);
  expect(connections.snapshot.value?.diagnostics.libraryFormat).toBe(4);
  connections.release();
  expect(service.subscriptions.at(-1)?.stopped).toBe(true);

  const simkl = model.simkl();
  expect(service.subscriptions.at(-1)?.selection).toEqual({ kind: 'simkl' });
  service.publish({ kind: 'simkl' }, simklValue(), 8);
  expect(simkl.snapshot.value).toMatchObject({ connected: true, account: '42' });
  await model.connectSimkl('token', 'connect-simkl');
  await model.approveSimklRemovals('shown-batch', 'approve-simkl');
  await model.observeForegroundReady();
  expect(service.commands.slice(-2)).toEqual([
    {
      command: { kind: 'simkl.connect', token: 'token' },
      operationId: 'connect-simkl',
    },
    {
      command: { kind: 'simkl.removals.approve', approvalId: 'shown-batch' },
      operationId: 'approve-simkl',
    },
  ]);
  expect(service.observations.at(-1)).toEqual({ kind: 'foreground-ready' });
  simkl.release();

  const downloads = model.downloads();
  expect(service.subscriptions.at(-1)?.selection).toEqual({ kind: 'downloads' });
  service.publish({ kind: 'downloads' }, downloadsValue(), 6);
  expect(downloads.snapshot.value).toEqual({ kind: 'downloads', items: [] });
  downloads.release();
  expect(service.subscriptions.at(-1)?.stopped).toBe(true);

  const before = model.continueWatching;
  service.status({ kind: 'reconnecting', version: version(4) });
  service.publish({ kind: 'continue' }, continueValue(), 5);
  expect(model.continueWatching).not.toBe(before);
  model.close();
});

it('exposes named discovery and retained-Home operations without a generic cache surface', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);
  await model.ready;
  const scope = { kind: 'personal', facet: 'movie', fresh: false } as const;
  const billboard = { kind: 'personal' as const, at: 1_000, titles: [] };

  await model.rememberPrivateRemux('https://remux.tailnet.ts.net', 'remember-remux');
  await model.retainServices(retainedServicesValue(), 'retain-services');
  await model.retainHomeContinue(true, 'retain-continue');
  await model.retainBillboard(scope, billboard, 'retain-billboard');

  expect(service.commands.slice(-4)).toEqual([
    {
      command: {
        kind: 'discovery.remux.remember',
        url: 'https://remux.tailnet.ts.net',
      },
      operationId: 'remember-remux',
    },
    {
      command: { kind: 'retained.services.set', value: retainedServicesValue() },
      operationId: 'retain-services',
    },
    {
      command: { kind: 'retained.home-continue.set', present: true },
      operationId: 'retain-continue',
    },
    {
      command: { kind: 'retained.billboard.set', scope, value: billboard },
      operationId: 'retain-billboard',
    },
  ]);
  await expect(model.retainedServices()).resolves.toEqual(retainedServicesValue());
  await expect(model.retainedHomeContinue()).resolves.toBe(true);
  await expect(model.retainedBillboard(scope)).resolves.toEqual({
    kind: 'personal',
    at: 1_000,
    titles: [],
  });
  expect(service.queries.slice(-3)).toEqual([
    { kind: 'retained.services.get' },
    { kind: 'retained.home-continue.get' },
    { kind: 'retained.billboard.get', scope },
  ]);

  model.close();
});

it('shares exact keyed title and ordered-presence subscriptions until their last lease releases', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);
  await model.ready;
  const movie: TitleRef = { type: 'movie', id: 7 };
  const series: TitleRef = { type: 'tv', id: 8 };

  const first = model.title(movie);
  const second = model.title(movie);
  expect(service.subscriptions.filter(({ selection }) => selection.kind === 'title')).toHaveLength(
    1,
  );
  service.publish(
    { kind: 'title', title: movie },
    {
      kind: 'title',
      title: movie,
      listed: true,
      watched: false,
      reaction: 'like',
      standing: 'watchlist',
      progress: null,
      episodes: [],
    },
    5,
  );
  expect(first.snapshot).toBe(second.snapshot);
  first.release();
  expect(service.subscriptions.find(({ selection }) => selection.kind === 'title')?.stopped).toBe(
    false,
  );
  second.release();
  expect(service.subscriptions.find(({ selection }) => selection.kind === 'title')?.stopped).toBe(
    true,
  );

  const ordered = model.presence([movie, series]);
  const shared = model.presence([movie, series]);
  const reversed = model.presence([series, movie]);
  const presences = service.subscriptions.filter(({ selection }) => selection.kind === 'presence');
  expect(presences).toHaveLength(2);
  expect(presences.map(({ selection }) => selection)).toEqual([
    { kind: 'presence', titles: [movie, series] },
    { kind: 'presence', titles: [series, movie] },
  ]);
  ordered.release();
  expect(presences[0]?.stopped).toBe(false);
  shared.release();
  expect(presences[0]?.stopped).toBe(true);
  reversed.release();
  model.close();
});

it('forwards semantic commands, playback queries, and observations without UI policy', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);
  await model.ready;
  const title = { type: 'tv' as const, id: 11 };
  const episode = { ...title, season: 2, episode: 3 };

  const result = await model.setReaction(title, 'love', 'operation-1');
  expect(result).toMatchObject({
    outcome: 'applied',
    delivery: 'queued',
    operationId: 'operation-1',
  });
  expect(service.commands).toEqual([
    { command: { kind: 'reaction.set', title, reaction: 'love' }, operationId: 'operation-1' },
  ]);
  await model.setSeasonWatched(title, 2, [1, 2, 3], true);
  expect(service.commands.at(-1)?.command).toEqual({
    kind: 'season-watched.set',
    title,
    season: 2,
    episodes: [1, 2, 3],
    watched: true,
  });
  await model.setApiKey('tmdb', 'secret', 'key-one');
  await model.setParentalPin('1234', 'pin-one');
  await model.setRemoteAccess({ clientId: 'client', clientSecret: 'secret' }, 'access-one');
  await model.installPlugin('https://addon.example/manifest.json', 'plugin-one');
  await model.setPluginTrust('https://addon.example/manifest.json', 'public-key', 'trust-one');
  await model.patchServer(
    'jellyfin',
    { url: 'http://jellyfin.local:8096', user: 'u1', credential: 'token' },
    'server-one',
  );
  await model.heartbeatDevice('MacBook', 'heartbeat-one');
  await model.removeDevice('fedcba9876543210', 'device-one');
  await expect(model.verifyParentalPin('1234')).resolves.toBe(true);
  expect(service.commands.slice(-8).map(({ command }) => command.kind)).toEqual([
    'api-key.set',
    'parental-pin.set',
    'remote-access.set',
    'plugin.install',
    'plugin-trust.set',
    'server.patch',
    'device.heartbeat',
    'device.remove',
  ]);
  const downloadTitle = { target: episode, name: 'Episode Three' };
  const downloadRelease = {
    identity: 'release-one',
    label: 'Release One',
  };
  await model.enqueueDownload(downloadTitle, downloadRelease, 3, 'download-one');
  await model.tryDownloadRelease(episode, 'release-two', 'download-two');
  await model.removeDownload(episode, 'download-remove');
  expect(service.commands.slice(-3)).toEqual([
    {
      command: {
        kind: 'download.enqueue',
        title: downloadTitle,
        release: downloadRelease,
        candidates: 3,
      },
      operationId: 'download-one',
    },
    {
      command: {
        kind: 'download.release.try',
        target: episode,
        identity: 'release-two',
      },
      operationId: 'download-two',
    },
    {
      command: { kind: 'download.remove', target: episode },
      operationId: 'download-remove',
    },
  ]);
  await expect(model.preparePlayback(title, episode)).resolves.toMatchObject({
    result: { kind: 'playback.prepare', action: 'resume', target: episode },
  });
  await model.observeTitleShape({
    title,
    seasons: [{ season: 2, episodes: 8 }],
    lastAired: { season: 2, episode: 6 },
  });
  await model.observeLifecycle({ visible: true, online: true, playbackActive: false });
  await model.observeForegroundReady();
  expect(service.observations).toEqual([
    {
      kind: 'title-shape',
      title,
      seasons: [{ season: 2, episodes: 8 }],
      lastAired: { season: 2, episode: 6 },
    },
    { kind: 'lifecycle', visible: true, online: true, playbackActive: false },
    { kind: 'foreground-ready' },
  ]);
  model.close();
});

it('narrows rich display titles to the strict service wire references', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);
  await model.ready;
  const title = { type: 'tv' as const, id: 11, title: 'Rich title', year: 2026 };
  const episode = { ...title, season: 2, episode: 3, name: 'Rich episode' };

  const lease = model.title(title);
  const presence = model.presence([title]);
  await model.setContinueDismissed(title, true, 'dismiss-rich-title');
  await model.setReaction(title, 'love', 'react-rich-title');
  await model.setEpisodeWatched(episode, true, 'watch-rich-episode');
  await model.preparePlayback(title, episode);
  await expect(model.libraryMetadata([title, title])).resolves.toEqual({
    titles: [{ type: 'tv', id: 11, title: '#11' }],
    shapes: [],
    retryable: [],
  });
  await model.observeTitleShape({
    title,
    seasons: [{ season: 2, episodes: 8 }],
  });

  const ref = { type: 'tv' as const, id: 11 };
  const episodeRef = { ...ref, season: 2, episode: 3 };
  expect(service.subscriptions.slice(-2).map(({ selection }) => selection)).toEqual([
    { kind: 'title', title: ref },
    { kind: 'presence', titles: [ref] },
  ]);
  expect(service.commands.slice(-3)).toEqual([
    {
      command: { kind: 'continue-dismissed.set', title: ref, dismissed: true },
      operationId: 'dismiss-rich-title',
    },
    {
      command: { kind: 'reaction.set', title: ref, reaction: 'love' },
      operationId: 'react-rich-title',
    },
    {
      command: { kind: 'episode-watched.set', episode: episodeRef, watched: true },
      operationId: 'watch-rich-episode',
    },
  ]);
  expect(service.queries.at(-1)).toEqual({
    kind: 'library.metadata',
    titles: [ref],
  });
  expect(service.observations.at(-1)).toEqual({
    kind: 'title-shape',
    title: ref,
    seasons: [{ season: 2, episodes: 8 }],
  });
  lease.release();
  presence.release();
  model.close();
});

it('exposes open failure, retries explicitly, and closes every source once', async () => {
  const service = new FakeService();
  service.openFailure = failure;
  const model = new LibraryModel(service, options);

  await expect(model.ready).rejects.toMatchObject({ failure });
  expect(model.openFailure).toEqual(failure);
  expect(model.connection).toBe('failed');
  expect(model.status).toEqual({ kind: 'failed', error: failure });

  await expect(model.retry()).resolves.toEqual(version(9));
  expect(model.openFailure).toBeUndefined();
  const lease = model.title({ type: 'movie', id: 12 });
  model.close();
  model.close();
  expect(service.close).toHaveBeenCalledOnce();
  expect(model.connection).toBe('closed');
  expect(model.overview.connection).toBe('closed');
  expect(lease.snapshot.connection).toBe('closed');
  expect(() => model.title({ type: 'movie', id: 13 })).toThrow('library model is closed');
});
