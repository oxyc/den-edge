import { HouseholdSession } from './householdSession.svelte';
import { isolatedProfilePolicy, type ProfileContentPolicy } from './profilePolicy';
import { ProfileSession } from './profileSession.svelte';
import {
  visitorProfileIdentity,
  visitorVisitId,
  type VisitorProfileIdentity,
  type VisitorVisitId,
} from './profileIdentity';
import { VisitorActivityProjection } from './visitorActivity.svelte';
import { PreviewProfilePreferences } from './profilePreferences.svelte';

const VISITOR_STORAGE_PREFIX = 'den.profile.visitor.v1:';
const VISITOR_NAMESPACE_KEY = /^den\.profile\.visitor\.v1:([0-9a-f]{32}):/;
const NOOP = () => {};
const RESOLVED = Promise.resolve();
export const VISITOR_CLEANUP_SUPERSEDED = { outcome: 'superseded' } as const;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Promise mutex bookkeeping is not presentation state.
const localLocks = new Map<string, Promise<void>>();

export interface VisitorActivityLock {
  available(): boolean;
  /**
   * Invoke admitted synchronous work after returning to the caller, and do not yield to another lock user between
   * that work returning and finalizing its lock. A new caller in a post-work/pre-settlement gap is intentionally not
   * admissible. Async work remains exclusive until its returned promise settles.
   */
  run<T>(name: string, work: () => PromiseLike<T> | T): Promise<T>;
}

/** Exact valid Visitor namespaces present on this browser. Similar-looking personal/future keys are not visits. */
export function visitorNamespaceIds(storage: Storage): VisitorVisitId[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- One synchronous immutable discovery result.
  const ids = new Set<VisitorVisitId>();
  for (let index = 0; index < storage.length; index++) {
    const id = VISITOR_NAMESPACE_KEY.exec(storage.key(index) ?? '')?.[1];
    if (id) ids.add(visitorVisitId(id));
  }
  return [...ids].sort();
}

/**
 * Missing/corrupt-selection recovery has no active Visitor object to retire. Delete every exact orphan namespace
 * under the same per-visit lock used by activity writes, so another tab cannot resurrect a key during recovery.
 */
export function purgeOrphanVisitorNamespaces(
  storage: Storage,
  lock: VisitorActivityLock = crossTabVisitorActivityLock,
  beforeDelete: () => void = NOOP,
): Promise<void> {
  // Every tab acquires the complete set in the same order before deleting any of it.
  const ids = visitorNamespaceIds(storage);
  const locked = async (index: number): Promise<void> => {
    if (index < ids.length) return lock.run(`den:visitor:${ids[index]}`, () => locked(index + 1));
    // Hold every visit lock before checking authority and deleting. A superseded recovery therefore changes no
    // namespace, while an admitted one cannot race a writer in any orphan it is about to retire.
    beforeDelete();
    deleteVisitorNamespaces(storage, ids);
  };
  return locked(0);
}

const deleteVisitorNamespaces = (storage: Storage, ids: readonly string[]): void => {
  const visits = new Set(ids);
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    const visit = key && VISITOR_NAMESPACE_KEY.exec(key)?.[1];
    if (visit && visits.has(visit)) storage.removeItem(key);
  }
};

const fallbackLock: VisitorActivityLock = {
  available: () => true,
  async run<T>(name: string, work: () => PromiseLike<T> | T): Promise<T> {
    const previous = localLocks.get(name) ?? RESOLVED;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => held);
    localLocks.set(name, queued);
    await previous;
    try {
      const result = work();
      return typeof (result as PromiseLike<T>)?.then === 'function' ? await result : result;
    } finally {
      release();
      if (localLocks.get(name) === queued) localLocks.delete(name);
    }
  },
};

export const crossTabVisitorActivityLock: VisitorActivityLock = {
  available: () =>
    typeof window === 'undefined' ||
    (typeof navigator !== 'undefined' && navigator.locks !== undefined),
  run<T>(name: string, work: () => PromiseLike<T> | T): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks)
      // Some implementations invoke an uncontended callback before `request` returns. Defer admission one microtask
      // so disposal can publish its shared promise before any durable revoke/delete work begins.
      return navigator.locks.request(name, () => RESOLVED.then(work));
    // Tests and non-browser rendering share one process. A browser without Web Locks must fail closed instead of
    // pretending an in-process mutex excludes its other tabs and risking lost or resurrected activity.
    if (typeof window !== 'undefined')
      return Promise.reject(new Error('Cross-tab Visitor activity locking is unavailable'));
    return fallbackLock.run(name, work);
  },
};

export type VisitorActivityValue =
  | null
  | boolean
  | number
  | string
  | VisitorActivityValue[]
  | { [key: string]: VisitorActivityValue };

/**
 * The only durable boundary a Visitor owns. Values are intentionally opaque to this adapter: the future local
 * activity projection can evolve without ever acquiring a library key, relay membership or sync transport.
 */
export class VisitorActivityNamespace {
  readonly prefix: string;
  #disposed = false;
  #disposeInFlight: Promise<void> | null = null;
  #disposeRevoke = NOOP;

  constructor(
    readonly visitId: VisitorVisitId,
    private readonly storage: Storage,
    private readonly active: () => boolean = () => true,
    private readonly lock: VisitorActivityLock = crossTabVisitorActivityLock,
  ) {
    this.prefix = `${VISITOR_STORAGE_PREFIX}${visitId}:`;
  }

  get(key: string): VisitorActivityValue | undefined {
    this.#assertOpen();
    const value = this.storage.getItem(this.#key(key));
    if (value === null) return undefined;
    try {
      return JSON.parse(value) as VisitorActivityValue;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: VisitorActivityValue): Promise<void> {
    return this.#run(() => {
      this.#assertWritable();
      this.storage.setItem(this.#key(key), JSON.stringify(value));
    });
  }

  async delete(key: string): Promise<void> {
    return this.#run(() => {
      this.#assertWritable();
      this.storage.removeItem(this.#key(key));
    });
  }

  /** Reload and replace one document while the visit-wide Web Lock excludes every other tab's mutation. */
  async update<T>(key: string, change: (current: unknown) => T): Promise<T> {
    return this.#run(() => {
      this.#assertWritable();
      const next = change(this.get(key));
      this.#assertWritable();
      this.storage.setItem(this.#key(key), JSON.stringify(next));
      return next;
    });
  }

  ownsStorageKey(key: string | null): boolean {
    return key?.startsWith(this.prefix) ?? false;
  }

  /** Ending a visit serializes revocation and deletion with every activity write in every tab. */
  dispose(revoke: () => void = NOOP): Promise<void> {
    if (this.#disposed) return RESOLVED;
    this.#disposeRevoke = revoke;
    if (this.#disposeInFlight) return this.#disposeInFlight;
    return (this.#disposeInFlight = this.#run(() => {
      let applied = NOOP;
      while (applied !== this.#disposeRevoke) {
        applied = this.#disposeRevoke;
        try {
          applied();
        } catch (error) {
          // A superseded transition may still retire a visit whose durable marker moved elsewhere. If this visit is
          // still authoritative, preserve its activity so the failed transition remains safely retryable.
          if (error !== VISITOR_CLEANUP_SUPERSEDED || this.active()) throw error;
        }
      }
      deleteVisitorNamespaces(this.storage, [this.visitId]);
      this.#disposed = true;
    }).finally(() => {
      this.#disposeRevoke = NOOP;
      this.#disposeInFlight = null;
    }));
  }

  #run<T>(work: () => PromiseLike<T> | T): Promise<T> {
    return this.lock.run(`den:visitor:${this.visitId}`, work);
  }

  #key(key: string): string {
    if (!key) throw new TypeError('A Visitor activity key must not be empty');
    return `${this.prefix}${key}`;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Visitor activity namespace is disposed');
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (!this.active()) throw new Error('Visitor visit has ended');
  }
}

export class VisitorProfileSession extends ProfileSession {
  declare readonly identity: VisitorProfileIdentity;

  constructor(
    household: HouseholdSession,
    readonly activity: VisitorActivityNamespace,
    contentPolicy: ProfileContentPolicy | null = null,
    preferences: PreviewProfilePreferences | null = null,
  ) {
    const projection = new VisitorActivityProjection(activity);
    super(
      visitorProfileIdentity(activity.visitId),
      household,
      null,
      true,
      false,
      preferences?.policy ?? isolatedProfilePolicy(household.policy),
      projection,
      contentPolicy,
      preferences,
      null,
      false,
    );
    for (const title of projection.titles) this.rememberTitle(title);
  }

  /** Explicitly switching away ends the visit; ordinary route/app teardown must call `close` and retain it. */
  async endVisit(revoke?: () => void): Promise<void> {
    await this.activity.dispose(revoke);
    this.close();
  }

  reloadActivity(): void {
    (this.profileActivity as VisitorActivityProjection).reload();
  }
}

export function randomVisitorVisitId(
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): VisitorVisitId {
  const bytes = random();
  if (bytes.length !== 16) throw new TypeError('A Visitor visit id needs exactly 16 random bytes');
  return visitorVisitId([...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

/** Inactive factory for the future switcher: constructing it neither activates Visitor nor touches Owner state. */
export function visitorProfileSession(
  household: HouseholdSession,
  storage: Storage = localStorage,
  visitId: VisitorVisitId = randomVisitorVisitId(),
  options: {
    active?: () => boolean;
    lock?: VisitorActivityLock;
    personalPreferences?: boolean;
    events?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  } = {},
  contentPolicy: ProfileContentPolicy | null = null,
): VisitorProfileSession {
  const activity = new VisitorActivityNamespace(visitId, storage, options.active, options.lock);
  const identity = visitorProfileIdentity(visitId);
  const householdPolicy = isolatedProfilePolicy(household.policy);
  const preferences =
    options.personalPreferences && householdPolicy
      ? new PreviewProfilePreferences(identity, householdPolicy, storage, options.events, activity)
      : null;
  return new VisitorProfileSession(household, activity, contentPolicy, preferences);
}
