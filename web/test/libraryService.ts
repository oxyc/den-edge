import type { ClockStore } from '../src/lib/clockStore';
import {
  DownloadCoordinator,
  type DownloadCoordinatorEffects,
} from '../src/lib/downloadCoordinator';
import { DownloadCoordinatorDriver } from '../src/lib/downloadCoordinatorDriver';
import { LibraryLogAuthority } from '../src/lib/libraryLogAuthority';
import { LibraryModel } from '../src/lib/libraryModel.svelte';
import { LibrarySession } from '../src/lib/librarySession.svelte';
import { LibraryServiceError } from '../src/lib/libraryServiceClient';
import type { LibrarySelectionScope } from '../src/lib/libraryServiceCore';
import type {
  DownloadTarget,
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibrarySelection,
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

class FixtureService {
  readonly #subscriptions = new Map<
    number,
    { selection: LibrarySelection; listener: (snapshot: LibrarySelectionSnapshot) => void }
  >();
  readonly #statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  #nextSubscription = 0;
  #revision = 0;
  #ready = false;

  constructor(
    readonly authority: LibraryLogAuthority,
    readonly refreshDownloadSources = false,
    private failOpenOnce = false,
    private openGate?: Promise<void>,
    private readonly openFailureMessage = 'fixture library service did not start',
  ) {}

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
    const result = await this.authority.command(command, operationId);
    if (result.outcome === 'applied') {
      this.#revision++;
      await this.publish(result.affected);
    }
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
    const requested =
      this.refreshDownloadSources && query.kind === 'download.sources'
        ? { ...query, refresh: true as const }
        : query;
    const result = await this.authority.query(requested);
    if (query.kind === 'download.refresh') await this.publish([{ kind: 'downloads' }]);
    return { result, version: this.version };
  }

  async task(task: LibraryTask, operationId: string = crypto.randomUUID()) {
    const completed = await this.authority.task(task, operationId);
    this.#revision++;
    await this.publish(completed.affected);
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
    this.#subscriptions.set(id, { selection, listener });
    if (this.#ready) void this.#publishOne(selection, listener);
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
        .map(({ selection, listener }) => this.#publishOne(selection, listener)),
    );
  }

  close() {
    this.#ready = false;
    this.#subscriptions.clear();
    this.#statusListeners.clear();
    this.authority.close();
  }

  async #publishOne(
    selection: LibrarySelection,
    listener: (snapshot: LibrarySelectionSnapshot) => void,
  ) {
    listener({
      selection,
      connection: 'ready',
      value: await this.authority.select(selection),
      version: this.version,
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
  );
  fixtureState.service = fixtureService;
  const model = new LibraryModel(fixtureService as ConstructorParameters<typeof LibraryModel>[0], {
    libraryKey: libraryKey ?? 'fixture',
    mode: 'local',
  });
  // RoutedLibrary owns this observation in production; fixtures render the model directly.
  void model.ready.catch(() => {});
  const session = new LibrarySession(model);
  return {
    model,
    session,
    coordinator,
    publish: (affected?: LibrarySelectionScope[]) => fixtureService?.publish(affected),
  };
}
