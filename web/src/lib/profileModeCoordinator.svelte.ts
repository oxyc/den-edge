import type { LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import { legacyProfileIdentity, visitorVisitId } from './profileIdentity';
import { ProfileSession } from './profileSession.svelte';
import {
  randomVisitorVisitId,
  visitorProfileSession,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';

const ACTIVE_PROFILE_KEY = 'den.profile.active.v1';

export type ActiveProfileMode = 'owner' | 'visitor';

type StoredActiveProfile =
  { readonly mode: 'owner' } | { readonly mode: 'visitor'; readonly visitId: string };

const readActiveProfile = (storage: Storage): StoredActiveProfile => {
  try {
    const value: unknown = JSON.parse(storage.getItem(ACTIVE_PROFILE_KEY) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'mode' in value &&
      value.mode === 'visitor' &&
      'visitId' in value &&
      typeof value.visitId === 'string' &&
      /^[0-9a-f]{32}$/.test(value.visitId)
    )
      return { mode: 'visitor', visitId: value.visitId };
  } catch {
    // A damaged or unavailable preference must fall back to today's Owner session.
  }
  return { mode: 'owner' };
};

const keepActiveProfile = (storage: Storage, value: StoredActiveProfile): void => {
  try {
    storage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(value));
  } catch {
    // The active tab can still switch when a browser temporarily refuses persistence.
  }
};

/**
 * Owns the one household while disposable profile sessions come and go. It is constructed only after the
 * host-scoped profiles capability opts this page in, so the default path never reads or writes profile storage.
 */
export class ProfileModeCoordinator {
  #session = $state.raw<ProfileSession | null>(null);
  readonly #ownerModel;
  readonly #ownerIdentity;
  readonly #household;
  readonly #local;
  readonly #storage;
  readonly #connections: LibraryModelLease<ConnectionsView>;
  #disposed = false;

  constructor(owner: ProfileSession, storage: Storage = localStorage) {
    if (!owner.model || owner.identity.libraryKey === null)
      throw new TypeError('Profiles require an open Owner library');
    owner.relinquishHouseholdOwnership();
    this.#ownerModel = owner.model;
    this.#ownerIdentity = owner.identity;
    this.#household = owner.household;
    this.#local = owner.local;
    this.#storage = storage;
    this.#connections = owner.model.connections();

    const saved = readActiveProfile(storage);
    this.#session =
      saved.mode === 'visitor'
        ? visitorProfileSession(this.#household, storage, visitorVisitId(saved.visitId))
        : owner;
    if (saved.mode === 'owner') keepActiveProfile(storage, saved);
    if (this.session !== owner) owner.close();
  }

  get session(): ProfileSession {
    if (!this.#session) throw new Error('Profile mode coordinator has no active session');
    return this.#session;
  }

  get mode(): ActiveProfileMode {
    return this.session.identity.kind === 'visitor' ? 'visitor' : 'owner';
  }

  /** Undefined only while the existing Settings-owned connection view is opening. */
  get parentalPinConfigured(): boolean | undefined {
    return this.#connections.snapshot.value?.parentalPinConfigured;
  }

  switchToVisitor(): void {
    this.#assertOpen();
    if (this.mode === 'visitor') return;
    const previous = this.session;
    const next = visitorProfileSession(this.#household, this.#storage, randomVisitorVisitId());
    keepActiveProfile(this.#storage, { mode: 'visitor', visitId: next.identity.id });
    this.#session = next;
    previous.close();
  }

  async switchToOwner(pin?: string): Promise<boolean> {
    this.#assertOpen();
    if (this.mode === 'owner') return true;
    const configured = this.parentalPinConfigured;
    if (configured === undefined) return false;
    if (configured && (!pin || !(await this.#ownerModel.verifyParentalPin(pin)))) return false;

    const previous = this.session as VisitorProfileSession;
    const next = new ProfileSession(
      this.#ownerIdentity.kind === 'owner' || this.#ownerIdentity.kind === 'personal'
        ? this.#ownerIdentity
        : legacyProfileIdentity(this.#ownerIdentity.libraryKey, this.#local),
      this.#household,
      this.#ownerModel,
      this.#local,
      false,
    );
    previous.endVisit();
    keepActiveProfile(this.#storage, { mode: 'owner' });
    this.#session = next;
    return true;
  }

  /** App teardown retains an active Visitor visit; only an explicit mode switch calls `endVisit`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connections.release();
    this.session.close();
    this.#household.close();
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Profile mode coordinator is disposed');
  }
}

/** The capability is deliberately uncached and fail-closed. */
export async function profilesCapability(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return !!value && typeof value === 'object' && 'enabled' in value && value.enabled === true;
  } catch {
    return false;
  }
}
