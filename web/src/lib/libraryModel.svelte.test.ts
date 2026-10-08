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

it('opens only Home-critical roots and keeps watched history lazy', async () => {
  const service = new FakeService();
  const model = new LibraryModel(service, options);

  expect(service.subscriptionsSeenAtOpen).toEqual([
    { kind: 'overview' },
    { kind: 'continue' },
    { kind: 'settings' },
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
  expect(Object.isFrozen(model.overview)).toBe(true);

  const history = model.history();
  expect(service.subscriptions.at(-1)?.selection).toEqual({ kind: 'history' });
  service.publish({ kind: 'history' }, historyValue(), 5);
  expect(history.snapshot.value?.items[0]).toMatchObject({ watchedAt: 100 });
  history.release();
  expect(service.subscriptions.at(-1)?.stopped).toBe(true);

  const before = model.continueWatching;
  service.status({ kind: 'reconnecting', version: version(4) });
  service.publish({ kind: 'continue' }, continueValue(), 5);
  expect(model.continueWatching).not.toBe(before);
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
  await expect(model.preparePlayback(title, episode)).resolves.toMatchObject({
    result: { kind: 'playback.prepare', action: 'resume', target: episode },
  });
  await model.observeTitleShape({
    title,
    seasons: [{ season: 2, episodes: 8 }],
    lastAired: { season: 2, episode: 6 },
  });
  await model.observeLifecycle({ visible: true, online: true, playbackActive: false });
  expect(service.observations).toEqual([
    {
      kind: 'title-shape',
      title,
      seasons: [{ season: 2, episodes: 8 }],
      lastAired: { season: 2, episode: 6 },
    },
    { kind: 'lifecycle', visible: true, online: true, playbackActive: false },
  ]);
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
