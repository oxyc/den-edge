import type { ClockStore } from '../src/lib/clockStore';
import { ContentAuthority } from '../src/lib/contentAuthority';
import {
  DownloadCoordinator,
  type DownloadCoordinatorEffects,
} from '../src/lib/downloadCoordinator';
import { DownloadCoordinatorDriver } from '../src/lib/downloadCoordinatorDriver';
import { LibraryLogAuthority } from '../src/lib/libraryLogAuthority';
import { LibraryModel } from '../src/lib/libraryModel.svelte';
import { legacyProfileSession } from '../src/lib/profileSession.svelte';
import { LibraryServiceError } from '../src/lib/libraryServiceClient';
import type { LibraryAuthorityEvent, LibrarySelectionScope } from '../src/lib/libraryServiceCore';
import type {
  DownloadTarget,
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceCommandResult,
  LibrarySessionStatus,
  LibraryTask,
  LibraryVersion,
} from '../src/lib/libraryServiceProtocol';
import type { LibrarySelectionSnapshot } from '../src/lib/libraryServiceSupervisor';
import type { LibraryLog } from '../src/lib/log';
import type { Vault } from '../src/lib/localVault';
import { cancelSource, prepareSource } from '../src/lib/titleSources';
import type { Stamp } from '../src/lib/wire';
import { fixtureContentService } from './contentService';

interface FixtureSubscription {
  selection: LibrarySelection;
  listener: (snapshot: LibrarySelectionSnapshot) => void;
  failed: boolean;
  retained?: LibrarySelectionValue;
}

class FixtureService {
  readonly historyDetails = {
    attempts: 0,
    successes: 0,
    failures: 0,
    lastError: '',
    lastItems: [] as { id: number; seen: number }[],
  };
  readonly #subscriptions = new Map<number, FixtureSubscription>();
  readonly downloadsSelection = { attempts: 0 };
  readonly historyImports = {
    attempts: 0,
    applications: 0,
    replies: 0,
    operationIds: [] as string[],
  };
  readonly recoveryTasks: LibraryTask['kind'][] = [];
  readonly commandKinds: LibraryCommand['kind'][] = [];
  readonly progressOperationIds: string[] = [];
  readonly #completedTasks = new Map<string, Awaited<ReturnType<LibraryLogAuthority['task']>>>();
  readonly #statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  readonly #heldSelections = new Map<
    LibrarySelection['kind'],
    { started: () => void; gate: Promise<void> }
  >();
  #nextSubscription = 0;
  #revision = 0;
  #ready = false;
  readonly #stopAuthority: () => void;

  constructor(
    readonly authority: LibraryLogAuthority,
    readonly refreshDownloadSources = false,
    private failOpenOnce = false,
    private openGate?: Promise<void>,
    private readonly openFailureMessage = 'fixture library service did not start',
    private readonly failHistoryDetails = false,
    private readonly settingsGate?: Promise<void>,
    private downloadsSelectionFailures = 0,
    private readonly downloadsSelectionGate?: Promise<void>,
    private loseHistoryImportReplyOnce = false,
    private readonly historyImportReplyGate?: Promise<void>,
    private loseRecoveryConfirmReplyOnce = false,
    private rejectProgressCommands = 0,
    private readonly progressReplyGate?: Promise<void>,
  ) {
    this.#stopAuthority = authority.listen((event) => this.#forwardAuthorityEvent(event));
  }

  get version(): LibraryVersion {
    return { instance: 'fixture', generation: this.authority.generation, revision: this.#revision };
  }

  async open() {
    if (this.failOpenOnce) {
      this.failOpenOnce = false;
      throw new LibraryServiceError({
        code: 'unavailable',
        message: this.openFailureMessage,
        retryable: true,
      });
    }
    await this.openGate;
    this.openGate = undefined;
    this.#ready = true;
    await this.publish();
    const status: LibrarySessionStatus = { kind: 'ready', version: this.version };
    for (const listener of this.#statusListeners) listener(status);
    return this.version;
  }

  retry() {
    return this.open();
  }

  async command(
    command: LibraryCommand,
    operationId: string = crypto.randomUUID(),
  ): Promise<LibraryServiceCommandResult> {
    this.commandKinds.push(command.kind);
    if (command.kind === 'progress.record') {
      this.progressOperationIds.push(operationId);
      if (command.playing === false && this.rejectProgressCommands > 0) {
        this.rejectProgressCommands--;
        throw new Error('fixture rejected progress command');
      }
    }
    const result = await this.authority.command(command, operationId);
    if (result.outcome === 'applied') {
      this.#revision++;
      await this.publish(result.affected);
    }
    if (command.kind === 'progress.record' && command.playing === false)
      await this.progressReplyGate;
    return {
      type: 'command-result',
      protocol: 1,
      requestId: `fixture:${this.#revision}`,
      operationId,
      outcome: result.outcome,
      delivery: result.delivery,
      version: this.version,
    };
  }

  async query(query: LibraryQuery) {
    const historyDetails = query.kind === 'history.episodes';
    if (historyDetails) this.historyDetails.attempts++;
    try {
      if (this.failHistoryDetails && historyDetails)
        throw new Error('fixture history details failed');
      const requested =
        this.refreshDownloadSources && query.kind === 'download.sources'
          ? { ...query, refresh: true as const }
          : query;
      const result = await this.authority.query(requested);
      if (query.kind === 'download.refresh') await this.publish([{ kind: 'downloads' }]);
      if (historyDetails && result.kind === 'history.episodes') {
        this.historyDetails.successes++;
        this.historyDetails.lastItems = result.items.map(({ title, seen }) => ({
          id: title.id,
          seen: seen.length,
        }));
      }
      return { result, version: this.version };
    } catch (error) {
      if (historyDetails) {
        this.historyDetails.failures++;
        this.historyDetails.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  async task(task: LibraryTask, operationId: string = crypto.randomUUID()) {
    const historyImport = task.kind === 'history.import';
    const recovery = task.kind.startsWith('recovery.');
    if (recovery) this.recoveryTasks.push(task.kind);
    if (historyImport) {
      this.historyImports.attempts++;
      this.historyImports.operationIds.push(operationId);
    }
    let completed = this.#completedTasks.get(operationId);
    if (!completed) {
      completed = await this.authority.task(task, operationId);
      this.#completedTasks.set(operationId, completed);
      if (historyImport) this.historyImports.applications++;
      this.#revision++;
      await this.publish(completed.affected);
    }
    if (historyImport && this.loseHistoryImportReplyOnce) {
      this.loseHistoryImportReplyOnce = false;
      throw new Error('fixture lost the committed import reply');
    }
    if (task.kind === 'recovery.confirm' && this.loseRecoveryConfirmReplyOnce) {
      this.loseRecoveryConfirmReplyOnce = false;
      throw new Error('fixture lost the committed recovery confirmation reply');
    }
    if (historyImport) await this.historyImportReplyGate;
    if (historyImport) this.historyImports.replies++;
    return { result: completed.result, version: this.version };
  }

  async observe(observation: LibraryObservation) {
    const result = await this.authority.observe(observation);
    if (result.outcome === 'applied') {
      this.#revision++;
      await this.publish(result.affected);
    }
    return this.version;
  }

  subscribeSnapshot(
    selection: LibrarySelection,
    listener: (snapshot: LibrarySelectionSnapshot) => void,
  ) {
    const id = ++this.#nextSubscription;
    const downloads = selection.kind === 'downloads';
    if (downloads) this.downloadsSelection.attempts++;
    const failed = downloads && this.downloadsSelectionFailures > 0;
    if (failed) this.downloadsSelectionFailures--;
    const subscription: FixtureSubscription = {
      selection,
      listener,
      failed,
    };
    this.#subscriptions.set(id, subscription);
    if (this.#ready) void this.#publishOne(subscription);
    else listener({ selection, connection: 'connecting' });
    return () => this.#subscriptions.delete(id);
  }

  onStatus(listener: (status: LibrarySessionStatus) => void) {
    this.#statusListeners.add(listener);
    if (this.#ready) listener({ kind: 'ready', version: this.version });
    return () => this.#statusListeners.delete(listener);
  }

  async publish(affected: LibrarySelectionScope[] = [{ kind: 'all' }]) {
    await Promise.all(
      [...this.#subscriptions.values()]
        .filter(({ selection }) => affected.some((scope) => matches(scope, selection)))
        .map((subscription) => this.#publishOne(subscription)),
    );
  }

  holdNextSelection(kind: LibrarySelection['kind']) {
    let noteStarted = () => {};
    const started = new Promise<void>((resolve) => (noteStarted = resolve));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.#heldSelections.set(kind, { started: noteStarted, gate });
    return { started, release };
  }

  activeSelections() {
    const counts: Partial<Record<LibrarySelection['kind'], number>> = {};
    for (const { selection } of this.#subscriptions.values())
      counts[selection.kind] = (counts[selection.kind] ?? 0) + 1;
    return counts;
  }

  failDownloadsSelection() {
    this.failSelection('downloads');
  }

  failSelection(kind: LibrarySelection['kind']) {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.selection.kind !== kind) continue;
      subscription.failed = true;
      this.#emitSelectionFailure(subscription);
    }
  }

  close() {
    this.#ready = false;
    this.#subscriptions.clear();
    this.#statusListeners.clear();
    this.#stopAuthority();
    this.authority.close();
  }

  #forwardAuthorityEvent(event: LibraryAuthorityEvent) {
    if (event.kind !== 'changed') return;
    this.#revision++;
    void this.publish(event.affected);
  }

  async #publishOne(subscription: FixtureSubscription) {
    const { selection, listener } = subscription;
    if (selection.kind === 'settings') await this.settingsGate;
    if (selection.kind === 'downloads') await this.downloadsSelectionGate;
    if (subscription.failed) return this.#emitSelectionFailure(subscription);
    const value = await this.authority.select(selection);
    const held = this.#heldSelections.get(selection.kind);
    if (held) {
      this.#heldSelections.delete(selection.kind);
      held.started();
      await held.gate;
    }
    subscription.retained = value;
    listener({
      selection,
      connection: 'ready',
      value,
      version: this.version,
    });
  }

  #emitSelectionFailure(subscription: FixtureSubscription) {
    subscription.listener({
      selection: subscription.selection,
      connection: 'failed',
      ...(subscription.retained ? { value: subscription.retained } : {}),
      version: this.version,
      error: {
        code: 'unavailable',
        message: `fixture ${subscription.selection.kind} selection failed`,
        retryable: true,
      },
    });
  }
}

const sameTitle = (a: { type: string; id: number }, b: { type: string; id: number }) =>
  a.type === b.type && a.id === b.id;

function matches(scope: LibrarySelectionScope, selection: LibrarySelection) {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'title')
    return selection.kind === 'title' && sameTitle(scope.title, selection.title);
  if (scope.kind === 'presence')
    return (
      selection.kind === 'presence' &&
      selection.titles.some((title) => sameTitle(scope.title, title))
    );
  return scope.kind === selection.kind;
}

export interface FixtureLibraryServiceOptions {
  log: LibraryLog;
  device?: string;
  /** Enables the administrative queries Settings owns without exposing a production session/log escape hatch. */
  libraryKey?: string;
  effects?: Partial<DownloadCoordinatorEffects>;
  refreshDownloads?: (target?: DownloadTarget) => Promise<boolean>;
  refreshDownloadSources?: boolean;
  downloadArtwork?: (target: DownloadTarget) => Promise<string | null>;
  /** Page fixture only: expose one startup failure, then let its Retry action recover normally. */
  failOpenOnce?: boolean;
  /** Page fixture only: the production failure text whose visible handoff the page should exercise. */
  openFailureMessage?: string;
  /** Page fixture only: hold startup so progressive loading behavior can be observed. */
  openGate?: Promise<void>;
  /** Page fixture only: make the lazy History detail query fail so its summary fallback can be exercised. */
  failHistoryDetails?: boolean;
  /** Page fixture only: let other root snapshots publish while policy Settings stays authoritative-but-held. */
  settingsGate?: Promise<void>;
  /** Downloads page fixture only: fail this many fresh lazy-selection subscriptions until the page rebinds. */
  downloadsSelectionFailures?: number;
  /** Downloads page fixture only: hold its real lazy selection at the service protocol boundary. */
  downloadsSelectionGate?: Promise<void>;
  /** Settings fixture only: commit one history import, then reject before its semantic reply reaches the page. */
  loseHistoryImportReplyOnce?: boolean;
  /** Settings fixture only: hold a committed history import's semantic reply. */
  historyImportReplyGate?: Promise<void>;
  /** Settings fixture only: commit one recovery confirmation, then lose its semantic reply. */
  loseRecoveryConfirmReplyOnce?: boolean;
  /** Playback fixture only: reject this many progress commands before they reach durable authority. */
  rejectProgressCommands?: number;
  /** Playback fixture only: hold the semantic reply after progress is durably applied and published. */
  progressReplyGate?: Promise<void>;
}

/**
 * A browser-fixture library using the same protocol, authority and page model as production. The fixture owns only
 * its in-memory log and provider effects; raw rows never leak into components.
 */
export function fixtureLibraryService({
  log,
  device = 'aaaaaaaaaaaaaaaa',
  libraryKey,
  effects = {},
  refreshDownloads,
  refreshDownloadSources,
  downloadArtwork,
  failOpenOnce,
  openFailureMessage,
  openGate,
  failHistoryDetails,
  settingsGate,
  downloadsSelectionFailures,
  downloadsSelectionGate,
  loseHistoryImportReplyOnce,
  historyImportReplyGate,
  loseRecoveryConfirmReplyOnce,
  rejectProgressCommands,
  progressReplyGate,
}: FixtureLibraryServiceOptions) {
  let last: Stamp = [0, 0, device];
  const clock: ClockStore = {
    device,
    async issue(at = Date.now()) {
      last = at > last[0] ? [at, 0, device] : [last[0], last[1] + 1, device];
      return [...last];
    },
    async historical(milliseconds) {
      const stamps: Stamp[] = [];
      for (const at of milliseconds) stamps.push(await this.issue(at));
      return stamps;
    },
    async see(stamp) {
      if (stamp[0] > last[0] || (stamp[0] === last[0] && stamp[1] > last[1]))
        last = [stamp[0], stamp[1], device];
    },
    async current() {
      return [...last];
    },
  };

  const fixtureState: { service?: FixtureService } = {};
  const coordinator = new DownloadCoordinator(
    log,
    clock,
    {
      prepare:
        effects.prepare ?? ((url, queue, prefetch) => prepareSource(url, queue, fetch, prefetch)),
      cancel: effects.cancel ?? ((url, reannounce) => cancelSource(url, reannounce, fetch)),
      resolve: effects.resolve ?? (async () => ({ sources: null, failure: 'not-configured' })),
      ticket: effects.ticket ?? ((url) => (url.startsWith('/scout/') ? url : null)),
      ...(effects.wanted ? { wanted: effects.wanted } : {}),
    },
    { changed: () => void fixtureState.service?.publish([{ kind: 'downloads' }]) },
  );
  const driver = new DownloadCoordinatorDriver(coordinator);
  const vaultValues = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (key) => vaultValues.get(key),
    entries: async (prefix) => [...vaultValues.entries()].filter(([key]) => key.startsWith(prefix)),
    put: async (key, value) => void vaultValues.set(key, value),
    delete: async (key) => void vaultValues.delete(key),
    remove: async (prefix) => {
      for (const key of vaultValues.keys()) if (key.startsWith(prefix)) vaultValues.delete(key);
    },
  };
  const authority = new LibraryLogAuthority(log, clock, {
    mode: 'local',
    downloads: coordinator,
    content: new ContentAuthority({
      tmdb: () => 'fixture-key',
      omdb: () => undefined,
      contentWarnings: () => undefined,
    }),
    ...(libraryKey ? { libraryKey, vault } : {}),
    refreshDownloads: refreshDownloads ?? (async () => driver.run({ force: true })),
    downloadArtwork,
  });
  const fixtureService = new FixtureService(
    authority,
    refreshDownloadSources,
    failOpenOnce,
    openGate,
    openFailureMessage,
    failHistoryDetails,
    settingsGate,
    downloadsSelectionFailures,
    downloadsSelectionGate,
    loseHistoryImportReplyOnce,
    historyImportReplyGate,
    loseRecoveryConfirmReplyOnce,
    rejectProgressCommands,
    progressReplyGate,
  );
  fixtureState.service = fixtureService;
  const model = new LibraryModel(fixtureService as ConstructorParameters<typeof LibraryModel>[0], {
    libraryKey: libraryKey ?? 'fixture',
    mode: 'local',
  });
  // RoutedLibrary owns this observation in production; fixtures render the model directly.
  void model.ready.catch(() => {});
  const session = legacyProfileSession(
    libraryKey ?? 'fixture',
    false,
    model,
    fixtureContentService(),
  );
  return {
    model,
    session,
    coordinator,
    historyDetails: fixtureService.historyDetails,
    downloadsSelection: fixtureService.downloadsSelection,
    historyImports: fixtureService.historyImports,
    recoveryTasks: fixtureService.recoveryTasks,
    commandKinds: fixtureService.commandKinds,
    progressOperationIds: fixtureService.progressOperationIds,
    publish: (affected?: LibrarySelectionScope[]) => fixtureService?.publish(affected),
    holdNextSelection: (kind: LibrarySelection['kind']) => fixtureService.holdNextSelection(kind),
    activeSelections: () => fixtureService.activeSelections(),
    failSelection: (kind: LibrarySelection['kind']) => fixtureService.failSelection(kind),
    failDownloadsSelection: () => fixtureService.failDownloadsSelection(),
  };
}
