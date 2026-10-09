import {
  RESUME_FLOOR,
  WATCHED,
  addToWatchlist,
  blankEpisode,
  blankTitle,
  dismissFromContinueWatching,
  markEpisode,
  markWatched,
  react,
  removeFromLibrary,
  restoreToContinueWatching,
  unwatch,
  unwatchSeries,
  updateEpisodeProgress,
  updateProgress,
} from './actions';
import type { ClockStore } from './clockStore';
import {
  downloadIsInFlight,
  type DownloadCoordinator,
  type DownloadStatus,
} from './downloadCoordinator';
import { episodeProgress } from './detailPresentation';
import {
  contentKey,
  deviceName,
  downloadName,
  readDownload,
  readDownloads,
  type Download,
  type DownloadRelease,
} from './downloadRows';
import { seenEpisodes, watchedHistory } from './history';
import { selectHomeLibraryView, type HomeLibraryView } from './homeLibraryView';
import {
  applyLog,
  ContinueProjector,
  emptyLibrary,
  isAired,
  titleKey,
  type Shape,
  type Standing as ProjectedStanding,
  type Title,
} from './library';
import {
  LIBRARY_SERVICE_WIRE_LIMITS,
  type DownloadViewItem,
  type EpisodeRef,
  type DownloadReleaseDescriptor,
  type DownloadSourceOption,
  type DownloadTitleDescriptor,
  type DownloadTarget,
  type LibraryCommand,
  type LibraryMetadataShape,
  type LibraryMetadataTitle,
  type LibraryObservation,
  type LibraryQuery,
  type LibraryQueryResult,
  type LibraryTask,
  type RetainedBillboard,
  type RatingSource,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibraryServiceErrorCode,
  type Standing,
  type TitleRef,
  type TitleView,
} from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityEvent,
  type LibraryAuthorityObservationResult,
  type LibraryAuthorityTaskResult,
  type LibrarySelectionScope,
} from './libraryServiceCore';
import { LibraryLog } from './log';
import { LibraryAdminAuthority } from './libraryAdminAuthority';
import type { Vault } from './localVault';
import { acceptsAddonURL, readApiKey, readPlugins } from './prefs';
import { ADDRESSES, healed, readPrivateAddresses, storable } from './privateAddresses';
import { recordTrackerEvent } from './trackerEvents';
import {
  approveSimklRemovalsWithClock,
  heldSimklRemovals,
  type HeldRemovals,
} from './simklDelivery';
import { fetchSimklClientId, simklAccountID } from '../settings/simkl';
import { tmdbKeyOf } from './tmdb';
import { fetchDetailsResult } from './tmdb';
import { tmdbFetch } from './tmdbCache';
import { useLibraryRelayMembership } from './relayFetch';
import {
  isLibraryMetadataTitle,
  isRetainedBillboard,
  isRetainedServices,
} from './libraryServiceProtocolCodec';
import {
  change as preferenceChange,
  forgetDevice,
  hashPin,
  parsePublicKey,
  pinMatches,
  readDevices,
  readServers,
  readSyncedPrefs,
  readTrust,
  selfEntry,
  type PrefChanges,
} from '../settings/values';
import {
  compareStamps,
  type ConfigValue,
  type EpisodeRow,
  type Row,
  type SettingsRow,
  type TitleRow,
  type Stamped,
} from './wire';

type Delivery = 'synced' | 'queued' | 'local';

const RETAINED_SERVICES = 'services.v1';
const RETAINED_HOME_SHELVES = 'home.shelves.v1';
const retainedBillboardName = (
  scope: Extract<LibraryQuery, { kind: 'retained.billboard.get' }>['scope'],
) =>
  scope.kind === 'personal'
    ? `billboard.personal.v1.${scope.fresh ? 'fresh.' : ''}${scope.facet ?? 'all'}`
    : `billboard.v4.${scope.fresh ? 'fresh.' : ''}${scope.facet ?? 'all'}`;
const retainedBillboardValue = (
  scope: Extract<LibraryQuery, { kind: 'retained.billboard.get' }>['scope'],
  stored: unknown,
): RetainedBillboard | null => {
  const candidate =
    scope.kind === 'shared'
      ? { kind: 'shared' as const, titles: stored }
      : stored && typeof stored === 'object' && !Array.isArray(stored)
        ? {
            kind: 'personal' as const,
            at: (stored as { at?: unknown }).at,
            titles: (stored as { titles?: unknown }).titles,
          }
        : null;
  return isRetainedBillboard(candidate) && candidate.kind === scope.kind ? candidate : null;
};
const storedBillboardValue = (value: RetainedBillboard): unknown =>
  value.kind === 'shared' ? value.titles : { at: value.at, titles: value.titles };

export type LibraryAffectedSelection = LibrarySelectionScope;

const authorityError = (
  code: LibraryServiceErrorCode,
  message: string,
  retryable = false,
): LibraryServiceAuthorityError => new LibraryServiceAuthorityError({ code, message, retryable });

interface StoredShape {
  shape: Shape;
  digest: string;
}

export interface LibraryLogAuthorityOptions {
  /** `local` is a library opened with `LibraryLog.openLocal`; every other log is `online`. */
  mode: 'online' | 'local';
  /** Worker-owned live download state. */
  downloads: DownloadCoordinator;
  libraryKey?: string;
  vault?: Vault;
  fetchImpl?: typeof fetch;
  /** Test seam for the Worker-owned TMDB cache/fetch path. */
  tmdbFetchImpl?: typeof fetch;
  destination?: (key: string) => Promise<LibraryLog>;
  refreshDownloads?: (target?: DownloadTarget) => Promise<boolean>;
  downloadArtwork?: (target: DownloadTarget) => Promise<string | null>;
}

const sameTitle = (a: TitleRef, b: TitleRef): boolean => a.type === b.type && a.id === b.id;

const sameConfig = (a: ConfigValue | null, b: ConfigValue | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const isRatingSource = (value: string): value is RatingSource =>
  value === 'imdb' || value === 'tmdb' || value === 'rottenTomatoes' || value === 'metacritic';

const uniqueSorted = <T>(values: Iterable<T>, compare?: (a: T, b: T) => number): T[] =>
  [...new Set(values)].sort(compare);

const webUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const serviceStanding = (standing: ProjectedStanding): Standing =>
  standing === 'inProgress' ? 'in-progress' : standing;

const refFromKey = (key: string): TitleRef => {
  const [type, id] = key.split(':');
  if ((type !== 'movie' && type !== 'tv') || !id)
    throw authorityError('internal', 'library projection produced an invalid title reference');
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw authorityError('internal', 'library projection produced an invalid title reference');
  return { type, id: parsed };
};

const effectiveStanding = (
  row: TitleRow | undefined,
  episodes: readonly TitleView['episodes'][number][],
): Standing | null => {
  if (!row || row.deleted.value || row.status.value === 'none')
    return episodes.some(({ fraction }) => fraction > 0) ? 'in-progress' : null;
  if (row.status.value === 'watchlist' && episodes.some(({ fraction }) => fraction > 0))
    return 'in-progress';
  return row.status.value === 'inProgress' ? 'in-progress' : row.status.value;
};

const publicRelease = (
  release: DownloadRelease | NonNullable<DownloadRelease['hedge']>,
  fallbackLabel?: string,
): DownloadReleaseDescriptor => ({
  identity: release.identity,
  label: release.label ?? fallbackLabel ?? release.identity,
  ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
  ...(release.cached !== undefined ? { cached: release.cached } : {}),
});

const providerText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;

const providerInteger = (value: unknown, positive = false): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0)
    ? (value as number)
    : undefined;

const providerStrings = (value: unknown, count: number, length: number): string[] =>
  Array.isArray(value)
    ? value.slice(0, count).flatMap((item) => {
        const text = providerText(item, length);
        return text ? [text] : [];
      })
    : [];

const providerSource = (value: unknown): DownloadSourceOption | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const identity =
    typeof source.identity === 'string' && source.identity.length <= 4_096
      ? providerText(source.identity, 4_096)
      : undefined;
  const filename = providerText(source.filename, 4_096);
  if (!identity || !filename) return null;
  const label = providerText(source.label, 4_096) ?? filename;
  const sizeBytes = providerInteger(source.size, true);
  const seeders = providerInteger(source.seeders);
  const packSizeBytes = providerInteger(source.packSize, true);
  return {
    identity,
    label,
    filename,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(typeof source.cached === 'boolean' ? { cached: source.cached } : {}),
    ...(seeders !== undefined ? { seeders } : {}),
    ...(packSizeBytes !== undefined ? { packSizeBytes } : {}),
    badges: providerStrings(source.badges, 32, 256),
    languages: providerStrings(source.languages, 64, 64),
    probed: source.probed === true,
  };
};

const providerFetch = (value: unknown): DownloadViewItem['status']['fetch'] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fetch = value as Record<string, unknown>;
  const state: NonNullable<DownloadViewItem['status']['fetch']>['state'] =
    fetch.state === 'queued' ||
    fetch.state === 'fetching' ||
    fetch.state === 'downloading' ||
    fetch.state === 'stalled' ||
    fetch.state === 'failed'
      ? fetch.state
      : undefined;
  const seeds = providerInteger(fetch.seeds);
  const peers = providerInteger(fetch.peers);
  const service = providerText(fetch.service, 256);
  const sanitized = {
    ...(state ? { state } : {}),
    ...(seeds !== undefined ? { seeds } : {}),
    ...(peers !== undefined ? { peers } : {}),
    ...(service ? { service } : {}),
  };
  return Object.keys(sanitized).length ? sanitized : undefined;
};

const internalDownloadTitle = (title: DownloadTitleDescriptor) => {
  const target = title.target;
  return {
    mediaType: target.type,
    mediaId: target.id,
    ...(target.type === 'tv' ? { season: target.season, episode: target.episode } : {}),
    title: title.name,
    ...(title.imdbId ? { imdbId: title.imdbId } : {}),
    ...(title.posterPath ? { posterPath: title.posterPath } : {}),
    ...(title.stillPath ? { stillPath: title.stillPath } : {}),
    ...(title.originalLanguage ? { originalLanguage: title.originalLanguage } : {}),
  };
};

const downloadPhase = (
  state: NonNullable<DownloadStatus['state']>,
  fetchState?: 'queued' | 'fetching' | 'downloading' | 'stalled' | 'failed',
): 'queued' | 'downloading' | 'trouble' | 'ready' => {
  if (state === 'ready') return 'ready';
  if (fetchState === 'stalled' || fetchState === 'failed') return 'trouble';
  if (state === 'fetching') return 'downloading';
  if (
    state === 'refused' ||
    state === 'unreachable' ||
    state === 'release_gone' ||
    state === 'no_working_release'
  )
    return 'trouble';
  return 'queued';
};

/**
 * The production domain boundary around one `LibraryLog`.
 *
 * Rows, stamps and tracker journals never cross it. The service observes title layouts, accepts semantic commands,
 * and publishes immutable render-facing values. `LibraryServiceCore` remains responsible for request ordering,
 * revisions and subscriptions.
 */
export class LibraryLogAuthority {
  readonly #shapes = new Map<string, StoredShape>();
  readonly #continueProjector = new ContinueProjector();
  readonly #log: LibraryLog;
  readonly #clock: ClockStore;
  readonly #options: LibraryLogAuthorityOptions;
  readonly #downloadsCoordinator: DownloadCoordinator;
  readonly #fetch: typeof fetch;
  readonly #tmdbFetch: typeof fetch;
  readonly #metadataFlights = new Map<
    string,
    Promise<
      | { kind: 'found'; title: LibraryMetadataTitle; shape?: LibraryMetadataShape }
      | { kind: 'retryable'; retryAfterMs?: number }
      | null
    >
  >();
  readonly #listeners = new Set<(event: LibraryAuthorityEvent) => void>();
  #simklApproval?: { signature: string; id: string; shown: HeldRemovals };
  readonly #admin?: LibraryAdminAuthority;
  #projection?: { rows: Row[]; home: HomeLibraryView };

  constructor(log: LibraryLog, clock: ClockStore, options: LibraryLogAuthorityOptions) {
    this.#log = log;
    this.#clock = clock;
    this.#options = options;
    this.#downloadsCoordinator = options.downloads;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#tmdbFetch = options.tmdbFetchImpl ?? tmdbFetch;
    if (options.libraryKey && options.vault)
      this.#admin = new LibraryAdminAuthority(log, clock, {
        mode: options.mode,
        libraryKey: options.libraryKey,
        vault: options.vault,
        fetchImpl: options.fetchImpl,
        destination: options.destination,
      });
  }

  get generation(): string | null {
    return this.#log.currentGeneration ?? null;
  }

  close(): void {
    this.#listeners.clear();
    this.#admin?.close();
    this.#log.close();
  }

  listen(listener: (event: LibraryAuthorityEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
    switch (selection.kind) {
      case 'overview':
        return this.#overview();
      case 'continue':
        return this.#continue();
      case 'history':
        return this.#history();
      case 'title':
        return this.#title(selection.title);
      case 'presence':
        return this.#presence(selection.titles);
      case 'settings':
        return this.#settings();
      case 'connections':
        return this.#connections();
      case 'simkl':
        return this.#simkl();
      case 'recovery':
        return this.#administration().recoveryView();
      case 'runtime':
        return this.#runtime();
      case 'downloads':
        return this.#downloads();
    }
  }

  async command(
    command: LibraryCommand,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    this.#writable();
    switch (command.kind) {
      case 'watchlist.add':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => addToWatchlist(row, at),
          (row) =>
            !row.deleted.value &&
            (row.status.value === 'watchlist' || row.status.value === 'inProgress'),
        );
      case 'library.remove':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => removeFromLibrary(row, at),
          (row) => row.deleted.value,
        );
      case 'reaction.set':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => react(row, command.reaction, at),
          (row) => row.reaction.value === command.reaction,
          false,
          false,
        );
      case 'episode-watched.set':
        return this.#episodeWatched(command.episode, command.watched, operationId);
      case 'season-watched.set':
        return this.#seasonWatched(command, operationId);
      case 'watched.set':
        return this.#watched(command.title, command.watched, operationId);
      case 'continue-dismissed.set':
        return this.#dismissed(command.title, command.dismissed);
      case 'progress.record':
        return this.#progress(command);
      case 'preferences.patch':
        return this.#patchPreferences(command.patch);
      case 'api-key.set':
        return this.#setApiKey(command.service, command.value);
      case 'parental-pin.set':
        return this.#setParentalPin(command.pin);
      case 'remote-access.set':
        return this.#setRemoteAccess(command.credentials);
      case 'plugin.install':
        return this.#setPlugin(command.manifestUrl, true);
      case 'plugin.remove':
        return this.#setPlugin(command.manifestUrl, false);
      case 'plugin-trust.set':
        return this.#setPluginTrust(command.manifestUrl, command.publicKey);
      case 'server.patch':
        return this.#patchServer(command.server, command.value);
      case 'device.heartbeat':
        return this.#heartbeatDevice(command.name);
      case 'device.remove':
        return this.#removeDevice(command.deviceId);
      case 'simkl.connect':
        return this.#connectSimkl(command.token);
      case 'simkl.disconnect':
        return this.#disconnectSimkl();
      case 'simkl.removals.approve':
        return this.#approveSimklRemovals(command.approvalId);
      case 'discovery.remux.remember':
        return this.#rememberRemux(command.url);
      case 'retained.services.set':
        return this.#keepRetained(RETAINED_SERVICES, command.value);
      case 'retained.home-continue.set':
        return this.#keepRetained(RETAINED_HOME_SHELVES, { continue: command.present });
      case 'retained.billboard.set':
        return this.#keepRetained(
          retainedBillboardName(command.scope),
          storedBillboardValue(command.value),
        );
      case 'download.enqueue':
        return this.#enqueueDownload(command);
      case 'download.remove':
        return this.#removeDownload(command.target);
      case 'download.release.try':
        return this.#tryDownloadRelease(command.target, command.identity);
    }
  }

  async query(query: LibraryQuery): Promise<LibraryQueryResult> {
    switch (query.kind) {
      case 'playback.prepare':
        return this.#preparePlayback(query.title, query.episode);
      case 'parental-pin.verify': {
        const stored = readApiKey(this.#log.settings('keys'), 'parentalPIN');
        return {
          kind: 'parental-pin.verify',
          matches: !!stored && (await pinMatches(stored, query.pin)),
        };
      }
      case 'relay.membership':
        return { kind: 'relay.membership', capability: await this.#log.relayMembership() };
      case 'key-reset.prepare':
        return this.#administration().prepareReset();
      case 'recovery.seal':
        return this.#administration().sealRecovery(query.locator, query.wrapKey, query.createdAt);
      case 'pairing.handover':
        return this.#administration().pairingHandover(query.handoverKey, query.host, query.linkKey);
      case 'history.export':
        return this.#administration().historyExport();
      case 'library.metadata':
        return this.#libraryMetadata(query.titles);
      case 'download.refresh':
        return {
          kind: 'download.refresh',
          refreshed: (await this.#options.refreshDownloads?.(query.target)) ?? false,
        };
      case 'download.sources': {
        const title = internalDownloadTitle(query.title);
        const snapshot = await this.#downloadsCoordinator.sourcesForTitle(title, query.refresh);
        const sources = Array.isArray(snapshot.sources)
          ? snapshot.sources
              .slice(0, LIBRARY_SERVICE_WIRE_LIMITS.downloadSources)
              .flatMap((source) => {
                const sanitized = providerSource(source);
                return sanitized ? [sanitized] : [];
              })
          : null;
        const missing = providerInteger(snapshot.answer?.missing);
        const outageBuiltAt = providerInteger(snapshot.answer?.outage?.builtAt);
        return {
          kind: 'download.sources',
          sources,
          ...(snapshot.answer && missing !== undefined
            ? {
                answer: {
                  kind: snapshot.answer.kind,
                  missing,
                  ...(outageBuiltAt !== undefined ? { outageBuiltAt } : {}),
                },
              }
            : {}),
          ...(snapshot.failure ? { failure: snapshot.failure } : {}),
        };
      }
      case 'download.artwork':
        return {
          kind: 'download.artwork',
          stillPath: (await this.#options.downloadArtwork?.(query.target)) ?? null,
        };
      case 'retained.services.get': {
        const value = await this.#log.kept<unknown>(RETAINED_SERVICES);
        return {
          kind: 'retained.services',
          value: isRetainedServices(value) ? value : null,
        };
      }
      case 'retained.home-continue.get': {
        const value = await this.#log.kept<unknown>(RETAINED_HOME_SHELVES);
        return {
          kind: 'retained.home-continue',
          present:
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof (value as { continue?: unknown }).continue === 'boolean'
              ? (value as { continue: boolean }).continue
              : null,
        };
      }
      case 'retained.billboard.get': {
        const value = await this.#log.kept<unknown>(retainedBillboardName(query.scope));
        return {
          kind: 'retained.billboard',
          scope: query.scope,
          value: retainedBillboardValue(query.scope, value),
        };
      }
      default:
        return query satisfies never;
    }
  }

  task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult> {
    // Settling or explicitly adopting a reset necessarily starts from a log that may already report `moved`.
    if (task.kind !== 'key-reset.settle' && task.kind !== 'key-reset.adopt') this.#writable();
    if (
      ((task.kind === 'key-reset.move' ||
        task.kind === 'key-reset.settle' ||
        task.kind === 'key-reset.adopt') &&
        task.destinationLibraryKey === this.#options.libraryKey) ||
      (task.kind === 'local-library.merge' && task.sourceLibraryKey === this.#options.libraryKey)
    )
      throw authorityError('invalid-request', 'source and destination library must differ');
    return this.#administration().task(task, operationId);
  }

  #administration(): LibraryAdminAuthority {
    if (!this.#admin)
      throw authorityError('not-ready', 'administrative library service is unavailable', true);
    return this.#admin;
  }

  async observe(observation: LibraryObservation): Promise<LibraryAuthorityObservationResult> {
    if (observation.kind === 'lifecycle' || observation.kind === 'foreground-ready')
      return { outcome: 'unchanged', affected: [] };
    const counts = new Map<number, number>();
    for (const { season, episodes } of observation.seasons) {
      if (season < 0 || episodes < 0)
        throw authorityError('invalid-request', 'title shape contains a negative count');
      if (counts.has(season))
        throw authorityError('invalid-request', 'title shape contains a duplicate season');
      counts.set(season, episodes);
    }
    const digest = JSON.stringify({
      seasons: [...counts].sort(([a], [b]) => a - b),
      lastAired: observation.lastAired ?? null,
    });
    const key = titleKey(observation.title);
    if (this.#shapes.get(key)?.digest === digest) return { outcome: 'unchanged', affected: [] };
    this.#shapes.set(key, {
      shape: { counts, ...(observation.lastAired ? { lastAired: observation.lastAired } : {}) },
      digest,
    });
    return {
      outcome: 'applied',
      affected: [{ kind: 'title', title: observation.title }, { kind: 'continue' }],
    };
  }

  async #libraryMetadata(
    titles: TitleRef[],
  ): Promise<Extract<LibraryQueryResult, { kind: 'library.metadata' }>> {
    // This runs in the service Worker, whose relay state is deliberately separate from the page's. Await member
    // registration here before a cold library spends the anonymous allowance; the Worker owns one library for life.
    const membership = await this.#log.relayMembership();
    if (membership) useLibraryRelayMembership(membership);
    const key = tmdbKeyOf(this.#log.settings('keys'));
    const found: Array<{ title: LibraryMetadataTitle; shape?: LibraryMetadataShape }> = [];
    const retryable: TitleRef[] = [];
    let retryAfterMs = 0;
    let next = 0;
    const lookup = async () => {
      for (let ref = titles[next++]; ref; ref = titles[next++]) {
        const result = await this.#metadataFor(ref, key);
        if (result?.kind === 'retryable') {
          retryable.push(ref);
          retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs ?? 0);
        } else if (result) found.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, titles.length) }, lookup));
    found.sort(
      (left, right) =>
        titles.findIndex((ref) => sameTitle(ref, left.title)) -
        titles.findIndex((ref) => sameTitle(ref, right.title)),
    );
    retryable.sort(
      (left, right) =>
        titles.findIndex((ref) => sameTitle(ref, left)) -
        titles.findIndex((ref) => sameTitle(ref, right)),
    );

    const affected: LibrarySelectionScope[] = [];
    for (const { shape } of found) {
      if (!shape) continue;
      const observation: Extract<LibraryObservation, { kind: 'title-shape' }> = {
        kind: 'title-shape',
        ...shape,
      };
      const changed = await this.observe(observation);
      affected.push(...changed.affected);
    }
    if (affected.length) {
      const event: LibraryAuthorityEvent = { kind: 'changed', affected };
      for (const listener of this.#listeners) listener(event);
    }
    return {
      kind: 'library.metadata',
      titles: found.map(({ title }) => title),
      shapes: found.flatMap(({ shape }) => (shape ? [shape] : [])),
      retryable,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }

  /** Join overlapping route, pointer and shelf questions at the Worker boundary. */
  #metadataFor(
    ref: TitleRef,
    key: string,
  ): Promise<
    | { kind: 'found'; title: LibraryMetadataTitle; shape?: LibraryMetadataShape }
    | { kind: 'retryable'; retryAfterMs?: number }
    | null
  > {
    const flightKey = `${ref.type}:${ref.id}`;
    const existing = this.#metadataFlights.get(flightKey);
    if (existing) return existing;
    const flight = (async () => {
      const result = await fetchDetailsResult(ref, key, this.#tmdbFetch);
      if (result.kind === 'retryable') return result;
      if (result.kind === 'missing') return null;
      const title = this.#metadataTitle(result.details.title);
      if (!title) return null;
      const shape = result.details.shape && this.#metadataShape(ref, result.details.shape);
      return { kind: 'found' as const, title, ...(shape ? { shape } : {}) };
    })();
    this.#metadataFlights.set(flightKey, flight);
    void flight.finally(() => {
      if (this.#metadataFlights.get(flightKey) === flight) this.#metadataFlights.delete(flightKey);
    });
    return flight;
  }

  #metadataTitle(title: Title): LibraryMetadataTitle | undefined {
    const candidate = { ...title };
    // TMDB uses empty strings for unknown optional text on otherwise valid records. They mean absence on this wire,
    // not a reason to lose the title's name and poster altogether.
    if (!candidate.posterPath) delete candidate.posterPath;
    if (!candidate.backdropPath) delete candidate.backdropPath;
    if (!candidate.releaseDate) delete candidate.releaseDate;
    if (!candidate.originalLanguage) delete candidate.originalLanguage;
    return isLibraryMetadataTitle(candidate) ? candidate : undefined;
  }

  #metadataShape(ref: TitleRef, shape: Shape): LibraryMetadataShape | undefined {
    if (ref.type !== 'tv' || shape.counts.size > LIBRARY_SERVICE_WIRE_LIMITS.shapeSeasons)
      return undefined;
    const seasons = [...shape.counts].map(([season, episodes]) => ({ season, episodes }));
    if (
      seasons.some(
        ({ season, episodes }) =>
          !Number.isSafeInteger(season) ||
          season < 0 ||
          !Number.isSafeInteger(episodes) ||
          episodes < 0,
      )
    )
      return undefined;
    if (shape.lastAired) {
      const episodes = shape.counts.get(shape.lastAired.season);
      if (
        !Number.isSafeInteger(shape.lastAired.season) ||
        shape.lastAired.season <= 0 ||
        !Number.isSafeInteger(shape.lastAired.episode) ||
        shape.lastAired.episode <= 0 ||
        episodes === undefined ||
        shape.lastAired.episode > episodes
      )
        return undefined;
    }
    return {
      title: { type: 'tv', id: ref.id },
      seasons,
      ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
    };
  }

  #title(ref: TitleRef): TitleView {
    const row = this.#log.title(ref);
    const coordinates = this.#coordinates(ref);
    const episodes = coordinates.map(({ season, episode }) => {
      const held = this.#log.episode(ref, season, episode);
      const fraction = episodeProgress(held, row);
      return {
        season,
        episode,
        watched: fraction >= WATCHED,
        fraction,
        ...(held?.progress.seconds !== undefined ? { seconds: held.progress.seconds } : {}),
        ...(held?.progress.at[0] ? { updatedAt: held.progress.at[0] } : {}),
      };
    });
    const visible = !!row && !row.deleted.value;
    const shapedWatched = coordinates.length > 0 && episodes.every(({ watched }) => watched);
    return {
      kind: 'title',
      title: ref,
      listed:
        (visible && row.status.value !== 'none') || episodes.some(({ fraction }) => fraction > 0),
      watched: coordinates.length ? shapedWatched : visible && row.status.value === 'watched',
      reaction: visible ? row.reaction.value : null,
      standing: effectiveStanding(row, episodes),
      progress:
        visible && row.resume.value > 0
          ? {
              fraction: Math.max(0, Math.min(1, row.resume.value)),
              ...(row.resume.seconds !== undefined ? { seconds: row.resume.seconds } : {}),
              ...(row.resume.at[0] ? { updatedAt: row.resume.at[0] } : {}),
            }
          : null,
      episodes,
    };
  }

  #overview(): Extract<LibrarySelectionValue, { kind: 'overview' }> {
    const { home } = this.#projected();
    return {
      kind: 'overview',
      owned: home.owned.map(refFromKey),
      watched: home.watched.map(refFromKey),
      watchlist: home.watchlist.map(refFromKey),
      standings: home.standings.map(([key, standing]) => ({
        title: refFromKey(key),
        standing: serviceStanding(standing),
      })),
      weighted: home.weighted.map(([key, weight, updatedAt]) => ({
        title: refFromKey(key),
        weight,
        updatedAt,
      })),
      seeds: {
        watched: home.seeds.watched.map(refFromKey),
        watchlisted: home.seeds.watchlisted.map(refFromKey),
      },
    };
  }

  #continue(): Extract<LibrarySelectionValue, { kind: 'continue' }> {
    const { home } = this.#projected();
    const shapes = new Map([...this.#shapes].map(([key, stored]) => [key, stored.shape]));
    const library = { ...home.continueLibrary, shapes };
    return {
      kind: 'continue',
      items: this.#continueProjector
        .project(library)
        .map(({ ref, fraction, episode, seconds, at }) => ({
          title: { type: ref.type, id: ref.id },
          fraction,
          ...(episode ? { episode } : {}),
          ...(seconds !== undefined ? { seconds } : {}),
          ...(at !== undefined ? { updatedAt: at } : {}),
        })),
      needsShapes: home.requiredShapeRefs.filter((key) => !this.#shapes.has(key)).map(refFromKey),
    };
  }

  #presence(titles: TitleRef[]): Extract<LibrarySelectionValue, { kind: 'presence' }> {
    const standings = new Map(this.#projected().home.standings);
    return {
      kind: 'presence',
      items: titles.map((title) => {
        const row = this.#log.title(title);
        const standing = standings.get(titleKey(title));
        return {
          title,
          standing: standing ? serviceStanding(standing) : null,
          reaction: row && !row.deleted.value ? row.reaction.value : null,
        };
      }),
    };
  }

  #history(): Extract<LibrarySelectionValue, { kind: 'history' }> {
    const { rows } = this.#projected();
    const seen = seenEpisodes(rows);
    const names = new Map<string, Title>();
    for (const row of rows) {
      if (row.kind !== 'rec' && row.kind !== 'ep') continue;
      const key = titleKey(row.title);
      if (!names.has(key)) names.set(key, { ...row.title, title: key });
    }
    return {
      kind: 'history',
      items: watchedHistory(rows, names).map(({ title, at, episode, episodes }) => ({
        title: { type: title.type, id: title.id },
        watchedAt: at,
        ...(episode ? { episode } : {}),
        episodes,
        ...(title.type === 'tv' ? { seen: seen.get(titleKey(title)) ?? [] } : {}),
      })),
    };
  }

  #settings(): Extract<LibrarySelectionValue, { kind: 'settings' }> {
    const stored = readSyncedPrefs(this.#log.settings('prefs'));
    const validLanguage = (value: string | undefined): value is string =>
      value !== undefined && /^[a-z]{2}$/.test(value);
    const services = [
      ...new Map(
        stored.services
          .filter(
            ({ id, country }) => Number.isSafeInteger(id) && id > 0 && /^[A-Z]{2}$/.test(country),
          )
          .map((service) => [`${service.id}@${service.country}`, service] as const),
      ).values(),
    ]
      .sort((a, b) => a.country.localeCompare(b.country) || a.id - b.id)
      .slice(0, 256);
    return {
      kind: 'settings',
      preferences: {
        ...stored,
        excludedGenres: uniqueSorted(
          stored.excludedGenres.filter((id) => Number.isSafeInteger(id) && id > 0),
          (a, b) => a - b,
        ).slice(0, 256),
        excludedLanguages: uniqueSorted(stored.excludedLanguages.filter(validLanguage)).slice(
          0,
          256,
        ),
        minReleaseYear:
          stored.minReleaseYear !== undefined &&
          stored.minReleaseYear >= 1800 &&
          stored.minReleaseYear <= 3000
            ? stored.minReleaseYear
            : undefined,
        audioLanguage: validLanguage(stored.audioLanguage) ? stored.audioLanguage : undefined,
        subtitleLanguage: validLanguage(stored.subtitleLanguage)
          ? stored.subtitleLanguage
          : undefined,
        shownSubtitleLanguages: uniqueSorted(
          stored.shownSubtitleLanguages.filter(validLanguage),
        ).slice(0, 256),
        subtitlesPerLanguage:
          Number.isSafeInteger(stored.subtitlesPerLanguage) && stored.subtitlesPerLanguage >= 0
            ? stored.subtitlesPerLanguage
            : 3,
        ratingSources: [...new Set(stored.ratingSources.filter(isRatingSource))],
        shownWarnings: uniqueSorted(
          stored.shownWarnings.filter((warning) => warning.length > 0 && warning.length <= 4_096),
        ).slice(0, 256),
        services,
      },
    };
  }

  #connections(): Extract<LibrarySelectionValue, { kind: 'connections' }> {
    const keys = this.#log.settings('keys');
    const devices = readDevices(this.#log.settings('devices'))
      .filter(({ id }) => id.length > 0 && id.length <= 128)
      .slice(0, 512);
    const trust = readTrust(this.#log.settings('trust'));
    const plugins = readPlugins(this.#log.settings('plugins'))
      .filter((manifestUrl) => manifestUrl.length <= 4_096 && acceptsAddonURL(manifestUrl))
      .slice(0, 10_000)
      .map((manifestUrl) => {
        const signingKey = parsePublicKey(trust.get(manifestUrl) ?? '');
        return {
          manifestUrl,
          ...(signingKey ? { signingKey } : {}),
          pendingApprovalOn: devices
            .filter((device) => device.kind === 'tv' && device.pending.includes(manifestUrl))
            .map(({ id, name }) => ({ id, name: name.slice(0, 256) })),
        };
      });
    const apiKeys = (
      [
        ['tmdb', 'tmdb'],
        ['omdb', 'omdb'],
        ['content-warnings', 'doesthedogdie'],
      ] as const
    ).reduce<Extract<LibrarySelectionValue, { kind: 'connections' }>['apiKeys']>(
      (found, [service, stored]) => {
        const value = readApiKey(keys, stored);
        if (value && value.length <= 16_384)
          found[service] = {
            configured: true,
            masked: value.length <= 4 ? '•'.repeat(value.length) : `••••${value.slice(-4)}`,
          };
        return found;
      },
      {},
    );
    return {
      kind: 'connections',
      apiKeys,
      parentalPinConfigured: !!readApiKey(keys, 'parentalPIN'),
      remoteAccessConfigured:
        !!readApiKey(keys, 'cfAccessId') && !!readApiKey(keys, 'cfAccessSecret'),
      plugins,
      servers: readServers(this.#log.settings('servers'))
        .filter(({ url }) => url.length <= 4_096 && webUrl(url))
        .map((server) => ({
          ...server,
          ...(server.user ? { user: server.user.slice(0, 4_096) } : {}),
        })),
      devices: devices.map(({ id, name, kind, seen, format }) => ({
        id,
        name: name.slice(0, 256),
        kind,
        ...(seen !== undefined && Number.isSafeInteger(seen) && seen >= 0
          ? { lastSeenAt: seen }
          : {}),
        ...(format !== undefined && Number.isSafeInteger(format) && format >= 0
          ? { libraryFormat: format }
          : {}),
      })),
      diagnostics: {
        libraryFormat: this.#log.wireMinimum,
        pendingChanges: this.#log.pendingActions,
        selfDeviceId: this.#clock.device,
      },
    };
  }

  #downloads(): Extract<LibrarySelectionValue, { kind: 'downloads' }> {
    return {
      kind: 'downloads',
      items: readDownloads(this.#log.rows()).map((download) => {
        const durable = this.#downloadsCoordinator.status(download);
        const live = this.#downloadsCoordinator.answers.get(download.name);
        const fetch = providerFetch(live?.fetch);
        const service =
          providerText(live?.fetch?.service, 256) ?? providerText(durable.service, 256);
        const state = durable.state ?? 'starting';
        const fraction = Math.max(
          0,
          Math.min(1, download.progress?.lastProgress ?? durable.clock.lastProgress),
        );
        return {
          content: download.content,
          title: { type: download.title.mediaType, id: download.title.mediaId },
          name: download.title.title || download.release.label,
          ...(download.title.imdbId ? { imdbId: download.title.imdbId } : {}),
          ...(download.title.season !== undefined ? { season: download.title.season } : {}),
          ...(download.title.episode !== undefined ? { episode: download.title.episode } : {}),
          ...(download.title.posterPath ? { posterPath: download.title.posterPath } : {}),
          ...(download.title.stillPath ? { stillPath: download.title.stillPath } : {}),
          queuedAt: download.queuedAt,
          queuedBy: {
            device: download.queuedBy,
            isSelf: download.queuedBy === this.#clock.device,
            ...(deviceName(this.#log.settings('devices'), download.queuedBy)
              ? { name: deviceName(this.#log.settings('devices'), download.queuedBy) }
              : {}),
          },
          release: publicRelease(download.release),
          ...(download.release.hedge
            ? { alternate: publicRelease(download.release.hedge, download.release.label) }
            : {}),
          status: {
            state: state.replaceAll('_', '-') as Extract<
              LibrarySelectionValue,
              { kind: 'downloads' }
            >['items'][number]['status']['state'],
            phase: downloadPhase(state, live?.fetch?.state),
            ...(fraction > 0 ? { fraction } : {}),
            ...(durable.clock.progressAt > 0 ? { progressAt: durable.clock.progressAt } : {}),
            ...(live?.etaSeconds !== undefined &&
            Number.isFinite(live.etaSeconds) &&
            live.etaSeconds >= 0 &&
            live.etaSeconds <= 7 * 24 * 60 * 60
              ? { etaSeconds: live.etaSeconds }
              : {}),
            ...(live?.bytesPerSecond !== undefined &&
            Number.isFinite(live.bytesPerSecond) &&
            live.bytesPerSecond >= 0
              ? { bytesPerSecond: live.bytesPerSecond }
              : {}),
            ...(fetch ? { fetch } : {}),
            ...(service ? { service } : {}),
            ...(durable.until !== undefined ? { until: durable.until } : {}),
            stalled: durable.stalled || live?.fetch?.state === 'stalled',
          },
          tried: new Set([...download.tried, download.release.identity]).size,
          ...(download.candidates !== undefined ? { candidates: download.candidates } : {}),
          announced: download.announced,
        };
      }),
    };
  }

  #runtime(): Extract<LibrarySelectionValue, { kind: 'runtime' }> {
    const remux = readPrivateAddresses(this.#log.settings(ADDRESSES)).remux;
    return {
      kind: 'runtime',
      pluginManifestUrls: readPlugins(this.#log.settings('plugins'))
        .filter((url) => url.length <= 4_096 && acceptsAddonURL(url))
        .slice(0, 10_000),
      privateRemuxUrl: remux ?? null,
    };
  }

  #simkl(): Extract<LibrarySelectionValue, { kind: 'simkl' }> {
    const account = this.#simklAccount();
    if (!account) {
      this.#simklApproval = undefined;
      return {
        kind: 'simkl',
        connected: !!readApiKey(this.#log.settings('keys'), 'simkl'),
        heldRemovals: [],
      };
    }
    let shown: HeldRemovals = { titles: [], approval: null };
    try {
      shown = heldSimklRemovals(this.#log);
    } catch (error) {
      console.warn('den: held SIMKL removals could not be projected', error);
    }
    const signature = JSON.stringify([account, shown.titles, shown.approval]);
    if (!shown.approval || shown.titles.length === 0) this.#simklApproval = undefined;
    else if (this.#simklApproval?.signature !== signature)
      this.#simklApproval = { signature, id: crypto.randomUUID(), shown };
    return {
      kind: 'simkl',
      connected: true,
      account,
      heldRemovals: shown.titles,
      ...(this.#simklApproval ? { approvalId: this.#simklApproval.id } : {}),
    };
  }

  #simklAccount(): string | undefined {
    return this.#simklAccounts()[0];
  }

  #simklAccounts(): string[] {
    return Object.entries(this.#log.settings('trackers')?.values ?? {})
      .filter(
        ([name, stamped]) =>
          name.startsWith('simkl:') &&
          !name.endsWith('.token') &&
          stamped.value !== null &&
          stamped.value !== undefined,
      )
      .map(([name]) => name.slice('simkl:'.length))
      .sort();
  }

  #projected(): { rows: Row[]; home: HomeLibraryView } {
    const rows = this.#log.rows();
    if (this.#projection?.rows === rows) return this.#projection;
    const home = selectHomeLibraryView(applyLog(emptyLibrary(), rows), rows);
    this.#projection = { rows, home };
    return this.#projection;
  }

  #coordinates(ref: TitleRef): Array<{ season: number; episode: number }> {
    if (ref.type !== 'tv') return [];
    const shape = this.#shapes.get(titleKey(ref))?.shape;
    if (!shape) return [];
    return [...shape.counts]
      .filter(([season]) => season > 0)
      .sort(([a], [b]) => a - b)
      .flatMap(([season, count]) =>
        Array.from({ length: count }, (_, index) => ({ season, episode: index + 1 })),
      )
      .filter((episode) => isAired(episode, shape.lastAired));
  }

  async #titleAction(
    ref: TitleRef,
    operationId: string,
    change: (row: TitleRow, at: Awaited<ReturnType<ClockStore['issue']>>) => TitleRow,
    already: (row: TitleRow) => boolean,
    affectsContinue = true,
    affectsHistory = true,
  ): Promise<LibraryAuthorityCommandResult> {
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    if (already(before)) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const event = recordTrackerEvent(before, change(before, at), at, operationId);
    if (!event) return this.#unchanged();
    return this.#writeAction(event, this.#affected(ref, affectsContinue, affectsHistory));
  }

  async #episodeWatched(
    ref: EpisodeRef,
    watched: boolean,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    const before =
      this.#log.episode(ref, ref.season, ref.episode) ?? blankEpisode(ref, ref.season, ref.episode);
    const current = episodeProgress(before, this.#log.title(ref));
    if (current >= WATCHED === watched && (watched || current === 0)) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const event = recordTrackerEvent(before, markEpisode(before, watched, at), at, operationId);
    if (!event) return this.#unchanged();
    return this.#writeAction(event, this.#affected(ref));
  }

  async #seasonWatched(
    command: Extract<LibraryCommand, { kind: 'season-watched.set' }>,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    const episodes = [...new Set(command.episodes)].sort((a, b) => a - b);
    if (command.season <= 0)
      throw authorityError('invalid-request', 'a season-wide change requires a regular season');
    if (episodes.some((episode) => episode <= 0))
      throw authorityError('invalid-request', 'episode numbers must be positive');
    const journals: SettingsRow[] = [];
    await this.#clock.see(this.#log.newestStamp());
    for (const episode of episodes) {
      const before =
        this.#log.episode(command.title, command.season, episode) ??
        blankEpisode(command.title, command.season, episode);
      const current = episodeProgress(before, this.#log.title(command.title));
      if (current >= WATCHED === command.watched && (command.watched || current === 0)) continue;
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        markEpisode(before, command.watched, at),
        at,
        `${operationId}:episode:${command.season}:${episode}`,
      );
      if (event) journals.push(event);
    }
    return this.#writeActions(journals, this.#affected(command.title));
  }

  async #watched(
    ref: TitleRef,
    watched: boolean,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    if (ref.type === 'movie')
      return this.#titleAction(
        ref,
        operationId,
        (row, at) => (watched ? markWatched : unwatch)(row, at),
        (row) =>
          !row.deleted.value &&
          (watched
            ? row.status.value === 'watched'
            : row.status.value !== 'watched' && row.resume.value === 0),
      );

    const coordinates = this.#coordinates(ref);
    if (!this.#shapes.has(titleKey(ref)))
      throw authorityError(
        'not-ready',
        'a title shape must be observed before changing a whole series',
        true,
      );
    const journals: SettingsRow[] = [];
    await this.#clock.see(this.#log.newestStamp());
    for (const { season, episode } of coordinates) {
      const before = this.#log.episode(ref, season, episode) ?? blankEpisode(ref, season, episode);
      const current = episodeProgress(before, this.#log.title(ref));
      if (current >= WATCHED === watched && (watched || current === 0)) continue;
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        markEpisode(before, watched, at),
        at,
        `${operationId}:episode:${season}:${episode}`,
      );
      if (event) journals.push(event);
    }
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    const titleAlready = watched
      ? !before.deleted.value && before.status.value === 'watched'
      : before.status.value !== 'watched' &&
        before.resume.value === 0 &&
        before.episodesReset !== null;
    if (!titleAlready) {
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        (watched ? markWatched : unwatchSeries)(before, at),
        at,
        operationId,
      );
      if (event) journals.push(event);
    }
    return this.#writeActions(journals, this.#affected(ref));
  }

  async #dismissed(ref: TitleRef, dismissed: boolean): Promise<LibraryAuthorityCommandResult> {
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    if (before.dismissed.value === dismissed) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const after = (dismissed ? dismissFromContinueWatching : restoreToContinueWatching)(before, at);
    return this.#writeRow(after, [{ kind: 'continue' }]);
  }

  async #progress(
    command: Extract<LibraryCommand, { kind: 'progress.record' }>,
  ): Promise<LibraryAuthorityCommandResult> {
    if (command.title.type === 'tv' && !command.episode)
      throw authorityError('invalid-request', 'series progress requires an episode');
    if (command.episode && !sameTitle(command.title, command.episode))
      throw authorityError('invalid-request', 'episode does not belong to the title');
    if (command.episode) {
      const before =
        this.#log.episode(command.episode, command.episode.season, command.episode.episode) ??
        blankEpisode(command.episode, command.episode.season, command.episode.episode);
      if (before.progress.value === command.fraction && before.progress.seconds === command.seconds)
        return this.#unchanged();
      await this.#clock.see(this.#log.newestStamp());
      const at = await this.#clock.issue(command.observedAt);
      return this.#writeRow(
        updateEpisodeProgress(before, command.fraction, command.seconds, at),
        this.#affected(command.title),
      );
    }
    const before = this.#log.title(command.title) ?? blankTitle(command.title, command.observedAt);
    if (before.resume.value === command.fraction && before.resume.seconds === command.seconds)
      return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue(command.observedAt);
    return this.#writeRow(
      updateProgress(before, command.fraction, command.seconds, at),
      this.#affected(command.title),
    );
  }

  async #patchPreferences(
    patch: Extract<LibraryCommand, { kind: 'preferences.patch' }>['patch'],
  ): Promise<LibraryAuthorityCommandResult> {
    const changes: PrefChanges = {};
    if (patch.excludedGenres !== undefined)
      Object.assign(changes, preferenceChange.excludedGenres(patch.excludedGenres));
    if (patch.excludedLanguages !== undefined)
      Object.assign(changes, preferenceChange.excludedLanguages(patch.excludedLanguages));
    if (patch.hideAnime !== undefined)
      Object.assign(changes, preferenceChange.hideAnime(patch.hideAnime));
    if (patch.hideWatched !== undefined)
      Object.assign(changes, preferenceChange.hideWatched(patch.hideWatched));
    if (patch.minReleaseYear !== undefined)
      Object.assign(changes, preferenceChange.minReleaseYear(patch.minReleaseYear ?? undefined));
    if (patch.audioLanguage !== undefined)
      Object.assign(changes, preferenceChange.audioLanguage(patch.audioLanguage ?? undefined));
    if (patch.subtitleLanguage !== undefined)
      Object.assign(
        changes,
        preferenceChange.subtitleLanguage(patch.subtitleLanguage ?? undefined),
      );
    if (patch.shownSubtitleLanguages !== undefined)
      Object.assign(changes, preferenceChange.shownSubtitleLanguages(patch.shownSubtitleLanguages));
    if (patch.subtitlesPerLanguage !== undefined)
      Object.assign(changes, preferenceChange.subtitlesPerLanguage(patch.subtitlesPerLanguage));
    if (patch.autoSkipSegments !== undefined)
      Object.assign(changes, preferenceChange.autoSkipSegments(patch.autoSkipSegments));
    if (patch.autoplayTrailers !== undefined)
      Object.assign(changes, preferenceChange.autoplayTrailers(patch.autoplayTrailers));
    if (patch.ratingSources !== undefined)
      Object.assign(
        changes,
        patch.ratingSources.kind === 'default'
          ? { 'den.enabledRatingSources': null }
          : preferenceChange.ratingSources(patch.ratingSources.values),
      );
    if (patch.shownWarnings !== undefined)
      Object.assign(changes, preferenceChange.shownWarnings(patch.shownWarnings));
    if (patch.watchRegion !== undefined)
      Object.assign(changes, preferenceChange.watchRegion(patch.watchRegion ?? undefined));
    if (patch.services !== undefined)
      Object.assign(
        changes,
        patch.services.kind === 'default'
          ? { 'den.myServicePicks': null }
          : preferenceChange.services(patch.services.values),
      );
    if (patch.maturityCeiling !== undefined)
      Object.assign(changes, preferenceChange.maturityCeiling(patch.maturityCeiling ?? undefined));

    const base = this.#log.settings('prefs') ?? {
      kind: 'set' as const,
      schema: 2,
      name: 'prefs',
      values: {},
    };
    const changed = Object.entries(changes).filter(
      ([name, value]) => !sameConfig(base.values[name]?.value ?? null, value),
    );
    if (!changed.length) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const values = { ...base.values };
    for (const [name, value] of changed) values[name] = { value, at };
    return this.#writeRow({ ...base, values }, [{ kind: 'settings' }]);
  }

  #keyName(service: 'tmdb' | 'omdb' | 'content-warnings'): string {
    return service === 'content-warnings' ? 'doesthedogdie' : service;
  }

  async #setApiKey(
    service: 'tmdb' | 'omdb' | 'content-warnings',
    value: string | null,
  ): Promise<LibraryAuthorityCommandResult> {
    if (value !== null && (!value.length || value.length > 16_384))
      throw authorityError('invalid-request', 'API key is empty or too long');
    return this.#patchSettings(
      'keys',
      { [this.#keyName(service)]: value === null ? null : { string: value } },
      [{ kind: 'connections' }],
    );
  }

  async #setParentalPin(pin: string | null): Promise<LibraryAuthorityCommandResult> {
    if (pin !== null && !/^\d{4}$/.test(pin))
      throw authorityError('invalid-request', 'parental PIN must be four digits');
    const current = readApiKey(this.#log.settings('keys'), 'parentalPIN');
    if (pin !== null && current && (await pinMatches(current, pin))) return this.#unchanged();
    return this.#patchSettings(
      'keys',
      { parentalPIN: pin === null ? null : { string: await hashPin(pin) } },
      [{ kind: 'connections' }],
    );
  }

  async #setRemoteAccess(
    credentials: { clientId: string; clientSecret: string } | null,
  ): Promise<LibraryAuthorityCommandResult> {
    if (
      credentials &&
      (!credentials.clientId.length ||
        credentials.clientId.length > 4_096 ||
        !credentials.clientSecret.length ||
        credentials.clientSecret.length > 4_096)
    )
      throw authorityError('invalid-request', 'remote access credentials are empty or too long');
    return this.#patchSettings(
      'keys',
      {
        cfAccessId: credentials ? { string: credentials.clientId } : null,
        cfAccessSecret: credentials ? { string: credentials.clientSecret } : null,
      },
      [{ kind: 'connections' }],
    );
  }

  async #setPlugin(
    manifestUrl: string,
    installed: boolean,
  ): Promise<LibraryAuthorityCommandResult> {
    if (manifestUrl.length > 4_096 || !acceptsAddonURL(manifestUrl))
      throw authorityError('invalid-request', 'plugin manifest URL is not allowed');
    return this.#patchSettings('plugins', { [manifestUrl]: installed ? { bool: true } : null }, [
      { kind: 'connections' },
      { kind: 'runtime' },
    ]);
  }

  async #rememberRemux(url: string): Promise<LibraryAuthorityCommandResult> {
    if (!storable(url))
      throw authorityError(
        'invalid-request',
        'private remux URL is not a storable tailnet address',
      );
    const change = healed(readPrivateAddresses(this.#log.settings(ADDRESSES)), 'remux', url);
    return change
      ? this.#patchSettings(ADDRESSES, change, [{ kind: 'runtime' }])
      : this.#unchanged();
  }

  async #keepRetained(name: string, value: unknown): Promise<LibraryAuthorityCommandResult> {
    const current = await this.#log.kept<unknown>(name);
    if (JSON.stringify(current) === JSON.stringify(value)) return this.#unchanged();
    try {
      await this.#log.keep(name, value);
    } catch (error) {
      throw authorityError(
        'storage',
        error instanceof Error ? error.message : 'retained library value could not be saved',
        true,
      );
    }
    return { outcome: 'applied', delivery: 'local', affected: [] };
  }

  async #setPluginTrust(
    manifestUrl: string,
    publicKey: string | null,
  ): Promise<LibraryAuthorityCommandResult> {
    if (manifestUrl.length > 4_096 || !acceptsAddonURL(manifestUrl))
      throw authorityError('invalid-request', 'plugin manifest URL is not allowed');
    if (publicKey !== null && !readPlugins(this.#log.settings('plugins')).includes(manifestUrl))
      throw authorityError('not-found', 'plugin is not installed');
    const normalized = publicKey === null ? null : parsePublicKey(publicKey);
    if (publicKey !== null && !normalized)
      throw authorityError('invalid-request', 'plugin signing key is not Ed25519');
    return this.#patchSettings(
      'trust',
      { [manifestUrl]: normalized ? { string: normalized } : null },
      [{ kind: 'connections' }],
    );
  }

  async #patchServer(
    server: 'jellyfin' | 'plex',
    value: { url: string; user?: string; credential?: string } | null,
  ): Promise<LibraryAuthorityCommandResult> {
    if (
      value &&
      (!webUrl(value.url) ||
        value.url.length > 4_096 ||
        (value.user !== undefined && (!value.user.length || value.user.length > 4_096)) ||
        (value.credential !== undefined &&
          (!value.credential.length || value.credential.length > 16_384)) ||
        (server === 'plex' && value.user !== undefined))
    )
      throw authorityError('invalid-request', 'media server URL must use HTTP or HTTPS');
    const stamp = await this.#settingsStamp();
    const rows = [
      this.#changedSettingsRow(
        'servers',
        {
          [server]: value ? { string: value.url } : null,
          ...(server === 'jellyfin'
            ? { 'jellyfin.user': value?.user ? { string: value.user } : null }
            : {}),
        },
        stamp,
      ),
      this.#changedSettingsRow(
        'keys',
        { [server]: value?.credential ? { string: value.credential } : value ? undefined : null },
        stamp,
      ),
    ].filter((row): row is SettingsRow => row !== null);
    return rows.length ? this.#writeRows(rows, [{ kind: 'connections' }]) : this.#unchanged();
  }

  async #heartbeatDevice(name: string): Promise<LibraryAuthorityCommandResult> {
    if (!name.trim() || name.length > 256)
      throw authorityError('invalid-request', 'device name is empty or too long');
    const changes = selfEntry(
      this.#log.settings('devices'),
      { id: this.#clock.device, name: name.trim(), kind: 'browser' },
      Date.now(),
    );
    return changes
      ? this.#patchSettings('devices', changes, [{ kind: 'connections' }])
      : this.#unchanged();
  }

  async #removeDevice(deviceId: string): Promise<LibraryAuthorityCommandResult> {
    if (!/^[0-9a-z]{1,128}$/i.test(deviceId))
      throw authorityError('invalid-request', 'device id is invalid');
    if (deviceId === this.#clock.device)
      throw authorityError('conflict', 'this device cannot remove its own live entry');
    const device = readDevices(this.#log.settings('devices')).some(({ id }) => id === deviceId);
    const suffix = `:${deviceId}`;
    const handoffs = this.#log
      .rows()
      .filter(
        (row): row is SettingsRow =>
          row.kind === 'set' && row.name.startsWith('handoff:') && row.name.endsWith(suffix),
      );
    if (!device && !handoffs.some((row) => Object.values(row.values).some(({ value }) => value)))
      return this.#unchanged();

    const pending = this.#log.pendingActions;
    await this.#clock.see(this.#log.newestStamp());
    if (device) {
      const row = this.#changedSettingsRow(
        'devices',
        forgetDevice(deviceId),
        await this.#clock.issue(),
      );
      if (row && !(await this.#log.write(row))) this.#writeFailed();
    }
    for (const handoff of handoffs) {
      const row = this.#changedSettingsRow(
        handoff.name,
        Object.fromEntries(Object.keys(handoff.values).map((name) => [name, null])),
        await this.#clock.issue(),
      );
      if (row && !(await this.#log.write(row))) this.#writeFailed();
    }
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'connections' }]),
    };
  }

  async #connectSimkl(token: string): Promise<LibraryAuthorityCommandResult> {
    if (!token.length || token.length > 16_384)
      throw authorityError('invalid-request', 'SIMKL token is empty or too long');
    if (this.#log.wireMinimum < 3)
      return this.#patchSettings('keys', { simkl: { string: token } }, [{ kind: 'simkl' }]);

    const clientId = await fetchSimklClientId(this.#fetch);
    const account = clientId && (await simklAccountID(clientId, token, this.#fetch));
    if (!account || account.length > 256)
      throw authorityError('unavailable', 'SIMKL account could not be verified', true);
    const trackerName = `simkl:${account}`;
    const deliveryName = `deliver:simkl:${account}`;
    const current = this.#log.settings('trackers');
    const currentConnection = current?.values[trackerName]?.value;
    let same = false;
    if (currentConnection && 'string' in currentConnection)
      try {
        same =
          (JSON.parse(currentConnection.string) as { access_token?: unknown }).access_token ===
          token;
      } catch {
        // A malformed credential is replaced below.
      }
    if (
      same &&
      this.#log.settings(deliveryName) &&
      this.#simklAccounts().every((existing) => existing === account)
    )
      return this.#unchanged();

    const pending = this.#log.pendingActions;
    await this.#clock.see(this.#log.newestStamp());
    const connectedAt = await this.#clock.issue();
    if (!same || this.#simklAccounts().some((existing) => existing !== account)) {
      const row = this.#changedSettingsRow(
        'trackers',
        {
          ...Object.fromEntries(
            this.#simklAccounts()
              .filter((existing) => existing !== account)
              .map((existing) => [`simkl:${existing}`, null]),
          ),
          [trackerName]: {
            string: JSON.stringify({ access_token: token, connectedAt }),
          },
        },
        connectedAt,
      );
      if (row && !(await this.#log.write(row))) this.#writeFailed();
    }
    if (!this.#log.settings(deliveryName)) {
      const at = await this.#clock.issue();
      const row: SettingsRow = {
        kind: 'set',
        schema: 2,
        name: deliveryName,
        values: {
          since: { value: { string: JSON.stringify(connectedAt) }, at },
          lease: { value: { strings: ['', '1'] }, at },
        },
      };
      if (!(await this.#log.write(row))) this.#writeFailed();
    }
    this.#simklApproval = undefined;
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'simkl' }]),
    };
  }

  async #disconnectSimkl(): Promise<LibraryAuthorityCommandResult> {
    if (this.#log.wireMinimum < 3 || !this.#simklAccount())
      return this.#patchSettings('keys', { simkl: null }, [{ kind: 'simkl' }]);
    const accounts = this.#simklAccounts();
    this.#simklApproval = undefined;
    return this.#patchSettings(
      'trackers',
      Object.fromEntries(accounts.map((account) => [`simkl:${account}`, null])),
      [{ kind: 'simkl' }],
    );
  }

  async #approveSimklRemovals(approvalId: string): Promise<LibraryAuthorityCommandResult> {
    const cached = this.#simklApproval;
    // Re-project before accepting: a concurrent delivery may have replaced the batch since Settings rendered it.
    this.#simkl();
    if (!cached || this.#simklApproval?.id !== approvalId || cached.id !== approvalId)
      throw authorityError('conflict', 'SIMKL removal approvals changed; review them again');
    const pending = this.#log.pendingActions;
    if (!(await approveSimklRemovalsWithClock(this.#log, this.#clock, cached.shown))) {
      this.#simklApproval = undefined;
      throw authorityError('conflict', 'SIMKL removal approvals changed; review them again');
    }
    this.#simklApproval = undefined;
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'simkl' }]),
    };
  }

  async #patchSettings(
    name: string,
    changes: Record<string, ConfigValue | null>,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const row = this.#changedSettingsRow(name, changes, await this.#settingsStamp());
    return row ? this.#writeRow(row, affected) : this.#unchanged();
  }

  async #settingsStamp() {
    await this.#clock.see(this.#log.newestStamp());
    return this.#clock.issue();
  }

  #changedSettingsRow(
    name: string,
    changes: Record<string, ConfigValue | null | undefined>,
    at: Stamped<ConfigValue | null>['at'],
  ): SettingsRow | null {
    const base = this.#log.settings(name) ?? {
      kind: 'set' as const,
      schema: 2,
      name,
      values: {},
    };
    const changed = Object.entries(changes).filter(
      (entry): entry is [string, ConfigValue | null] =>
        entry[1] !== undefined && !sameConfig(base.values[entry[0]]?.value ?? null, entry[1]),
    );
    if (!changed.length) return null;
    const values = { ...base.values };
    for (const [setting, settingValue] of changed) values[setting] = { value: settingValue, at };
    return { ...base, values };
  }

  async #enqueueDownload(
    command: Extract<LibraryCommand, { kind: 'download.enqueue' }>,
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    const saved = await this.#downloadsCoordinator.enqueueIdentity(
      internalDownloadTitle(command.title),
      command.release.identity,
      command.candidates,
    );
    if (!saved) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'downloads' }]),
    };
  }

  async #removeDownload(target: DownloadTarget): Promise<LibraryAuthorityCommandResult> {
    const download = this.#download(target);
    if (!download) return this.#unchanged();
    const pending = this.#log.pendingActions;
    const state = this.#downloadsCoordinator.status(download).state;
    const cancel = downloadIsInFlight(state);
    if (!(await this.#downloadsCoordinator.remove(download, cancel))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'downloads' }]),
    };
  }

  async #tryDownloadRelease(
    target: DownloadTarget,
    identity: string,
  ): Promise<LibraryAuthorityCommandResult> {
    const download = this.#download(target);
    if (!download) throw authorityError('not-found', 'download is no longer in the queue');
    if (identity === download.release.identity || identity === download.release.hedge?.identity)
      return this.#unchanged();
    if (download.release.hedge)
      throw authorityError('conflict', 'download is already trying an alternate release', true);
    const pending = this.#log.pendingActions;
    const saved = await this.#downloadsCoordinator.tryReleaseIdentity(download, identity);
    if (!saved) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, [{ kind: 'downloads' }]),
    };
  }

  #download(target: DownloadTarget): Download | null {
    const name = downloadName(
      contentKey(
        target.type,
        target.id,
        target.type === 'tv' ? target.season : undefined,
        target.type === 'tv' ? target.episode : undefined,
      ),
    );
    const row = this.#log.settings(name);
    return row ? readDownload(row) : null;
  }

  #preparePlayback(title: TitleRef, requested?: EpisodeRef): LibraryQueryResult {
    if (requested) {
      if (!sameTitle(title, requested))
        throw authorityError('invalid-request', 'episode does not belong to the title');
      const progress = episodeProgress(
        this.#log.episode(requested, requested.season, requested.episode),
        this.#log.title(title),
      );
      const row = this.#log.episode(requested, requested.season, requested.episode);
      return {
        kind: 'playback.prepare',
        action: progress > RESUME_FLOOR && progress < WATCHED ? 'resume' : 'start',
        target: requested,
        resume:
          progress > RESUME_FLOOR && progress < WATCHED
            ? {
                fraction: progress,
                ...(row?.progress.seconds !== undefined ? { seconds: row.progress.seconds } : {}),
              }
            : null,
      };
    }
    if (title.type === 'movie') {
      const movie = { type: 'movie' as const, id: title.id };
      const row = this.#log.title(title);
      const progress = row && !row.deleted.value ? row.resume.value : 0;
      return {
        kind: 'playback.prepare',
        action: progress > RESUME_FLOOR && progress < WATCHED ? 'resume' : 'start',
        target: movie,
        resume:
          progress > RESUME_FLOOR && progress < WATCHED
            ? {
                fraction: progress,
                ...(row?.resume.seconds !== undefined ? { seconds: row.resume.seconds } : {}),
              }
            : null,
      };
    }
    const coordinates = this.#coordinates(title);
    if (!this.#shapes.has(titleKey(title)) || !coordinates.length)
      throw authorityError('not-ready', 'title shape is required to prepare series playback', true);
    const titleRow = this.#log.title(title);
    const latest = coordinates
      .map((coordinate) => ({
        ...coordinate,
        row: this.#log.episode(title, coordinate.season, coordinate.episode),
      }))
      .filter(({ row }) => row && episodeProgress(row, titleRow) > RESUME_FLOOR)
      .sort(
        (a, b) =>
          compareStamps(b.row!.progress.at, a.row!.progress.at) ||
          b.season - a.season ||
          b.episode - a.episode,
      )[0];
    if (!latest)
      return {
        kind: 'playback.prepare',
        action: 'start',
        target: { ...title, ...coordinates[0]! },
        resume: null,
      };
    const fraction = episodeProgress(latest.row, titleRow);
    if (fraction < WATCHED)
      return {
        kind: 'playback.prepare',
        action: 'resume',
        target: { ...title, season: latest.season, episode: latest.episode },
        resume: {
          fraction,
          ...(latest.row?.progress.seconds !== undefined
            ? { seconds: latest.row.progress.seconds }
            : {}),
        },
      };
    const index = coordinates.findIndex(
      ({ season, episode }) => season === latest.season && episode === latest.episode,
    );
    const next = coordinates[index + 1];
    return {
      kind: 'playback.prepare',
      action: next ? 'next' : 'start',
      target: { ...title, ...(next ?? coordinates[0]!) },
      resume: null,
    };
  }

  async #writeAction(
    journal: SettingsRow,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    const written = await this.#log.writeAction(journal);
    if (!written) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  async #writeActions(
    journals: SettingsRow[],
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    if (!journals.length) return this.#unchanged();
    const pending = this.#log.pendingActions;
    if (!(await this.#log.writeActions(journals))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  async #writeRow(
    row: TitleRow | EpisodeRow | SettingsRow,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    if (!(await this.#log.write(row))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  async #writeRows(
    rows: SettingsRow[],
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    if (!(await this.#log.writeRows(rows))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#delivery(pending),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  #withPendingStatus(
    pendingBefore: number,
    affected: LibraryAffectedSelection[],
  ): LibraryAffectedSelection[] {
    if (
      this.#log.pendingActions === pendingBefore ||
      affected.some(({ kind }) => kind === 'connections' || kind === 'all')
    )
      return affected;
    return [...affected, { kind: 'connections' }];
  }

  #delivery(pendingBefore: number): Delivery {
    if (this.#options.mode === 'local') return 'local';
    return this.#log.pendingActions > pendingBefore ? 'queued' : 'synced';
  }

  #idleDelivery(): Delivery {
    return this.#options.mode === 'local' ? 'local' : 'synced';
  }

  #unchanged(): LibraryAuthorityCommandResult {
    return { outcome: 'unchanged', delivery: this.#idleDelivery(), affected: [] };
  }

  #affected(
    title: TitleRef,
    affectsContinue = true,
    affectsHistory = true,
  ): LibraryAffectedSelection[] {
    return [
      { kind: 'title', title },
      { kind: 'presence', title },
      { kind: 'overview' },
      ...(affectsHistory ? ([{ kind: 'history' }] as const) : []),
      ...(affectsContinue ? ([{ kind: 'continue' }] as const) : []),
    ];
  }

  #writable(): void {
    if (this.#log.moved) throw authorityError('moved', 'library moved to another key');
    if (this.#log.readOnly)
      throw authorityError('read-only', 'library is read-only until it can be upgraded');
  }

  #writeFailed(): never {
    if (this.#log.moved) throw authorityError('moved', 'library moved to another key');
    if (this.#log.readOnly)
      throw authorityError('read-only', 'library is read-only until it can be upgraded');
    if (this.#log.refusal)
      throw authorityError('refused', `library write was refused: ${this.#log.refusal}`);
    throw authorityError('unavailable', 'library write could not be saved', true);
  }
}
