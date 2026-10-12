import { HouseholdSession } from './householdSession.svelte';
import { ProfileSession } from './profileSession.svelte';
import {
  visitorProfileIdentity,
  visitorVisitId,
  type VisitorProfileIdentity,
  type VisitorVisitId,
} from './profileIdentity';
import type { LibraryCommand } from './libraryServiceProtocol';
import type { TrackerEvent } from './trackerEvents';

const VISITOR_STORAGE_PREFIX = 'den.profile.visitor.v1:';

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

  constructor(
    readonly visitId: VisitorVisitId,
    private readonly storage: Storage,
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

  set(key: string, value: VisitorActivityValue): void {
    this.#assertOpen();
    this.storage.setItem(this.#key(key), JSON.stringify(value));
  }

  delete(key: string): void {
    this.#assertOpen();
    this.storage.removeItem(this.#key(key));
  }

  /** Ending a visit calls this idempotently and removes no other browser or visit state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (let index = this.storage.length - 1; index >= 0; index--) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.prefix)) this.storage.removeItem(key);
    }
  }

  #key(key: string): string {
    if (!key) throw new TypeError('A Visitor activity key must not be empty');
    return `${this.prefix}${key}`;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Visitor activity namespace is disposed');
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
  ) {
    super(visitorProfileIdentity(activity.visitId), household, null, true, false);
  }

  /** Explicitly switching away ends the visit; ordinary route/app teardown must call `close` and retain it. */
  endVisit(): void {
    this.activity.dispose();
    this.close();
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
): VisitorProfileSession {
  return new VisitorProfileSession(household, new VisitorActivityNamespace(visitId, storage));
}
