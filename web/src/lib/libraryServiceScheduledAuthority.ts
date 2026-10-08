import type { ClockStore } from './clockStore';
import { upgradeLibrary, switchLibraryToV4 } from './libraryUpgrade';
import type { LibraryObservation } from './libraryServiceProtocol';
import type {
  LibraryAuthorityEvent,
  LibraryAuthorityStatus,
  LibraryServiceAuthority,
} from './libraryServiceCore';
import type { LibraryLog } from './log';

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

export interface LibraryAuthoritySchedulerOptions {
  now?: () => number;
  setTimer?: (task: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
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
  readonly #stopAuthority?: () => void;
  #lifecycle: Extract<LibraryObservation, { kind: 'lifecycle' }> = {
    kind: 'lifecycle',
    visible: false,
    online: false,
    playbackActive: false,
  };
  #timer?: ReturnType<typeof setTimeout>;
  #running?: Promise<void>;
  #lastStatus?: LibraryAuthorityStatus;
  #halted = false;
  #closed = false;

  constructor(
    private readonly authority: LibraryServiceAuthority,
    private readonly maintenance: LibraryMaintenance,
    options: LibraryAuthoritySchedulerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((task, delay) => setTimeout(task, delay));
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#stopAuthority = authority.listen?.((event) => this.#emit(event));
  }

  get generation(): string | null {
    return this.authority.generation;
  }

  select: LibraryServiceAuthority['select'] = (selection) => this.authority.select(selection);
  command: LibraryServiceAuthority['command'] = (command, operationId) =>
    this.authority.command(command, operationId);
  query: LibraryServiceAuthority['query'] = (query) => this.authority.query(query);

  async observe(observation: LibraryObservation) {
    const result = await this.authority.observe(observation);
    if (observation.kind !== 'lifecycle' || this.#closed) return result;
    const wasEligible = this.#eligible();
    const previousInterval = this.#interval();
    this.#lifecycle = structuredClone(observation);
    const eligible = this.#eligible();
    if (!eligible) this.#cancelTimer();
    else if (!wasEligible) this.#schedule(0);
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
    this.#stopAuthority?.();
    this.#listeners.clear();
    await this.#running;
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
      if (!this.#closed && this.#eligible() && this.maintenance.mode === 'online') {
        const elapsed = Math.max(0, this.#now() - started);
        this.#schedule(Math.max(0, this.#interval() - elapsed));
      }
    });
    return running;
  }

  #emit(event: LibraryAuthorityEvent): void {
    if (this.#closed) return;
    if (event.kind === 'status' && event.status.kind === 'moved') {
      this.#halted = true;
      this.#cancelTimer();
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

function logStatus(log: LibraryLog): LibraryAuthorityStatus {
  if (log.moved) return { kind: 'moved' };
  if (log.upgradeRequired !== null) return { kind: 'read-only', reason: 'Library update required' };
  if (log.predatesV3) return { kind: 'read-only', reason: 'Library backup predates v3' };
  if (log.switchFailure)
    return { kind: 'read-only', reason: `Library update failed: ${log.switchFailure}` };
  return { kind: 'ready' };
}
