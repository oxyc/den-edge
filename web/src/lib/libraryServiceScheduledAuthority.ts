import type { ClockStore } from './clockStore';
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
/**
 * An idle visible page holds its read (`/changes?wait=`, den-edge's maximum) and reads again at once after a held
 * answer, so a change made elsewhere shows within moments: the TV's `HeldPoll`. An answer that came back early and
 * empty was not held (a den-edge without `wait`, a cap on held reads, a failure) and waits `VISIBLE_REFRESH_MS`, so the
 * loop never spins; one that found a change waits `HELD_SPACING_MS`, so a change that keeps answering at once costs a
 * request a second.
 */
export const HELD_WAIT_SECONDS = 25;
export const HELD_AFTER_MS = (HELD_WAIT_SECONDS / 2) * 1000;
export const HELD_SPACING_MS = 1_000;

export interface LibraryMaintenanceResult {
  changed: boolean;
  status: LibraryAuthorityStatus;
}

/** The scheduler depends on one semantic maintenance operation, not LibraryLog internals. */
export interface LibraryMaintenance {
  readonly mode: 'online' | 'local';
  /** `waitSeconds` holds the read until something changes; `stopWaiting` ends that hold early. */
  run(options?: {
    waitSeconds?: number;
    stopWaiting?: AbortSignal;
  }): Promise<LibraryMaintenanceResult>;
}

/** Optional provider work run by the same authority scheduler after foreground content is released. */
export interface LibraryProviderDelivery {
  run(current: () => boolean): Promise<boolean>;
}

export interface LibraryAuthoritySchedulerOptions {
  now?: () => number;
  setTimer?: (task: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Optional domains that must stay behind the first foreground paint. */
  background?: {
    run(current: () => boolean): Promise<boolean>;
    nextDelay?(now: number): number | undefined;
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
  /** Ends the running maintenance's held read early. */
  #holding?: AbortController;
  #deliveryRunning?: Promise<void>;
  #deliveryPending = false;
  #deliveryWaitsForMaintenance = false;
  #deliveryEpoch = 0;
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
    // Called as a private method, a bare `clearTimeout` gets this instance as `this`: browsers throw "Illegal
    // invocation" (seen in production in the library Worker), Node does not.
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
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
  task: LibraryServiceAuthority['task'] = async (task, operationId) => {
    const result = await this.authority.task(task, operationId);
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
      // A held read waits no longer for a page that is hidden or under its player.
      this.#holding?.abort();
      this.#deliveryEpoch++;
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
    this.#holding?.abort();
    this.#deliveryEpoch++;
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
    // Under the page's own player nothing is drawn from the library, and a refresh or compaction only competes with
    // the stream; the pass when it closes catches up, as the TV's polls do (`RootView`).
    if (this.#halted || !this.#lifecycle.visible || this.#lifecycle.playerOpen) return false;
    return this.maintenance.mode === 'local' || this.#lifecycle.online;
  }

  #interval(): number {
    const maintenance = this.#lifecycle.playbackActive
      ? ACTIVE_PLAYBACK_REFRESH_MS
      : VISIBLE_REFRESH_MS;
    if (!this.#background || !this.#foregroundReady || !this.#lifecycle.online) return maintenance;
    const background = this.#background.nextDelay?.(this.#now());
    return background === undefined ? maintenance : Math.min(maintenance, background);
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

  /** When to read again after a read that found a change or not and took `read` ms, the whole pass `elapsed` ms. */
  #nextDelay(changed: boolean, read: number, elapsed: number): number {
    if (this.#lifecycle.playbackActive) return Math.max(0, this.#interval() - elapsed);
    const held = changed
      ? Math.max(0, HELD_SPACING_MS - elapsed)
      : read >= HELD_AFTER_MS
        ? 0
        : Math.max(0, VISIBLE_REFRESH_MS - elapsed);
    return Math.min(held, Math.max(0, this.#interval() - elapsed));
  }

  #run(): Promise<void> {
    if (this.#running) return this.#running;
    const started = this.#now();
    let changed = false;
    let read = 0;
    const holding = new AbortController();
    this.#holding = holding;
    const running = (async () => {
      try {
        const result = await this.maintenance.run({
          waitSeconds: this.#lifecycle.playbackActive
            ? ACTIVE_PLAYBACK_REFRESH_MS / 1000
            : HELD_WAIT_SECONDS,
          stopWaiting: holding.signal,
        });
        // Only maintenance is timed: the background work after it must not pass for a held answer.
        read = this.#now() - started;
        changed = result.changed;
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
      if (this.#holding === holding) this.#holding = undefined;
      this.#deliveryWaitsForMaintenance = false;
      this.#requestDelivery();
      if (!this.#closed && this.#eligible() && this.maintenance.mode === 'online')
        this.#schedule(this.#nextDelay(changed, read, Math.max(0, this.#now() - started)));
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
    const epoch = this.#deliveryEpoch;
    const running = (async () => {
      try {
        if (
          await this.delivery!.run(
            () =>
              epoch === this.#deliveryEpoch &&
              !this.#closed &&
              this.#eligible() &&
              this.#lifecycle.online,
          )
        )
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
    // A status the authority announced between runs is the one the next run must replace, or it stays up for good.
    if (event.kind === 'status') this.#lastStatus = event.status;
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
  mode: 'online' | 'local',
): LibraryMaintenance {
  return {
    mode,
    async run(options) {
      let changed =
        mode === 'online' ? await log.refresh(options?.waitSeconds, options?.stopWaiting) : false;
      if (log.moved) return { changed, status: logStatus(log) };
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
  return {
    run: (current) => deliverSimklWithClock(log, clock, fetchImpl, undefined, current),
  };
}

function logStatus(log: LibraryLog): LibraryAuthorityStatus {
  if (log.moved) return { kind: 'moved' };
  if (log.upgradeRequired !== null)
    return {
      kind: 'failed',
      error: {
        code: 'update-required',
        message: 'A newer version of Den is required to open this library.',
        retryable: false,
        requiredWire: log.upgradeRequired,
      },
    };
  if (log.readOnlyReason) return { kind: 'read-only', reason: log.readOnlyReason };
  return { kind: 'ready' };
}
