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
  type DownloadRaceEntry,
  type DownloadRelease,
} from './downloadRows';
import { seenEpisodesFor, watchedHistory } from './history';
import { MaterializedHistoryIndex, type HistoryIndexSource } from './historyIndex';
import { projectDocument } from './libraryV4';
import { titleCoordinates, titleView } from './titleView';
import { continueItems, projectHomeLibraryView, type HomeLibraryView } from './homeLibraryView';
import { noteLibraryFold } from './libraryStartupMetrics';
import {
  libraryMetadataShape,
  libraryMetadataShapeDigest,
  libraryMetadataTitle,
} from './libraryMetadata';
import { FinishedLibraryViewWriter } from './finishedLibraryViewWriter';
import {
  ContinueProjector,
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
import { LibraryLog, LibraryStartRefused, type DeferredDelivery } from './log';
import { LibraryAdminAuthority } from './libraryAdminAuthority';
import {
  ASSISTANT_RECORDS,
  LibraryAssistantAuthority,
  randomHex,
  type AssistantRecords,
} from './libraryAssistantAuthority';
import {
  selectedDevicesView,
  selectedRuntimeView,
  selectedSettingsView,
} from './librarySelectedSettings';
import type { Vault } from './localVault';
import { keptSomething } from './localLibraryMove';
import type { ContentReader } from './contentAuthority';
import { ProfileKidCreateCoordinator, ProfileKidCreateStore } from './profileKidCreateWorker';
import { profilesApplyPolicy } from './profilesCore';
import { exclusive } from './exclusive';
import { joinHousehold, joinHouseholdOf, type JoinState } from './householdJoin';
import { validateStoredProfileDirectory } from './profileDirectory';
import {
  ProfileKeyResetService,
  ProfileResetUnauthorizedError,
  VaultResetAdoption,
} from './profileKeyResetService';
import { acceptsAddonURL, readApiKey, readPlugins } from './prefs';
import { ADDRESSES, healed, readPrivateAddresses, storable } from './privateAddresses';
import { syncPolicy } from './syncCore';
import { ensureDeferredSyncPolicy } from './syncLoader';
import { recordTrackerEvent } from './trackerEvents';
import { retryAfterMs } from './retryAfter';
import {
  approveSimklRemovalsWithClock,
  heldSimklRemovals,
  type HeldRemovals,
} from './simklDelivery';
import { fetchSimklClientId, simklAccountID } from '../settings/simkl';
import { isRetainedServices } from './libraryServiceProtocolCodec';
import {
  RETAINED_HOME_SHELVES,
  RETAINED_PREFERENCE_SEED,
  RETAINED_SERVICES,
  retainedBillboardName,
  retainedBillboardValue,
  storedBillboardValue,
} from './libraryRetainedViews';
import {
  change as preferenceChange,
  forgetDevice,
  hashPin,
  parsePublicKey,
  pinMatches,
  readDevices,
  readServers,
  readTrust,
  selfEntry,
  type PrefChanges,
} from '../settings/values';
import {
  compareStamps,
  rowName,
  type ConfigValue,
  type DocumentRow,
  type EpisodeRow,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
  type Stamped,
} from './wire';

type Delivery = 'synced' | 'queued' | 'local';

/** The Kid journal's operation id for the Kid a household gets out of the box: one per household on this device. */
const DEFAULT_KID_OPERATION = 'default-kid';
/**
 * Titles one naming batch looks up at once. Most are answered from this browser's TMDB cache, and asked together
 * their reads share a few IndexedDB transactions (`tmdbCache.ts` `coalesced`); a miss goes to den-edge's shared cache
 * over one multiplexed connection. Six at a time made Home's first shelves wait on a round trip per six series.
 */
const METADATA_LOOKUPS = 16;
const MAX_TIMER_MS = 2_147_483_647;

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
  /** The Worker's single metadata authority; library projection must not create a second provider client. */
  content: Pick<ContentReader, 'title'>;
  libraryKey?: string;
  vault?: Vault;
  /** False for a narrow edit authority: its surrounding fact authority owns the saved projections. */
  savedViews?: boolean;
  fetchImpl?: typeof fetch;
  destination?: (key: string) => Promise<LibraryLog>;
  refreshDownloads?: (target?: DownloadTarget) => Promise<boolean>;
  downloadArtwork?: (target: DownloadTarget) => Promise<string | null>;
}

const sameTitle = (a: TitleRef, b: TitleRef): boolean => a.type === b.type && a.id === b.id;

const sameConfig = (a: ConfigValue | null, b: ConfigValue | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

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

const publicRelease = (
  release: DownloadRelease | DownloadRaceEntry,
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
    ...(title.airDate !== undefined ? { airDate: title.airDate } : {}),
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
  /** Moves on whenever a shape is learnt or changes: an assistant projection's Continue Watching reads them. */
  #shapesVersion = 0;
  readonly #continueProjector = new ContinueProjector();
  readonly #log: LibraryLog;
  readonly #clock: ClockStore;
  readonly #options: LibraryLogAuthorityOptions;
  readonly #downloadsCoordinator: DownloadCoordinator;
  readonly #fetch: typeof fetch;
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
  readonly #assistant: LibraryAssistantAuthority;
  /**
   * While an assistant's request is performed: the stamp its writes take, the request's own time (assistant v1 §6),
   * in place of a freshly issued one, so it never overrides a change made after it.
   */
  #asOf: Stamp | null = null;
  #projection?: { rows: Row[]; home: HomeLibraryView };
  /** Compact one-pass index of authoritative documents; exact episode arrays are still projected only on demand. */
  #historyDocuments?: { version: number; byTitle: Map<string, DocumentRow[]> };
  #historyIndex?: MaterializedHistoryIndex;
  #projectionTimer?: ReturnType<typeof setTimeout>;
  #projectionDeadline = Infinity;
  #closed = false;
  readonly #viewWriter?: FinishedLibraryViewWriter;
  #kidCreate?: ProfileKidCreateCoordinator;
  #keyReset?: ProfileKeyResetService;

  constructor(log: LibraryLog, clock: ClockStore, options: LibraryLogAuthorityOptions) {
    this.#log = log;
    this.#clock = clock;
    this.#options = options;
    this.#downloadsCoordinator = options.downloads;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    log.onDeferred = (delivery) => this.#deferred(delivery);
    if (
      options.mode === 'online' &&
      options.savedViews !== false &&
      options.libraryKey &&
      options.vault
    ) {
      const facts = log.libraryFacts();
      if (facts) {
        this.#viewWriter = new FinishedLibraryViewWriter(
          options.libraryKey,
          options.vault,
          facts,
          () => ({
            generation: this.#log.currentGeneration ?? null,
            head: this.#log.logHead,
            // The durable facts derive Home. The live log can be ahead of them with pending work, but title shapes are
            // independent metadata and safe to lend for Continue's layout projection.
            shapes: new Map([...this.#shapes].map(([key, stored]) => [key, stored.shape])),
          }),
        );
        this.#viewWriter.schedule();
      }
    }
    if (options.libraryKey && options.vault)
      this.#admin = new LibraryAdminAuthority(log, clock, {
        mode: options.mode,
        libraryKey: options.libraryKey,
        vault: options.vault,
        fetchImpl: options.fetchImpl,
        destination: options.destination,
      });
    this.#assistant = new LibraryAssistantAuthority({
      libraryId: log.libraryId,
      get device() {
        return clock.device;
      },
      settings: (name) => this.#log.settings(name),
      refresh: async () => void (await this.#log.refresh()),
      command: async (command, operationId, stamp) => {
        this.#asOf = stamp;
        try {
          return await this.command(command, operationId);
        } finally {
          this.#asOf = null;
        }
      },
      ride: async (name, changes, work) => {
        const row = this.#changedSettingsRow(name, changes, await this.#settingsStamp());
        if (!row) return work();
        let result!: Awaited<ReturnType<typeof work>>;
        const rode = await this.#log.withRider(row, async () => {
          result = await work();
        });
        // The edit made nothing to ride with: the entry is written on its own, straight after.
        if (!rode) await this.#writeRow(row, []);
        return result;
      },
      loadRecords: () => this.#log.kept<AssistantRecords>(ASSISTANT_RECORDS),
      saveRecords: (records) => this.#log.keep(ASSISTANT_RECORDS, records),
      loadShape: async (title) => {
        if (!this.#shapes.has(titleKey(title))) await this.#libraryMetadata([title]);
        return this.#shapes.has(titleKey(title));
      },
      seasonEpisodes: async (title, season) => {
        if (!this.#shapes.has(titleKey(title))) await this.#libraryMetadata([title]);
        const shape = this.#shapes.get(titleKey(title))?.shape;
        if (!shape) return null;
        return Array.from(
          { length: shape.counts.get(season) ?? 0 },
          (_, index) => index + 1,
        ).filter((episode) => isAired({ season, episode }, shape.lastAired));
      },
      patch: async (name, changes) => {
        const written = await this.#patchSettings(name, changes, []);
        if (written.delivery === 'queued')
          throw authorityError(
            'unavailable',
            'the library change has not reached den-edge yet',
            true,
          );
        return written.affected;
      },
      replace: async (row) => void (await this.#writeRow(row, [])),
      putDropbox: async (key) => {
        const member = await this.#log.relayMembership();
        if (!member) return false;
        try {
          const res = await this.#fetch('/assistant/dropbox', {
            method: 'PUT',
            headers: {
              'content-type': 'application/json',
              'x-den-library-member': `${member.libraryId}:${member.memberToken}`,
            },
            body: JSON.stringify({ pk: key.public }),
          });
          return res.ok;
        } catch {
          return false;
        }
      },
      documents: () => this.#log.documents().map(({ document }) => document),
      layouts: () =>
        Object.fromEntries(
          [...this.#shapes]
            .filter(([key]) => key.startsWith('tv:'))
            .map(([key, { shape }]) => [
              key.slice('tv:'.length),
              {
                seasons: [...shape.counts]
                  .sort(([a], [b]) => a - b)
                  .map(([season, episodes]) => ({ season, episodes })),
                last_aired: shape.lastAired ?? null,
              },
            ]),
        ),
      head: () => this.#log.logHead,
      inputs: () => `${this.#log.rowsVersion}:${this.#log.logHead}:${this.#shapesVersion}`,
      putProjection: async (grant, set, parts, member) => {
        const res = await this.#memberSend(
          `/assistant/projection/${grant}`,
          'PUT',
          { set, parts },
          member,
        );
        if (res?.status === 429) return { retryAfterMs: retryAfterMs(res, 60_000) };
        return res?.ok ?? false;
      },
      deleteProjection: async (grant, member) =>
        (await this.#memberSend(`/assistant/projection/${grant}`, 'DELETE', undefined, member))
          ?.ok ?? false,
      membership: () => this.#log.relayMembership(),
      now: () => Date.now(),
      random: randomHex,
    });
    this.#scheduleProjectionReconsideration();
  }

  /**
   * A member route of den-edge's (`/assistant/…`), with this library's proof, or a lent household connection's:
   * its answer, or null when there is no proof or no answer.
   */
  async #memberSend(
    path: string,
    method: string,
    body?: unknown,
    lent?: { libraryId: string; memberToken: string },
  ): Promise<Response | null> {
    const member = lent ?? (await this.#log.relayMembership());
    if (!member) return null;
    try {
      return await this.#fetch(path, {
        method,
        headers: {
          'x-den-library-member': `${member.libraryId}:${member.memberToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  get generation(): string | null {
    return this.#log.currentGeneration ?? null;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#projectionTimer = undefined;
    this.#listeners.clear();
    this.#log.onDeferred = null;
    this.#admin?.close();
    await this.#viewWriter?.close();
    this.#log.close();
  }

  listen(listener: (event: LibraryAuthorityEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
    this.#scheduleProjectionReconsideration();
    if (selection.kind === 'simkl') await ensureDeferredSyncPolicy();
    switch (selection.kind) {
      case 'overview':
        return this.#overview();
      case 'watchlist': {
        const overview = this.#overview();
        const history = this.#materializedHistory();
        return {
          kind: 'watchlist',
          titles: overview.watchlist.filter(
            (title) => title.type !== 'tv' || history.episodeCount(title) === 0,
          ),
        };
      }
      case 'recommendations': {
        const { kind: _kind, watchlist: _watchlist, ...recommendations } = this.#overview();
        return { kind: 'recommendations', ...recommendations };
      }
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
      case 'devices':
        return this.#devices();
      case 'connections':
        return this.#connections();
      case 'simkl':
        return this.#simkl();
      case 'recovery':
        return this.#administration().recoveryView();
      case 'runtime':
        return this.#runtime();
      case 'profiles':
        return this.#profiles();
      case 'downloads':
        return this.#downloads();
    }
  }

  async command(
    command: LibraryCommand,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    this.#writable();
    await ensureDeferredSyncPolicy();
    try {
      const result = await this.#command(command, operationId);
      if (result.outcome === 'applied') this.#updateHistoryIndex(result.affected, command);
      return result;
    } finally {
      this.#scheduleProjectionReconsideration();
    }
  }

  #command(command: LibraryCommand, operationId: string): Promise<LibraryAuthorityCommandResult> {
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
      case 'preferences.seed':
        return this.#seedPreferences(command.household);
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
        return this.#heartbeatDevice(
          command.name,
          command.deviceKind,
          command.playKey,
          command.controlVersion,
        );
      case 'device.played':
        return this.#markPlayed();
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
      case 'download.want':
        return this.#wantDownload(command.title);
      case 'download.remove':
        return this.#removeDownload(command.target);
      case 'download.release.try':
        return this.#tryDownloadRelease(command.target, command.identity);
    }
  }

  async query(query: LibraryQuery): Promise<LibraryQueryResult> {
    if (query.kind === 'profile-create.status' || query.kind === 'key-reset.prepare')
      await ensureDeferredSyncPolicy();
    switch (query.kind) {
      case 'playback.prepare':
        return this.#preparePlayback(query.title, query.episode);
      case 'parental-pin.verify': {
        const stored = readApiKey(this.#log.settings('keys'), 'parentalPIN');
        return {
          kind: 'parental-pin.verify',
          matches:
            this.#parentalPinDelivery() !== 'queued' &&
            !!stored &&
            (await pinMatches(stored, query.pin)),
        };
      }
      case 'profile-create.status': {
        const result = await this.#profileKidCreate().resume();
        return result
          ? { kind: 'profile-create.status', phase: 'created', ...result }
          : { kind: 'profile-create.status', phase: 'idle' };
      }
      case 'relay.membership':
        return { kind: 'relay.membership', capability: await this.#log.relayMembership() };
      case 'key-reset.prepare':
        return this.#administration().prepareReset();
      case 'recovery.seal':
        return this.#administration().sealRecovery(query.locator, query.wrapKey, query.createdAt);
      case 'pairing.handover':
        return this.#administration().pairingHandover(
          query.handoverKey,
          query.host,
          query.linkKey,
          query.grantTicket,
        );
      case 'history.export':
        return this.#administration().historyExport();
      case 'history.episodes': {
        const index = this.#materializedHistory();
        if (query.revision !== index.revision)
          return { kind: 'history.episodes', revision: index.revision, stale: true, items: [] };
        const requested = new Set(query.titles.map(titleKey));
        const documents = this.#historyDocumentsByTitle();
        const now = Date.now();
        const rows = query.titles.flatMap((title) =>
          (documents.get(titleKey(title)) ?? []).flatMap((document) =>
            projectDocument(document, now),
          ),
        );
        const seen = seenEpisodesFor(rows, requested);
        return {
          kind: 'history.episodes',
          revision: index.revision,
          stale: false,
          items: query.titles.map((title) => ({
            title,
            seen: seen.get(titleKey(title)) ?? [],
          })),
        };
      }
      case 'history.page': {
        const index = this.#materializedHistory();
        const current = query.revision === index.revision;
        const page = current
          ? index.page(query.filter, query.cursor, query.limit)
          : index.page(query.filter, undefined, query.limit);
        return {
          kind: 'history.page',
          restarted: !current || page === null,
          page: page ?? index.page(query.filter, undefined, query.limit)!,
        };
      }
      case 'library.metadata':
        return this.#libraryMetadata(query.titles);
      case 'assistant.grants':
        return { kind: 'assistant.grants', ...(await this.#assistant.grants()) };
      case 'assistant.connection':
        return {
          kind: 'assistant.connection',
          connection: this.#options.mode === 'local' ? null : await this.#assistant.lend(),
        };
      case 'download.refresh':
        return {
          kind: 'download.refresh',
          refreshed: (await this.#options.refreshDownloads?.(query.target)) ?? false,
        };
      case 'download.sources': {
        await ensureDeferredSyncPolicy();
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
      case 'preferences.raw':
        // Profile seeding only needs the values, but a local-library handoff also uses this full-authority query as
        // its source barrier. Make the snapshot another authority will reopen include every accepted local edit.
        if (this.#options.mode === 'local') await this.#log.settlePersistence();
        return { kind: 'preferences.raw', values: this.#log.settings('prefs')?.values ?? {} };
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

  #profileKidCreate(): ProfileKidCreateCoordinator {
    if (this.#kidCreate) return this.#kidCreate;
    const store = new ProfileKidCreateStore(this.#log);
    this.#kidCreate = new ProfileKidCreateCoordinator(this.#log.libraryId, store, {
      hasActiveOwner: () => {
        const directory = this.#log.profileDirectory();
        const owner = directory?.profiles[directory.owner];
        return owner?.role === 'owner' && !owner.deleted.value;
      },
      readDirectory: () => this.#log.readKidProfileDirectory(),
      createAndVerifyProfileLibrary: (journal) =>
        this.#log.createAndVerifyKidProfileLibrary(journal),
      casDirectory: (authority, directory) =>
        this.#log.casKidProfileDirectory(authority, directory),
      retireProfileLibrary: (journal) => this.#log.retireKidProfileLibrary(journal),
      adoptDirectory: (directory) => this.#log.adoptKidProfileDirectory(directory),
      proveProfileResult: (result) => this.#log.proveKidProfileResult(result),
    });
    return this.#kidCreate;
  }

  /** Built only for an explicit worker task; the reset source route is its own deployment gate. */
  #profileKeyReset(): ProfileKeyResetService {
    if (this.#keyReset) return this.#keyReset;
    const { libraryKey, vault } = this.#options;
    if (!libraryKey) throw authorityError('invalid-request', 'the household key is not available');
    this.#keyReset = new ProfileKeyResetService({
      vault: this.#log,
      householdKey: libraryKey,
      device: this.#clock.device,
      open: (key, wire) => LibraryLog.forReset(key, wire, this.#fetch, undefined, vault ?? null),
      adoption: new VaultResetAdoption(this.#log, (key) =>
        (this.#options.destination ?? ((next) => LibraryLog.destination(next, this.#fetch)))(key),
      ),
      gate: async () => {
        try {
          const answer = await this.#log.resetRequest({
            method: 'GET',
            path: `/lib/${this.#log.libraryId}/exclusive-operation/source`,
          });
          return answer.status === 200;
        } catch (error) {
          // A refused or unreachable source read keeps the reset closed; it is not an answer to guess past.
          console.warn('den: the profile reset gate could not be read', error);
          return false;
        }
      },
      ownerPin: (pin) => this.#ownerPinMatches(pin),
    });
    return this.#keyReset;
  }

  async #profileKeyResetTask(
    task: Extract<LibraryTask, { kind: `profile-key-reset.${string}` }>,
  ): Promise<LibraryAuthorityTaskResult> {
    if (
      task.kind === 'profile-key-reset.start' &&
      task.destinationLibraryKey === this.#options.libraryKey
    )
      throw authorityError('invalid-request', 'source and destination library must differ');
    const service = this.#profileKeyReset();
    let outcome;
    try {
      outcome =
        task.kind === 'profile-key-reset.start'
          ? await service.start(task)
          : task.kind === 'profile-key-reset.resume'
            ? await service.resume()
            : task.kind === 'profile-key-reset.confirm'
              ? await service.confirm(task)
              : await service.recover(task);
    } catch (error) {
      if (error instanceof ProfileResetUnauthorizedError)
        throw authorityError('unauthorized', 'Owner PIN is required to reset a profile household');
      throw error;
    }
    return { result: { kind: task.kind, outcome }, affected: [{ kind: 'profiles' }] };
  }

  async task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult> {
    try {
      return await this.#task(task, operationId);
    } finally {
      this.#scheduleProjectionReconsideration();
    }
  }

  async #task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult> {
    // Settling or explicitly adopting a reset necessarily starts from a log that may already report `moved`, and so
    // does continuing a compound reset: it retires the very household this log belongs to.
    if (
      task.kind !== 'key-reset.settle' &&
      task.kind !== 'key-reset.adopt' &&
      task.kind !== 'profile-key-reset.resume' &&
      task.kind !== 'profile-key-reset.confirm'
    )
      this.#writable();
    await ensureDeferredSyncPolicy();
    if (task.kind.startsWith('assistant.')) return this.#assistantTask(task);
    if (
      task.kind === 'profile-key-reset.start' ||
      task.kind === 'profile-key-reset.resume' ||
      task.kind === 'profile-key-reset.confirm' ||
      task.kind === 'profile-key-reset.recover'
    )
      return this.#profileKeyResetTask(task);
    if (task.kind === 'household.create') return this.#createHousehold(task);
    if (task.kind === 'profile.create-default') return this.#createDefaultKid();
    if (task.kind === 'household.join') return this.#joinHousehold(task);
    if (task.kind === 'profile.create') return this.#profileCreateTask(task, operationId);
    if (task.kind === 'profile.policy.set') return this.#profilePolicyTask(task);
    if (task.kind === 'kid-title-approval.set') return this.#kidTitleApprovalTask(task);
    if (task.kind === 'profile.create.ack') {
      await this.#profileKidCreate().acknowledge(task.receipt);
      return {
        result: { kind: 'profile.create.ack', outcome: 'acknowledged' },
        affected: [],
      };
    }
    if (
      ((task.kind === 'key-reset.move' ||
        task.kind === 'key-reset.settle' ||
        task.kind === 'key-reset.adopt') &&
        task.destinationLibraryKey === this.#options.libraryKey) ||
      (task.kind === 'local-library.merge' && task.sourceLibraryKey === this.#options.libraryKey)
    )
      throw authorityError('invalid-request', 'source and destination library must differ');
    const result = await this.#administration().task(task, operationId);
    return result;
  }

  /** The Owner PIN, only once it is delivered to every device: a queued PIN is not yet the household's. */
  async #ownerPinMatches(pin: string): Promise<boolean> {
    const stored = readApiKey(this.#log.settings('keys'), 'parentalPIN');
    return this.#parentalPinDelivery() === 'synced' && !!stored && (await pinMatches(stored, pin));
  }

  /**
   * Change a Kid's content policy: a stamped directory operation (den-core `profiles_apply`) written with the same
   * exact-row compare-and-swap as creating a Kid, behind the Owner PIN. A conflict or a lost response is read again,
   * and a policy the directory already holds is left as it is.
   */
  async #profilePolicyTask(
    task: Extract<LibraryTask, { kind: 'profile.policy.set' }>,
  ): Promise<LibraryAuthorityTaskResult> {
    if (!(await this.#ownerPinMatches(task.pin)))
      throw authorityError(
        'unauthorized',
        'Owner PIN is required to change a Kid’s content policy',
      );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { directory, authority } = await this.#log.readKidProfileDirectory();
      const entry = directory.profiles[task.profile];
      if (!entry || entry.role !== 'kid' || entry.deleted.value)
        throw authorityError('invalid-request', 'that is not a live Kid profile');
      if (
        entry.policy.value.maximumAge === task.maximumAge &&
        entry.policy.value.unknownRatings === task.unknownRatings
      )
        return {
          result: { kind: 'profile.policy.set', outcome: 'unchanged' },
          affected: [{ kind: 'profiles' }],
        };
      const next = profilesApplyPolicy({
        document: directory,
        profile: task.profile,
        maximumAge: task.maximumAge,
        unknownRatings: task.unknownRatings,
        at: await this.#clock.issue(),
      });
      if ((await this.#log.casKidProfileDirectory(authority, next)) === 'committed')
        return {
          result: { kind: 'profile.policy.set', outcome: 'changed' },
          affected: [{ kind: 'profiles' }],
        };
    }
    throw authorityError('conflict', 'the profile directory kept changing; try again');
  }

  async #kidTitleApprovalTask(
    task: Extract<LibraryTask, { kind: 'kid-title-approval.set' }>,
  ): Promise<LibraryAuthorityTaskResult> {
    if (!(await this.#ownerPinMatches(task.pin)))
      throw authorityError('unauthorized', 'Owner PIN is required to change Kid title access');
    const title = `${task.title.type}:${task.title.id}`;
    const wanted: 'allow' | 'tombstone' = task.allow ? 'allow' : 'tombstone';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.#log.readKidTitleApprovals(task.profile);
      if (current.document?.approvals[title]?.value === wanted)
        return {
          result: { kind: 'kid-title-approval.set', outcome: 'unchanged' },
          affected: [{ kind: 'profiles' }],
        };
      const next = {
        ...(current.document ?? {
          format: 4 as const,
          kind: 'kid-title-approvals' as const,
          schema: 1 as const,
          kid: task.profile,
          approvals: {},
        }),
        approvals: {
          ...(current.document?.approvals ?? {}),
          [title]: { value: wanted, at: await this.#clock.issue() },
        },
      };
      if (
        (await this.#log.casKidTitleApprovals(
          { base: current.base, generation: current.generation },
          next,
          current.directory,
        )) === 'committed'
      )
        return {
          result: { kind: 'kid-title-approval.set', outcome: 'changed' },
          affected: [{ kind: 'profiles' }],
        };
    }
    throw authorityError('conflict', 'Kid title access kept changing; try again');
  }

  async #profileCreateTask(
    task: Extract<LibraryTask, { kind: 'profile.create' }>,
    operationId: string,
  ): Promise<LibraryAuthorityTaskResult> {
    if (!(await this.#ownerPinMatches(task.pin)))
      throw authorityError('unauthorized', 'Owner PIN is required to create a Kid profile');
    const stamps = [
      await this.#clock.issue(),
      await this.#clock.issue(),
      await this.#clock.issue(),
      await this.#clock.issue(),
    ] as const;
    const result = await this.#profileKidCreate().begin(
      operationId,
      task.name,
      task.maximumAge,
      stamps,
    );
    return {
      result: { kind: 'profile.create', outcome: 'created', ...result },
      affected: [{ kind: 'profiles' }],
    };
  }

  /**
   * A browser's own household (den#295), started or finished from the library kept only here: the page keeps the
   * plan before it asks, and asking again with it finishes what a cut-off run began (`LibraryLog.createBornHousehold`).
   */
  async #createHousehold(
    task: Extract<LibraryTask, { kind: 'household.create' }>,
  ): Promise<LibraryAuthorityTaskResult> {
    if (task.ifKept && !keptSomething(this.#log.rows()))
      return { result: { kind: 'household.create', outcome: 'empty' }, affected: [] };
    const household = await LibraryLog.destination(
      task.householdKey,
      this.#fetch,
      undefined,
      this.#options.vault ?? null,
      5,
    );
    try {
      await household.createBornHousehold({
        attempt: task.attempt,
        ownerProfile: task.ownerProfile,
        ownerKey: task.ownerKey,
        createdAt: task.createdAt,
      });
    } catch (error) {
      const throttled =
        error instanceof LibraryStartRefused &&
        (error.status === 429 || error.status === 503 || error.status === 413);
      const refused = error instanceof LibraryStartRefused && error.status === 403;
      console.warn('den: this browser’s household could not be started yet', error);
      return {
        result: {
          kind: 'household.create',
          outcome: refused ? 'refused' : throttled ? 'throttled' : 'unavailable',
          ...(throttled ? { retryAfterMs: Math.round(error.retryAfterMs) } : {}),
        },
        affected: [],
      };
    }
    return { result: { kind: 'household.create', outcome: 'created' }, affected: [] };
  }

  /**
   * Every profile household has a Kid out of the box (den#295): made here, once, when the directory den-edge holds
   * has no live Kid. No Owner PIN is asked, since a household born in a browser has none until the first switch to
   * Kid sets it. It is the Kid journal's creation (`profile.create` without the PIN), so a run cut off anywhere is
   * finished by the next, and its fixed operation id never makes a second Kid on this device.
   */
  async #createDefaultKid(): Promise<LibraryAuthorityTaskResult> {
    const kids = this.#profileKidCreate();
    // A creation this device left pending or unacknowledged is finished first; it may be the default Kid itself.
    const earlier = await kids.resume();
    if (earlier) await kids.acknowledge(earlier.receipt);
    const { directory } = await this.#log.readKidProfileDirectory();
    if (
      Object.values(directory.profiles).some(
        (profile) => profile.role === 'kid' && !profile.deleted.value,
      )
    )
      // The fresh read may have brought a Kid this page has not seen yet: the directory is published again.
      return {
        result: { kind: 'profile.create-default', outcome: 'present' },
        affected: [{ kind: 'profiles' }],
      };
    const stamps = [
      await this.#clock.issue(),
      await this.#clock.issue(),
      await this.#clock.issue(),
      await this.#clock.issue(),
    ] as const;
    const created = await kids.begin(DEFAULT_KID_OPERATION, 'Kids', 12, stamps);
    await kids.acknowledge(created.receipt);
    return {
      result: { kind: 'profile.create-default', outcome: 'created' },
      affected: [{ kind: 'profiles' }],
    };
  }

  /**
   * This browser's own household joins this one (den#295, `householdJoin.ts`). Run under one lock per source, so a
   * second tab waits and then finds the work done. The progress is kept sealed under this household's key on this
   * device; den-edge is read afresh for everything else.
   */
  async #joinHousehold(
    task: Extract<LibraryTask, { kind: 'household.join' }>,
  ): Promise<LibraryAuthorityTaskResult> {
    if (this.#options.mode !== 'online' || task.sourceLibraryKey === this.#options.libraryKey)
      throw authorityError('invalid-request', 'only a household den-edge holds joins another');
    const vault = this.#options.vault ?? null;
    const open = (key: string, wire: 4 | 5) =>
      LibraryLog.forReset(key, wire, this.#fetch, undefined, vault);
    const source = await open(task.sourceLibraryKey, 5);
    const name = `household-join/v1/${source.libraryId}`;
    const binding = `household-join:${this.#log.libraryId}:1`;
    const directory = async (log: LibraryLog) => {
      const read = await log.readDirectory();
      if (read === 'gone' || read === null) return read;
      validateStoredProfileDirectory(read);
      const household = joinHouseholdOf(read);
      if (!household) throw new Error('The household’s directory has no live Owner');
      return household;
    };
    const result = await exclusive(`den.household.join.${source.libraryId}`, () =>
      joinHousehold(
        {
          state: async () => {
            const kept = await this.#log.keptRequired<JoinState>(name, binding);
            return kept.kind === 'value' ? kept.value : null;
          },
          keep: (state) => this.#log.keepRequired(name, state, binding),
          source: async () => {
            const household = await directory(source);
            // A browser's household always has its directory: without one there is nothing to join from.
            if (household === null) throw new Error('This browser’s household has no directory');
            return household;
          },
          destination: async () => {
            await this.#log.readToHead();
            const household = await directory(this.#log);
            if (household === 'gone') throw new Error('The household joined is not on den-edge');
            return {
              profiles: household,
              pin: !!readApiKey(this.#log.settings('keys'), 'parentalPIN'),
            };
          },
          pinMatches: (pin) => this.#ownerPinMatches(pin),
          documents: async (key) => {
            const read = await (await open(key, 4)).activityDocuments();
            if (read === null) throw new Error('A profile library could not be read whole');
            return read === 'gone' ? { documents: [], head: null } : read;
          },
          take: async (key, documents) =>
            (key === null ? this.#log : await open(key, 4)).takeDocuments(documents),
          createKid: async (operationId, kidName, maximumAge) => {
            const kids = this.#profileKidCreate();
            // A creation this device left pending or unacknowledged is finished first: the journal holds one at a time.
            const earlier = await kids.resume();
            if (earlier) await kids.acknowledge(earlier.receipt);
            const stamps = [
              await this.#clock.issue(),
              await this.#clock.issue(),
              await this.#clock.issue(),
              await this.#clock.issue(),
            ] as const;
            const created = await kids.begin(operationId, kidName, maximumAge, stamps);
            await kids.acknowledge(created.receipt);
            return created.profile;
          },
          retire: async (key, head) =>
            key === null ? source.retire() : (await open(key, 4)).retire(head ?? undefined),
        },
        task.pin,
      ),
    );
    return {
      result: { kind: 'household.join', ...result },
      affected: result.outcome === 'joined' ? [{ kind: 'profiles' }] : [],
    };
  }

  /**
   * Assistant writes live only in a library den-edge holds: a library kept only here has no queue to drain and no
   * den-edge to approve a grant with. Revoking one is always possible.
   */
  async #assistantTask(task: LibraryTask): Promise<LibraryAuthorityTaskResult> {
    if (this.#options.mode === 'local' && task.kind !== 'assistant.revoke')
      throw authorityError('invalid-request', 'a library kept only here takes no assistant writes');
    switch (task.kind) {
      case 'assistant.consent': {
        const keys = await this.#assistant.consent(task.client, task);
        // Settings carries what the page owes assistants: a first connection starts its work there.
        return { result: { kind: 'assistant.consent', ...keys }, affected: [{ kind: 'settings' }] };
      }
      case 'assistant.publish':
        return {
          result: {
            kind: 'assistant.publish',
            published: (await this.#assistant.publish(task.connection ?? null)).length,
          },
          affected: [],
        };
      case 'assistant.revoke':
        return {
          result: { kind: 'assistant.revoke', outcome: await this.#assistant.revoke(task.grant) },
          affected: [{ kind: 'settings' }],
        };
      case 'assistant.renew':
        return {
          result: { kind: 'assistant.renew', renewed: await this.#assistant.renew(task.grants) },
          affected: [{ kind: 'settings' }],
        };
      case 'assistant.apply': {
        const { results, ack, dropbox, affected } = await this.#assistant.apply(
          task.messages,
          task.connection ?? null,
          task.tv ?? null,
        );
        return { result: { kind: 'assistant.apply', results, ack, dropbox }, affected };
      }
      default:
        throw authorityError('invalid-request', 'not an assistant task');
    }
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
    const digest = libraryMetadataShapeDigest(observation);
    const key = titleKey(observation.title);
    if (this.#shapes.get(key)?.digest === digest) return { outcome: 'unchanged', affected: [] };
    this.#shapes.set(key, {
      shape: { counts, ...(observation.lastAired ? { lastAired: observation.lastAired } : {}) },
      digest,
    });
    this.#shapesVersion++;
    this.#viewWriter?.schedule(true);
    return {
      outcome: 'applied',
      affected: [{ kind: 'title', title: observation.title }, { kind: 'continue' }],
    };
  }

  async #libraryMetadata(
    titles: TitleRef[],
  ): Promise<Extract<LibraryQueryResult, { kind: 'library.metadata' }>> {
    const found: Array<{ title: LibraryMetadataTitle; shape?: LibraryMetadataShape }> = [];
    const retryable: TitleRef[] = [];
    let retryAfterMs = 0;
    let next = 0;
    const lookup = async () => {
      for (let ref = titles[next++]; ref; ref = titles[next++]) {
        const result = await this.#metadataFor(ref);
        if (result?.kind === 'retryable') {
          retryable.push(ref);
          retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs ?? 0);
        } else if (result) found.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(METADATA_LOOKUPS, titles.length) }, lookup));
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
  ): Promise<
    | { kind: 'found'; title: LibraryMetadataTitle; shape?: LibraryMetadataShape }
    | { kind: 'retryable'; retryAfterMs?: number }
    | null
  > {
    const flightKey = `${ref.type}:${ref.id}`;
    const existing = this.#metadataFlights.get(flightKey);
    if (existing) return existing;
    const flight = (async () => {
      const result = await this.#options.content.title(ref);
      if (result.kind === 'unavailable' || result.kind === 'not-configured')
        return {
          kind: 'retryable' as const,
          ...(result.kind === 'unavailable' && result.retryAfterMs !== undefined
            ? { retryAfterMs: result.retryAfterMs }
            : {}),
        };
      if (result.kind === 'missing') return null;
      const title = libraryMetadataTitle(result.value.title);
      if (!title) return null;
      const shape = result.value.shape && libraryMetadataShape(ref, result.value.shape);
      return { kind: 'found' as const, title, ...(shape ? { shape } : {}) };
    })();
    this.#metadataFlights.set(flightKey, flight);
    void flight.finally(() => {
      if (this.#metadataFlights.get(flightKey) === flight) this.#metadataFlights.delete(flightKey);
    });
    return flight;
  }

  #title(ref: TitleRef): TitleView {
    return titleView(
      ref,
      this.#log.title(ref),
      (season, episode) => this.#log.episode(ref, season, episode),
      this.#shapes.get(titleKey(ref))?.shape,
    );
  }

  #overview(): Extract<LibrarySelectionValue, { kind: 'overview' }> {
    const home = this.#projected();
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
    const home = this.#projected();
    const shapes = new Map([...this.#shapes].map(([key, stored]) => [key, stored.shape]));
    return {
      kind: 'continue',
      items: continueItems(
        this.#continueProjector,
        { ...home.continueLibrary, shapes },
        this.#log.settings('devices'),
      ),
      needsShapes: home.requiredShapeRefs.filter((key) => !this.#shapes.has(key)).map(refFromKey),
    };
  }

  #presence(titles: TitleRef[]): Extract<LibrarySelectionValue, { kind: 'presence' }> {
    const standings = new Map(this.#projected().standings);
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
    // Not Home's view: History reads the rows themselves, but its listeners still need the future-stamp deadline.
    this.#scheduleProjectionReconsideration();
    const index = this.#materializedHistory();
    return { kind: 'history', ...index.page()! };
  }

  #historySource(): HistoryIndexSource {
    // Some test/embedding authorities deliberately provide only the narrow LibraryLog surface their view uses.
    // They can still materialize History: rowsVersion invalidates the in-memory index after each write, while the
    // full production log supplies the exact head/future-stamp deadline used by durable checkpoints.
    const summary = (this.#log as Partial<LibraryLog>).currentSummary?.();
    return {
      generation: this.generation,
      version: this.#log.rowsVersion,
      revision: `${this.#log.logHead}:${JSON.stringify(summary?.stamp ?? this.#log.newestStamp())}`,
      reconsiderAt: summary && Number.isFinite(summary.reconsiderAt) ? summary.reconsiderAt : null,
    };
  }

  #materializedHistory(): MaterializedHistoryIndex {
    const source = this.#historySource();
    if (this.#historyIndex?.hasSource(source)) return this.#historyIndex;
    // A few in-memory and embedding authorities expose projected rows but no document-by-name lookup. Preserve that
    // supported narrow surface without making their initial read load mutation policy merely to synthesize v4 docs.
    if (typeof (this.#log as Partial<LibraryLog>).documentNamed !== 'function') {
      const rows = this.#log.rows();
      const names = new Map<string, Title>();
      for (const row of rows) {
        if (row.kind !== 'rec' && row.kind !== 'ep') continue;
        const key = titleKey(row.title);
        if (!names.has(key)) names.set(key, { ...row.title, title: key });
      }
      this.#historyIndex = MaterializedHistoryIndex.fromItems(
        source,
        watchedHistory(rows, names).map(({ title, at, episode, episodes }) => ({
          title: { type: title.type, id: title.id },
          watchedAt: at,
          ...(episode ? { episode } : {}),
          episodes,
        })),
      );
      return this.#historyIndex;
    }
    const documents = [...this.#historyDocumentsByTitle().values()].flat();
    this.#historyIndex = new MaterializedHistoryIndex(source, documents, Date.now());
    return this.#historyIndex;
  }

  /** Keep a foreground edit O(one title) once History has been materialized. */
  #updateHistoryIndex(
    affected: readonly LibraryAffectedSelection[],
    command: LibraryCommand,
  ): void {
    if (!this.#historyIndex || !affected.some(({ kind }) => kind === 'history')) return;
    if (typeof (this.#log as Partial<LibraryLog>).documentNamed !== 'function') {
      this.#historyIndex = undefined;
      return;
    }
    const titles = new Map<string, TitleRef>();
    for (const scope of affected)
      if (scope.kind === 'title') titles.set(titleKey(scope.title), scope.title);
    if (titles.size !== 1 || affected.some(({ kind }) => kind === 'all')) {
      this.#historyIndex = undefined;
      return;
    }
    const title = [...titles.values()][0]!;
    const documents = this.#refreshHistoryDocuments(title, command);
    this.#historyIndex.update(title, documents, this.#historySource());
  }

  #historyDocumentsByTitle(): ReadonlyMap<string, DocumentRow[]> {
    const version = this.#log.rowsVersion;
    if (this.#historyDocuments?.version === version) return this.#historyDocuments.byTitle;
    const byTitle = new Map<string, DocumentRow[]>();
    for (const { document } of this.#log.documents()) {
      if (document.kind !== 'title' && document.kind !== 'season') continue;
      const key = titleKey(document.title);
      const held = byTitle.get(key);
      if (held) held.push(document);
      else byTitle.set(key, [document]);
    }
    this.#historyDocuments = { version, byTitle };
    return byTitle;
  }

  #refreshHistoryDocuments(title: TitleRef, command: LibraryCommand): DocumentRow[] {
    const key = titleKey(title);
    const current = this.#historyDocuments?.byTitle ?? new Map<string, DocumentRow[]>();
    const names = new Set((current.get(key) ?? []).map(rowName));
    names.add(`title:${title.type}:${title.id}`);
    if (title.type === 'tv') {
      if (command.kind === 'episode-watched.set')
        names.add(`season:tv:${title.id}:${command.episode.season}`);
      if (command.kind === 'season-watched.set')
        names.add(`season:tv:${title.id}:${command.season}`);
      if (command.kind === 'progress.record' && command.episode)
        names.add(`season:tv:${title.id}:${command.episode.season}`);
    }
    const documents = [...names].flatMap((name) => this.#log.documentNamed(name) ?? []);
    if (documents.length) current.set(key, documents);
    else current.delete(key);
    this.#historyDocuments = { version: this.#log.rowsVersion, byTitle: current };
    return documents;
  }

  async #settings(): Promise<Extract<LibrarySelectionValue, { kind: 'settings' }>> {
    // A profile-aware household holds no preferences (profiles-v1 §6): any `set:prefs` an older one still carries is a
    // stale seed, never drawn, so no frame is painted from it while the profile's own library opens.
    const profileAware = this.#log.wireMinimum >= 5 || this.#log.profileDirectory() !== null;
    const prefs = this.#log.settings('prefs');
    const selected = selectedSettingsView(prefs ? [prefs] : [], profileAware)!;
    return { ...selected, assistant: await this.#assistant.needs() };
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
      parentalPinDelivery: this.#parentalPinDelivery(),
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
        ...(this.#log.profileTopologyPresent ? { profileTopology: true } : {}),
      },
    };
  }

  #devices(): Extract<LibrarySelectionValue, { kind: 'devices' }> {
    const row = this.#log.settings('devices');
    return selectedDevicesView(row ? [row] : []);
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
        // `download_status`'s clock is the later of the row's coarse one and the live answer's, so it is the figure
        // to show: the row's own, written at most every 5 minutes and reset by every fallback, lags it.
        const fraction = Math.max(0, Math.min(1, durable.clock.lastProgress));
        return {
          content: download.content,
          title: { type: download.title.mediaType, id: download.title.mediaId },
          name: download.title.title || download.release.label || download.content,
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
          ...(download.wanted ? {} : { release: publicRelease(download.release) }),
          ...(download.race.entries[0]
            ? { alternate: publicRelease(download.race.entries[0], download.release.label) }
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
          tried: new Set([
            ...download.tried,
            ...(download.wanted ? [] : [download.release.identity]),
          ]).size,
          ...(download.candidates !== undefined ? { candidates: download.candidates } : {}),
          announced: download.announced,
        };
      }),
    };
  }

  #runtime(): Extract<LibrarySelectionValue, { kind: 'runtime' }> {
    const rows = ['plugins', ADDRESSES].flatMap((name) => this.#log.settings(name) ?? []);
    return selectedRuntimeView(rows);
  }

  #profiles(): Extract<LibrarySelectionValue, { kind: 'profiles' }> {
    const directory = this.#log.profileDirectory();
    if (!directory) {
      if (this.#log.profileDirectoryPending)
        return { kind: 'profiles', state: 'pending', owner: null, profiles: [] };
      // A row that failed validation, or a wire minimum no legacy household reaches, means a split was committed:
      // only a household with neither is truly without a directory.
      const committed = this.#log.profileTopologyPresent || this.#log.wireMinimum >= 5;
      return {
        kind: 'profiles',
        state: committed ? 'invalid' : 'absent',
        owner: null,
        profiles: [],
      };
    }
    return {
      kind: 'profiles',
      state: 'present',
      owner: directory.owner,
      profiles: Object.values(directory.profiles).map((profile) => ({
        id: profile.id,
        role: profile.role,
        name: profile.display.value.name,
        ...(profile.display.value.avatar ? { avatar: profile.display.value.avatar } : {}),
        libraryKey: profile.library.value.key,
        keyVersion: profile.library.value.keyVersion,
        policy: {
          maximumAge: profile.policy.value.maximumAge,
          unknownRatings: profile.policy.value.unknownRatings,
        },
        approvals: this.#log.approvedTitleKeys(profile.id).flatMap((key) => {
          const [type, raw] = key.split(':');
          const id = Number(raw);
          return (type === 'movie' || type === 'tv') && Number.isSafeInteger(id) && id > 0
            ? [{ type, id }]
            : [];
        }),
        deleted: profile.deleted.value,
      })),
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

  #projected(): HomeLibraryView {
    const rows = this.#log.rows();
    this.#scheduleProjectionReconsideration();
    if (this.#projection?.rows === rows) return this.#projection.home;
    const foldedAt = performance.now();
    const home = projectHomeLibraryView(rows);
    noteLibraryFold(rows.length, performance.now() - foldedAt);
    this.#projection = { rows, home };
    return home;
  }

  /** Reconsider future document stamps once, at the first instant den-core may answer differently. */
  #scheduleProjectionReconsideration(): void {
    if (this.#closed) return;
    // A few narrow test/embedding authorities provide only the LibraryLog methods their surface uses.
    const summary = (this.#log as Partial<LibraryLog>).currentSummary?.();
    if (!summary) return;
    const { reconsiderAt } = summary;
    if (this.#projectionTimer !== undefined && reconsiderAt === this.#projectionDeadline) return;
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#projectionTimer = undefined;
    this.#projectionDeadline = reconsiderAt;
    if (!Number.isFinite(reconsiderAt)) return;
    const remaining = reconsiderAt - Date.now();
    this.#projectionTimer = setTimeout(
      () => {
        this.#projectionTimer = undefined;
        if (Date.now() < this.#projectionDeadline) {
          this.#scheduleProjectionReconsideration();
          return;
        }
        this.#projection = undefined;
        this.#projectionDeadline = Infinity;
        this.#scheduleProjectionReconsideration();
        this.#viewWriter?.schedule(true);
        const event: LibraryAuthorityEvent = { kind: 'changed', affected: [{ kind: 'all' }] };
        for (const listener of this.#listeners) listener(event);
      },
      Math.max(0, Math.min(remaining, MAX_TIMER_MS)),
    );
  }

  #coordinates(ref: TitleRef): Array<{ season: number; episode: number }> {
    return titleCoordinates(ref, this.#shapes.get(titleKey(ref))?.shape);
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
    const at = await this.#issue();
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
    const at = await this.#issue();
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
      const at = await this.#issue();
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
      const at = await this.#issue();
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
      const at = await this.#issue();
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

  /**
   * profiles-v1 §6.3: den-core decides which of an older household's preferences this profile has not decided, and
   * they are written with the household's own stamps, so seeding the same profile twice (or from two devices) is the
   * same write.
   */
  async #seedPreferences(
    household: Extract<LibraryCommand, { kind: 'preferences.seed' }>['household'],
  ): Promise<LibraryAuthorityCommandResult> {
    const base = this.#log.settings('prefs') ?? {
      kind: 'set' as const,
      schema: 2,
      name: 'prefs',
      values: {},
    };
    const { values } = syncPolicy<{ values: SettingsRow['values'] }>({
      op: 'profiles_seed_preferences',
      input: { household, profile: base.values },
    });
    const result = !Object.keys(values).length
      ? this.#unchanged()
      : await this.#writeRow({ ...base, values: { ...base.values, ...values } }, [
          { kind: 'settings' },
        ]);
    try {
      await this.#log.keep(RETAINED_PREFERENCE_SEED, household);
    } catch (error) {
      console.warn('den: the completed preference seed could not be retained', error);
    }
    return result;
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
    // The PIN is what returns a Kid to Owner: it may be replaced, never removed, while a restricted profile is live.
    if (pin === null && this.#restrictedProfileLive())
      throw authorityError(
        'conflict',
        'the parental PIN cannot be removed while a Kid profile exists',
      );
    const current = readApiKey(this.#log.settings('keys'), 'parentalPIN');
    const matches = pin === null ? !current : !!current && (await pinMatches(current, pin));
    if (matches) {
      // A queued PIN is already projected into `settings`, including after reload. Drive its durable recovery row
      // before deciding that the repeated command is unchanged; only den-edge's authenticated copy proves sync.
      if (this.#parentalPinDelivery() === 'queued') await this.#log.refresh();
      const refreshed = readApiKey(this.#log.settings('keys'), 'parentalPIN');
      const stillMatches =
        pin === null ? !refreshed : !!refreshed && (await pinMatches(refreshed, pin));
      if (stillMatches)
        return {
          outcome: 'unchanged',
          delivery: this.#parentalPinDelivery(),
          affected: [],
        };
    }
    return this.#patchSettings(
      'keys',
      { parentalPIN: pin === null ? null : { string: await hashPin(pin) } },
      [{ kind: 'connections' }],
    );
  }

  #restrictedProfileLive(): boolean {
    const directory = this.#log.profileDirectory();
    return (
      !!directory &&
      Object.values(directory.profiles).some(
        (profile) => profile.role !== 'owner' && !profile.deleted.value,
      )
    );
  }

  /** Compare only the PIN value, not unrelated keys sharing this settings document. */
  #parentalPinDelivery(): Delivery {
    if (this.#options.mode === 'local') return 'local';
    const projected = readApiKey(this.#log.settings('keys'), 'parentalPIN');
    const acknowledged = readApiKey(this.#log.acknowledgedSettings('keys'), 'parentalPIN');
    return projected === acknowledged ? 'synced' : 'queued';
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

  async #heartbeatDevice(
    name: string,
    kind: 'tv' | 'browser' = 'browser',
    play?: string,
    control?: number,
  ): Promise<LibraryAuthorityCommandResult> {
    if (!name.trim() || name.length > 256)
      throw authorityError('invalid-request', 'device name is empty or too long');
    const changes = selfEntry(
      this.#log.settings('devices'),
      {
        id: this.#clock.device,
        name: name.trim(),
        kind,
        ...(play ? { play } : {}),
        ...(control ? { control } : {}),
      },
      Date.now(),
    );
    return changes
      ? this.#patchSettings('devices', changes, [{ kind: 'devices' }, { kind: 'connections' }])
      : this.#unchanged();
  }

  /** A play sent from another device started on this TV (`<d>.played`, library-v2 §3), so senders offer it first. */
  async #markPlayed(): Promise<LibraryAuthorityCommandResult> {
    return this.#patchSettings(
      'devices',
      { [`${this.#clock.device}.played`]: { int: Date.now() } },
      [{ kind: 'devices' }],
    );
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
      affected: this.#withPendingStatus(pending, [{ kind: 'devices' }, { kind: 'connections' }]),
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

  /** The stamp an edit takes: a fresh one, or the request's own while an assistant's is performed. */
  async #issue(): Promise<Stamp> {
    return this.#asOf ?? (await this.#clock.issue());
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

  async #wantDownload(title: DownloadTitleDescriptor): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    if (!(await this.#downloadsCoordinator.want(internalDownloadTitle(title)))) this.#writeFailed();
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
    if (
      identity === download.release.identity ||
      download.race.entries.some((entry) => entry.identity === identity)
    )
      return this.#unchanged();
    const pending = this.#log.pendingActions;
    // A wanted download has no partial to keep beside the choice: the choice simply starts.
    const saved = download.wanted
      ? await this.#downloadsCoordinator.enqueueIdentity(download.title, identity)
      : await this.#downloadsCoordinator.tryReleaseIdentity(download, identity);
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
    const queued = this.#log.queuedActions;
    const written = await this.#log.writeAction(journal);
    if (!written) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#editDelivery(queued),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  async #writeActions(
    journals: SettingsRow[],
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    if (!journals.length) return this.#unchanged();
    const pending = this.#log.pendingActions;
    const queued = this.#log.queuedActions;
    if (!(await this.#log.writeActions(journals))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#editDelivery(queued),
      affected: this.#withPendingStatus(pending, affected),
    };
  }

  async #writeRow(
    row: TitleRow | EpisodeRow | SettingsRow,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    const queued = this.#log.queuedActions;
    if (!(await this.#log.write(row))) this.#writeFailed();
    return {
      outcome: 'applied',
      delivery: this.#editDelivery(queued),
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

  /**
   * A title or episode edit is answered once it is kept, while its send is still under way: that send is expected to
   * land, so only work left waiting for den-edge is queued. If it does not land, `#deferred` says so.
   */
  #editDelivery(queuedBefore: number): Delivery {
    if (this.#options.mode === 'local') return 'local';
    return this.#log.queuedActions > queuedBefore ? 'queued' : 'synced';
  }

  /** How an edit answered before it was sent came to end: what the views hold may have changed, and the page is told. */
  #deferred({ outcome, changed }: DeferredDelivery): void {
    // A server response can merge rows after command() has already done its final deadline check. In particular,
    // a future-stamped row must arm its absolute reconsideration timer even when no subscribed view is reselected.
    if (changed) this.#scheduleProjectionReconsideration();
    const announce = (event: LibraryAuthorityEvent) => {
      for (const listener of this.#listeners) listener(event);
    };
    announce({
      kind: 'changed',
      affected: changed ? [{ kind: 'all' }] : [{ kind: 'connections' }],
    });
    if (outcome === 'refused')
      announce({
        kind: 'status',
        status: { kind: 'read-only', reason: 'Couldn’t save your last change. It was not kept.' },
      });
    else if (outcome === 'kept' && !this.#log.moved)
      announce({
        kind: 'status',
        status: {
          kind: 'read-only',
          reason: this.#log.migrationLocked
            ? 'Profile setup is in progress on another device. Your change is saved on this device and will sync when it finishes.'
            : 'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.',
        },
      });
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
    if (this.#log.migrationLocked)
      throw authorityError(
        'unavailable',
        'profile setup is in progress, so the library cannot be changed yet',
        true,
      );
    throw authorityError('unavailable', 'library write could not be saved', true);
  }
}
