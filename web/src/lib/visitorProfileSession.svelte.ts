import { HouseholdSession } from './householdSession.svelte';
import { isolatedProfilePolicy, type ProfileContentPolicy } from './profilePolicy';
import { ProfileSession } from './profileSession.svelte';
import {
  visitorProfileIdentity,
  visitorVisitId,
  type VisitorProfileIdentity,
  type VisitorVisitId,
} from './profileIdentity';
import type { LibraryCommand } from './libraryServiceProtocol';
import type { TrackerEvent } from './trackerEvents';
import { VisitorActivityProjection } from './visitorActivity.svelte';
import { PreviewProfilePreferences } from './profilePreferences.svelte';

const VISITOR_STORAGE_PREFIX = 'den.profile.visitor.v1:';
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Promise mutex bookkeeping is not presentation state.
const localLocks = new Map<string, Promise<void>>();

export interface VisitorActivityLock {
  available(): boolean;
  run<T>(name: string, work: () => Promise<T> | T): Promise<T>;
}

const fallbackLock: VisitorActivityLock = {
  available: () => true,
  async run<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const previous = localLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => held);
    localLocks.set(name, queued);
    await previous;
    try {
      return await work();
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
  run<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks)
      return navigator.locks.request(name, () => work());
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
    await this.lock.run(`den:visitor:${this.visitId}`, () => {
      this.#assertWritable();
      this.storage.setItem(this.#key(key), JSON.stringify(value));
    });
  }

  async delete(key: string): Promise<void> {
    await this.lock.run(`den:visitor:${this.visitId}`, () => {
      this.#assertWritable();
      this.storage.removeItem(this.#key(key));
    });
  }

  /** Reload and replace one document while the visit-wide Web Lock excludes every other tab's mutation. */
  async update<T>(key: string, change: (current: unknown) => T): Promise<T> {
    return this.lock.run(`den:visitor:${this.visitId}`, () => {
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
  dispose(revoke: () => void = () => {}): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#disposeInFlight) return this.#disposeInFlight;
    const attempt = this.lock
      .run(`den:visitor:${this.visitId}`, () => {
        revoke();
        for (let index = this.storage.length - 1; index >= 0; index--) {
          const key = this.storage.key(index);
          if (key?.startsWith(this.prefix)) this.storage.removeItem(key);
        }
      })
      .then(() => {
        this.#disposed = true;
      })
      .finally(() => {
        if (!this.#disposed) this.#disposeInFlight = null;
      });
    this.#disposeInFlight = attempt;
    return attempt;
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

export type SuppressedVisitorDelivery = Readonly<{ outcome: 'suppressed' }>;

/**
 * A capability boundary, not a conditional around the household writer. Visitor receives no writer or tracker
 * transport to call, so even a future caller that reaches these methods cannot enqueue synced or external work.
 */
export class NoSyncVisitorWriter {
  readonly syncEnabled = false;
  readonly trackerEnabled = false;

  async write(_command: LibraryCommand): Promise<SuppressedVisitorDelivery> {
    return { outcome: 'suppressed' };
  }

  async track(_event: TrackerEvent): Promise<SuppressedVisitorDelivery> {
    return { outcome: 'suppressed' };
  }
}

export class VisitorProfileSession extends ProfileSession {
  declare readonly identity: VisitorProfileIdentity;
  readonly outbound = new NoSyncVisitorWriter();

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
