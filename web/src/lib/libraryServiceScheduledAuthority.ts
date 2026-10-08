import type { ClockStore } from './clockStore';
import { upgradeLibrary, switchLibraryToV4 } from './libraryUpgrade';
import type { LibraryObservation } from './libraryServiceProtocol';
import type {
  LibraryAuthorityEvent,
  LibraryAuthorityStatus,
  LibraryServiceAuthority,
} from './libraryServiceCore';
import type { LibraryLog } from './log';
import { deliverSimklWithClock } from './simklDelivery';

export const ACTIVE_PLAYBACK_REFRESH_MS = 5_000;
export const VISIBLE_REFRESH_MS = 30_000;

export interface LibraryMaintenanceResult {
  changed: boolean;
  status: LibraryAuthorityStatus;
}

/** The scheduler depends on one semantic maintenance operation, not LibraryLog internals. */
export interface LibraryMaintenance {
  readonly mode: 'online' | 'local';
  run(): Promise<LibraryMaintenanceResult>;
}

/** Optional provider work run by the same authority scheduler after foreground content is released. */
export interface LibraryProviderDelivery {
  run(): Promise<boolean>;
}

export interface LibraryAuthoritySchedulerOptions {
  now?: () => number;
  setTimer?: (task: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Optional domains that must stay behind the first foreground paint. */
  background?: {
    run(current: () => boolean): Promise<boolean>;
    listen?(listener: () => void): () => void;
  };
}

const sameStatus = (left: LibraryAuthorityStatus | undefined, right: LibraryAuthorityStatus) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Adds one service-owned refresh loop to an authority. Lifecycle is input data; pages never own polling timers.
 * A refresh is opaque by design, so Core reselects all live subscriptions and its digests suppress unchanged values.
 */
export class ScheduledLibraryServiceAuthority implements LibraryServiceAuthority {
  readonly #listeners = new Set<(event: LibraryAuthorityEvent) => void>();
  readonly #now: () => number;
  readonly #setTimer: NonNullable<LibraryAuthoritySchedulerOptions['setTimer']>;
  readonly #clearTimer: NonNullable<LibraryAuthoritySchedulerOptions['clearTimer']>;
  readonly #background?: LibraryAuthoritySchedulerOptions['background'];
  readonly #stopAuthority?: () => void;
  readonly #stopBackground?: () => void;
  #lifecycle: Extract<LibraryObservation, { kind: 'lifecycle' }> = {
    kind: 'lifecycle',
    visible: false,
    online: false,
    playbackActive: false,
  };
  #timer?: ReturnType<typeof setTimeout>;
  #running?: Promise<void>;
  #deliveryRunning?: Promise<void>;
  #deliveryPending = false;
  #deliveryWaitsForMaintenance = false;
  #foregroundReady = false;
  #lastStatus?: LibraryAuthorityStatus;
  #halted = false;
  #closed = false;

  constructor(
    private readonly authority: LibraryServiceAuthority,
    private readonly maintenance: LibraryMaintenance,
    options: LibraryAuthoritySchedulerOptions = {},
    private readonly delivery?: LibraryProviderDelivery,
  ) {
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((task, delay) => setTimeout(task, delay));
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#background = options.background;
    this.#stopAuthority = authority.listen?.((event) => this.#emit(event));
    this.#stopBackground = options.background?.listen?.(() =>
      this.#emit({ kind: 'changed', affected: [{ kind: 'downloads' }] }),
    );
  }

  get generation(): string | null {
    return this.authority.generation;
  }

  select: LibraryServiceAuthority['select'] = (selection) => this.authority.select(selection);
  command: LibraryServiceAuthority['command'] = async (command, operationId) => {
    const result = await this.authority.command(command, operationId);
    if (result.outcome === 'applied') this.#requestDelivery();
    return result;
  };
  query: LibraryServiceAuthority['query'] = (query) => this.authority.query(query);
  task: LibraryServiceAuthority['task'] = async (task) => {
    const result = await this.authority.task(task);
    if (result.affected.length) this.#requestDelivery();
    return result;
  };

  async observe(observation: LibraryObservation) {
    const result = await this.authority.observe(observation);
    if (this.#closed) return result;
    if (observation.kind === 'foreground-ready') {
      if (!this.#foregroundReady) {
        this.#foregroundReady = true;
        if (this.#eligible()) this.#schedule(0);
      }
      this.#requestDelivery();
      return result;
    }
    if (observation.kind !== 'lifecycle') return result;
    const wasEligible = this.#eligible();
    const previousInterval = this.#interval();
    this.#lifecycle = structuredClone(observation);
    const eligible = this.#eligible();
    if (!eligible) {
      this.#cancelTimer();
      this.#deliveryWaitsForMaintenance = false;
    } else if (!wasEligible) this.#schedule(0);
    else if (this.#interval() !== previousInterval) this.#schedule(this.#interval());
    return result;
  }

  listen(listener: (event: LibraryAuthorityEvent) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    this.#deliveryWaitsForMaintenance = false;
    this.#stopAuthority?.();
    this.#stopBackground?.();
    this.#listeners.clear();
    await this.#running;
    await this.#deliveryRunning;
    await this.authority.close?.();
  }

  #eligible(): boolean {
    if (this.#halted || !this.#lifecycle.visible) return false;
    return this.maintenance.mode === 'local' || this.#lifecycle.online;
  }

  #interval(): number {
    return this.#lifecycle.playbackActive ? ACTIVE_PLAYBACK_REFRESH_MS : VISIBLE_REFRESH_MS;
  }

  #schedule(delay: number): void {
    this.#cancelTimer();
    if (this.#closed || !this.#eligible()) return;
    // Local libraries have no remote log to poll. They get one foreground maintenance pass for upgrades only.
    if (this.maintenance.mode === 'local' && this.#running) return;
    this.#deliveryWaitsForMaintenance = delay === 0 && this.#foregroundReady;
    this.#timer = this.#setTimer(
      () => {
        this.#timer = undefined;
        void this.#run();
      },
      Math.max(0, delay),
    );
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #run(): Promise<void> {
    if (this.#running) return this.#running;
    const started = this.#now();
    const running = (async () => {
      try {
        const result = await this.maintenance.run();
        if (this.#closed) return;
        if (result.changed) this.#emit({ kind: 'changed', affected: [{ kind: 'all' }] });
        if (!sameStatus(this.#lastStatus, result.status)) {
          this.#lastStatus = result.status;
          this.#emit({ kind: 'status', status: result.status });
        }
        if (this.#background && this.#foregroundReady && this.#lifecycle.online)
          try {
            if (
              (await this.#background.run(
                () =>
                  !this.#closed &&
                  this.#eligible() &&
                  this.#lifecycle.online &&
                  this.#foregroundReady,
              )) &&
              !this.#closed
            )
              this.#emit({ kind: 'changed', affected: [{ kind: 'downloads' }] });
          } catch (error) {
            if (!this.#closed) console.warn('den: download maintenance failed', error);
          }
      } catch (error) {
        if (this.#closed) return;
        console.warn('den: library service maintenance failed', error);
        const status: LibraryAuthorityStatus = { kind: 'reconnecting' };
        if (!sameStatus(this.#lastStatus, status)) {
          this.#lastStatus = status;
          this.#emit({ kind: 'status', status });
        }
      }
    })();
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
      this.#deliveryWaitsForMaintenance = false;
      this.#requestDelivery();
      if (!this.#closed && this.#eligible() && this.maintenance.mode === 'online') {
        const elapsed = Math.max(0, this.#now() - started);
        this.#schedule(Math.max(0, this.#interval() - elapsed));
      }
    });
    return running;
  }

  #requestDelivery(): void {
    if (
      this.#closed ||
      !this.delivery ||
      !this.#foregroundReady ||
      !this.#eligible() ||
      this.maintenance.mode !== 'online'
    )
      return;
    if (this.#deliveryWaitsForMaintenance) return;
    if (this.#running) {
      return;
    }
    if (this.#deliveryRunning) {
      this.#deliveryPending = true;
      return;
    }
    const running = (async () => {
      try {
        if (await this.delivery!.run())
          this.#emit({ kind: 'changed', affected: [{ kind: 'simkl' }, { kind: 'connections' }] });
      } catch (error) {
        if (!this.#closed) console.warn('den: SIMKL delivery failed', error);
      }
    })();
    this.#deliveryRunning = running;
    void running.finally(() => {
      if (this.#deliveryRunning === running) this.#deliveryRunning = undefined;
      const again = this.#deliveryPending;
      this.#deliveryPending = false;
      if (again) this.#requestDelivery();
    });
  }

  #emit(event: LibraryAuthorityEvent): void {
    if (this.#closed) return;
    if (event.kind === 'status' && event.status.kind === 'moved') {
      this.#halted = true;
      this.#cancelTimer();
      this.#deliveryWaitsForMaintenance = false;
    }
    for (const listener of this.#listeners)
      try {
        listener(event);
      } catch (error) {
        console.error('den: a library authority listener failed', error);
      }
  }
}

/** Production maintenance policy. The log stays private and only reports semantic change/status. */
export function libraryLogMaintenance(
  log: LibraryLog,
  clock: ClockStore,
  mode: 'online' | 'local',
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): LibraryMaintenance {
  return {
    mode,
    async run() {
      let changed = mode === 'online' ? await log.refresh() : false;
      if (log.moved) return { changed, status: logStatus(log) };
      changed = (await upgradeLibrary(log, mode === 'local', Date.now(), clock)) || changed;
      changed = (await switchLibraryToV4(log, Date.now(), fetchImpl, clock.device)) || changed;
      if (mode === 'online') changed = (await log.compact()) || changed;
      return { changed, status: logStatus(log) };
    },
  };
}

export function librarySimklDelivery(
  log: LibraryLog,
  clock: ClockStore,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): LibraryProviderDelivery {
  return { run: () => deliverSimklWithClock(log, clock, fetchImpl) };
}

function logStatus(log: LibraryLog): LibraryAuthorityStatus {
  if (log.moved) return { kind: 'moved' };
  if (log.upgradeRequired !== null) return { kind: 'read-only', reason: 'Library update required' };
  if (log.predatesV3) return { kind: 'read-only', reason: 'Library backup predates v3' };
  if (log.switchFailure)
    return { kind: 'read-only', reason: `Library update failed: ${log.switchFailure}` };
  return { kind: 'ready' };
}
