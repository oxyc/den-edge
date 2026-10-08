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
import { episodeProgress } from './detailPresentation';
import {
  contentKey,
  deviceName,
  downloadName,
  emptyRow,
  readDownload,
  readDownloads,
  releaseValue,
  removedRow,
  titleValue,
  withValues,
  type Download,
  type DownloadRelease,
  type DownloadTitle,
} from './downloadRows';
import { watchedHistory } from './history';
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
import type {
  EpisodeRef,
  DownloadReleaseDescriptor,
  DownloadTarget,
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibraryQueryResult,
  RatingSource,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceErrorCode,
  Standing,
  TitleRef,
  TitleView,
} from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityObservationResult,
  type LibrarySelectionScope,
} from './libraryServiceCore';
import { LibraryLog } from './log';
import { acceptsAddonURL, readApiKey, readPlugins } from './prefs';
import { recordTrackerEvent } from './trackerEvents';
import { syncPolicy } from './syncCore';
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

interface DurableDownloadStatus {
  state:
    | 'starting'
    | 'fetching'
    | 'not_started'
    | 'refused'
    | 'paused'
    | 'unreachable'
    | 'ready'
    | 'no_working_release'
    | 'release_gone'
    | null;
  service?: string;
  until?: number;
  clock: { lastProgress: number; progressAt: number };
  stalled: boolean;
}

const publicRelease = (
  release: DownloadRelease | NonNullable<DownloadRelease['hedge']>,
  fallbackLabel?: string,
): Omit<DownloadReleaseDescriptor, 'url'> => ({
  identity: release.identity,
  label: release.label ?? fallbackLabel ?? release.identity,
  ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
  ...(release.cached !== undefined ? { cached: release.cached } : {}),
});

const downloadPhase = (
  state: NonNullable<DurableDownloadStatus['state']>,
): 'queued' | 'downloading' | 'trouble' | 'ready' => {
  if (state === 'ready') return 'ready';
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
  #projection?: { rows: Row[]; home: HomeLibraryView };

  constructor(log: LibraryLog, clock: ClockStore, options: LibraryLogAuthorityOptions) {
    this.#log = log;
    this.#clock = clock;
    this.#options = options;
  }

  get generation(): string | null {
    return this.#log.currentGeneration ?? null;
  }

  close(): void {
    this.#log.close();
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
      case 'download.enqueue':
        return this.#enqueueDownload(command);
      case 'download.remove':
        return this.#removeDownload(command.target);
      case 'download.release.try':
        return this.#tryDownloadRelease(command.target, command.release);
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
      default:
        return query satisfies never;
    }
  }

  async observe(observation: LibraryObservation): Promise<LibraryAuthorityObservationResult> {
    if (observation.kind === 'lifecycle') return { outcome: 'unchanged', affected: [] };
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
          title: ref,
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
        if (value && value.length <= 16_384) found[service] = value;
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
        const durable = syncPolicy<DurableDownloadStatus>({
          op: 'download_status',
          row: download.row,
          now: Date.now(),
        });
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
            phase: downloadPhase(state),
            ...(fraction > 0 ? { fraction } : {}),
            ...(durable.service ? { service: durable.service } : {}),
            ...(durable.until !== undefined ? { until: durable.until } : {}),
            stalled: durable.stalled,
          },
          tried: new Set([...download.tried, download.release.identity]).size,
          ...(download.candidates !== undefined ? { candidates: download.candidates } : {}),
          announced: download.announced,
        };
      }),
    };
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
    ]);
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
    const target = command.title.target;
    const name = downloadName(
      contentKey(
        target.type,
        target.id,
        target.type === 'tv' ? target.season : undefined,
        target.type === 'tv' ? target.episode : undefined,
      ),
    );
    const existing = this.#log.settings(name);
    const current = existing ? readDownload(existing) : null;
    await this.#clock.see(this.#log.newestStamp());
    const now = Date.now();
    if (
      existing &&
      current &&
      current.release.identity === command.release.identity &&
      !current.exhausted
    ) {
      const at = await this.#clock.issue(now);
      return this.#writeRow(withValues(existing, { queuedAt: { value: { int: now }, at } }), [
        { kind: 'downloads' },
      ]);
    }

    const values: Record<string, Stamped<ConfigValue | null>> = {};
    const base = existing ?? emptyRow(name);
    if (existing) values.removed = { value: { bool: true }, at: await this.#clock.issue(now) };
    const at = await this.#clock.issue(now);
    const release: DownloadRelease = command.release;
    const title: DownloadTitle = {
      mediaType: target.type,
      mediaId: target.id,
      ...(target.type === 'tv' ? { season: target.season, episode: target.episode } : {}),
      title: command.title.name,
      ...(command.title.imdbId ? { imdbId: command.title.imdbId } : {}),
      ...(command.title.posterPath ? { posterPath: command.title.posterPath } : {}),
      ...(command.title.stillPath ? { stillPath: command.title.stillPath } : {}),
      ...(command.title.originalLanguage
        ? { originalLanguage: command.title.originalLanguage }
        : {}),
      ...(readSyncedPrefs(this.#log.settings('prefs')).audioLanguage
        ? { preferredLanguage: readSyncedPrefs(this.#log.settings('prefs')).audioLanguage }
        : {}),
    };
    values.release = { value: releaseValue(release), at };
    values.title = { value: titleValue(title), at };
    values.queuedAt = { value: { int: now }, at };
    if (command.candidates !== undefined)
      values.candidates = { value: { int: command.candidates }, at };
    return this.#writeRow(withValues(base, values), [{ kind: 'downloads' }]);
  }

  async #removeDownload(target: DownloadTarget): Promise<LibraryAuthorityCommandResult> {
    const download = this.#download(target);
    if (!download) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    return this.#writeRow(removedRow(download.row, await this.#clock.issue()), [
      { kind: 'downloads' },
    ]);
  }

  async #tryDownloadRelease(
    target: DownloadTarget,
    release: DownloadReleaseDescriptor,
  ): Promise<LibraryAuthorityCommandResult> {
    const download = this.#download(target);
    if (!download) throw authorityError('not-found', 'download is no longer in the queue');
    if (
      release.identity === download.release.identity ||
      release.identity === download.release.hedge?.identity
    )
      return this.#unchanged();
    if (download.release.hedge)
      throw authorityError('conflict', 'download is already trying an alternate release', true);
    await this.#clock.see(this.#log.newestStamp());
    const now = Date.now();
    const at = await this.#clock.issue(now);
    return this.#writeRow(
      withValues(download.row, {
        release: {
          value: releaseValue({
            ...download.release,
            hedge: {
              ...release,
              queuedAt: now,
              lastProgress: 0,
              progressAt: now,
            },
          }),
          at,
        },
      }),
      [{ kind: 'downloads' }],
    );
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
