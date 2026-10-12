import type { LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import { legacyProfileIdentity, visitorVisitId } from './profileIdentity';
import { ProfileSession } from './profileSession.svelte';
import {
  crossTabVisitorActivityLock,
  randomVisitorVisitId,
  visitorProfileSession,
  type VisitorActivityLock,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';

const ACTIVE_PROFILE_KEY = 'den.profile.active.v1';

export type ActiveProfileMode = 'owner' | 'visitor';

type StorageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type StoredActiveProfile =
  { readonly mode: 'owner' } | { readonly mode: 'visitor'; readonly visitId: string };

const readActiveProfile = (storage: Storage): StoredActiveProfile | null => {
  try {
    const value: unknown = JSON.parse(storage.getItem(ACTIVE_PROFILE_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'mode' in value && value.mode === 'owner')
      return { mode: 'owner' };
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
    // Missing and damaged preferences both require establishing an Owner below.
  }
  return null;
};

const keepActiveProfile = (storage: Storage, value: StoredActiveProfile): void => {
  // Profile transitions are durable commits. Failing the marker write must abort the transition before the old
  // namespace can be deleted or another tab can mistake the visit for active.
  storage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(value));
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
  readonly #events: StorageEvents | null;
  readonly #visitorLock: VisitorActivityLock;
  readonly #connections: LibraryModelLease<ConnectionsView>;
  #pendingOwner: ProfileSession | null;
  #disposed = false;

  constructor(
    owner: ProfileSession,
    storage: Storage = localStorage,
    events: StorageEvents | null = typeof window === 'undefined' ? null : window,
    visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
  ) {
    if (!owner.model || owner.identity.libraryKey === null)
      throw new TypeError('Profiles require an open Owner library');
    owner.relinquishHouseholdOwnership();
    this.#ownerModel = owner.model;
    this.#ownerIdentity = owner.identity;
    this.#household = owner.household;
    this.#local = owner.local;
    this.#storage = storage;
    this.#events = events;
    this.#visitorLock = visitorLock;
    this.#connections = owner.model.connections();
    this.#pendingOwner = owner;

    const saved = readActiveProfile(storage);
    if (saved?.mode === 'visitor' && visitorLock.available()) {
      this.#session = this.#newVisitor(visitorVisitId(saved.visitId));
      this.#pendingOwner = null;
      owner.close();
    } else if (saved?.mode === 'owner') {
      this.#session = owner;
      this.#pendingOwner = null;
    }
    this.#events?.addEventListener('storage', this.#storageChanged);
  }

  get session(): ProfileSession | null {
    return this.#session;
  }

  get mode(): ActiveProfileMode | null {
    return this.session?.identity.kind === 'visitor' ? 'visitor' : this.session ? 'owner' : null;
  }

  /** Undefined only while the existing Settings-owned connection view is opening. */
  get parentalPinConfigured(): boolean | undefined {
    return this.#connections.snapshot.value?.parentalPinConfigured;
  }

  async switchToVisitor(): Promise<boolean> {
    this.#assertOpen();
    if (this.mode === 'visitor') return true;
    if (!this.#session || !this.#visitorLock.available()) return false;
    const previous = this.#session;
    const next = this.#newVisitor(randomVisitorVisitId());
    try {
      await this.#visitorLock.run(`den:visitor:${next.identity.id}`, () =>
        keepActiveProfile(this.#storage, { mode: 'visitor', visitId: next.identity.id }),
      );
    } catch (error) {
      next.close();
      throw error;
    }
    this.#session = next;
    previous.close();
    return true;
  }

  async switchToOwner(pin?: string): Promise<boolean> {
    this.#assertOpen();
    if (this.mode === 'owner') return true;
    const configured = this.parentalPinConfigured;
    if (configured === undefined) return false;
    if (configured && (!pin || !(await this.#ownerModel.verifyParentalPin(pin)))) return false;

    const previous = this.#session as VisitorProfileSession | null;
    // Revocation and deletion take the same visit-wide lock as writes. A write wins before deletion or observes the
    // Owner marker afterward; no interleaving can recreate the namespace after the visit ends.
    if (previous)
      await previous.endVisit(() => keepActiveProfile(this.#storage, { mode: 'owner' }));
    else keepActiveProfile(this.#storage, { mode: 'owner' });
    const next = this.#pendingOwner ?? this.#newOwner();
    this.#pendingOwner = null;
    this.#session = next;
    return true;
  }

  /** Establishes an absent/corrupt marker only after proving this household has no Owner PIN. */
  establishUnprotectedOwner(): boolean {
    if (this.#session) return true;
    if (this.parentalPinConfigured !== false) return false;
    try {
      keepActiveProfile(this.#storage, { mode: 'owner' });
    } catch {
      return false;
    }
    const next = this.#pendingOwner ?? this.#newOwner();
    this.#pendingOwner = null;
    this.#session = next;
    return true;
  }

  /** App teardown retains an active Visitor visit; only an explicit mode switch calls `endVisit`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#events?.removeEventListener('storage', this.#storageChanged);
    this.#connections.release();
    this.#session?.close();
    this.#pendingOwner?.close();
    this.#household.close();
  }

  #newOwner(): ProfileSession {
    return new ProfileSession(
      this.#ownerIdentity.kind === 'owner' || this.#ownerIdentity.kind === 'personal'
        ? this.#ownerIdentity
        : legacyProfileIdentity(this.#ownerIdentity.libraryKey, this.#local),
      this.#household,
      this.#ownerModel,
      this.#local,
      false,
    );
  }

  #newVisitor(visitId: ReturnType<typeof visitorVisitId>): VisitorProfileSession {
    return visitorProfileSession(this.#household, this.#storage, visitId, {
      active: () => {
        const current = readActiveProfile(this.#storage);
        return current?.mode === 'visitor' && current.visitId === visitId;
      },
      lock: this.#visitorLock,
    });
  }

  readonly #storageChanged = (event: StorageEvent): void => {
    if (this.#disposed || (event.storageArea && event.storageArea !== this.#storage)) return;
    const current = this.#session;
    if (event.key !== ACTIVE_PROFILE_KEY) {
      if (
        current?.identity.kind === 'visitor' &&
        (current as VisitorProfileSession).activity.ownsStorageKey(event.key)
      )
        (current as VisitorProfileSession).reloadActivity();
      return;
    }
    const saved = readActiveProfile(this.#storage);
    if (saved?.mode === 'visitor') {
      if (!this.#visitorLock.available()) return;
      if (current?.identity.kind === 'visitor' && current.identity.id === saved.visitId) {
        (current as VisitorProfileSession).reloadActivity();
        return;
      }
      current?.close();
      this.#pendingOwner?.close();
      this.#pendingOwner = null;
      this.#session = this.#newVisitor(visitorVisitId(saved.visitId));
      return;
    }
    if (saved?.mode !== 'owner' || current?.identity.kind !== 'visitor') return;
    void (current as VisitorProfileSession)
      .endVisit()
      .then(() => {
        if (this.#disposed || this.#session !== current) return;
        this.#session = this.#pendingOwner ?? this.#newOwner();
        this.#pendingOwner = null;
      })
      .catch(() => {
        // Keep the ended Visitor session visible so an explicit Owner switch can retry the cleanup.
      });
  };

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Profile mode coordinator is disposed');
  }
}

export type ProfilesCapability = 'enabled' | 'disabled' | 'indeterminate';

/** Only an explicit, valid disabled answer may reveal the legacy Owner path. Every failure stays neutral. */
export async function profilesCapability(
  fetchImpl: typeof fetch = fetch,
  visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
): Promise<ProfilesCapability> {
  try {
    const response = await fetchImpl('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store'))
      return 'indeterminate';
    const value: unknown = await response.json();
    if (
      response.status === 404 &&
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      'error' in value &&
      value.error === 'not_found'
    )
      return 'disabled';
    if (
      !response.ok ||
      !(value && typeof value === 'object') ||
      Object.keys(value).length !== 1 ||
      !('enabled' in value) ||
      value.enabled !== true ||
      !visitorLock.available()
    )
      return 'indeterminate';
    await visitorLock.run('den:visitor:capability', () => {});
    return 'enabled';
  } catch {
    return 'indeterminate';
  }
}
