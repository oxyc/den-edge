import type { LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  profileId,
  visitorVisitId,
  type ProfileId,
} from './profileIdentity';
import { ProfileSession } from './profileSession.svelte';
import { isolatedProfilePolicy, type ProfileContentPolicy } from './profilePolicy';
import {
  crossTabVisitorActivityLock,
  randomVisitorVisitId,
  visitorProfileSession,
  type VisitorActivityLock,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';

const ACTIVE_PROFILE_KEY = 'den.profile.active.v1';

export type ActiveProfileMode = 'owner' | 'kid' | 'visitor';

export interface ProfileChoice {
  readonly id: ProfileId | null;
  readonly role: ActiveProfileMode;
  readonly name: string;
  readonly avatar: string;
  readonly policy?: ProfileContentPolicy;
}

export interface PreviewProfileDirectory {
  readonly owner: ProfileId;
  readonly profiles: readonly [ProfileChoice, ProfileChoice];
}

type StorageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type StoredActiveProfile =
  | { readonly mode: 'owner' }
  | { readonly mode: 'visitor'; readonly visitId: string }
  | { readonly version: 1; readonly mode: 'persistent'; readonly profileId: string }
  | { readonly version: 1; readonly mode: 'visitor'; readonly visitorNamespace: string };

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
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1 &&
      'mode' in value &&
      value.mode === 'persistent' &&
      'profileId' in value &&
      typeof value.profileId === 'string' &&
      /^[0-9a-f]{32}$/.test(value.profileId)
    )
      return { version: 1, mode: 'persistent', profileId: value.profileId };
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1 &&
      'mode' in value &&
      value.mode === 'visitor' &&
      'visitorNamespace' in value &&
      typeof value.visitorNamespace === 'string' &&
      /^[0-9a-f]{32}$/.test(value.visitorNamespace)
    )
      return { version: 1, mode: 'visitor', visitorNamespace: value.visitorNamespace };
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
  readonly #directory: PreviewProfileDirectory | null;
  #pendingOwner: ProfileSession | null;
  #disposed = false;

  constructor(
    owner: ProfileSession,
    storage: Storage = localStorage,
    events: StorageEvents | null = typeof window === 'undefined' ? null : window,
    visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
    directory: PreviewProfileDirectory | null = null,
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
    this.#directory = directory;
    this.#pendingOwner = owner;

    const saved = readActiveProfile(storage);
    const savedVisit =
      saved?.mode === 'visitor'
        ? 'visitorNamespace' in saved
          ? saved.visitorNamespace
          : saved.visitId
        : null;
    if (savedVisit && visitorLock.available()) {
      this.#session = this.#newVisitor(visitorVisitId(savedVisit));
      this.#pendingOwner = null;
      owner.close();
    } else if (saved?.mode === 'persistent' && directory) {
      const choice = this.#choice(saved.profileId);
      if (choice?.role === 'owner') {
        this.#session = owner;
        this.#pendingOwner = null;
      } else if (choice?.role === 'kid') {
        this.#session = this.#newKid(choice);
        this.#pendingOwner = null;
        owner.close();
      }
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
    if (this.session?.identity.kind === 'visitor') return 'visitor';
    if (this.session?.identity.kind === 'profile') return 'kid';
    return this.session ? 'owner' : null;
  }

  get choices(): readonly ProfileChoice[] {
    return this.#directory
      ? [
          ...this.#directory.profiles,
          { id: null, role: 'visitor' as const, name: 'Visitor', avatar: 'visitor' },
        ]
      : [
          { id: null, role: 'owner', name: 'Owner', avatar: 'owner' },
          { id: null, role: 'visitor', name: 'Visitor', avatar: 'visitor' },
        ];
  }

  get activeChoice(): ProfileChoice | null {
    if (this.mode === 'visitor')
      return { id: null, role: 'visitor', name: 'Visitor', avatar: 'visitor' };
    if (this.mode === 'owner' && this.#directory)
      return this.#choice(this.#directory.owner) ?? null;
    const id = this.session?.identity.id;
    return this.#directory && id ? (this.#choice(id) ?? null) : (this.choices[0] ?? null);
  }

  /** Undefined only while the existing Settings-owned connection view is opening. */
  get parentalPinConfigured(): boolean | undefined {
    if (this.#directory) return true;
    return this.#connections.snapshot.value?.parentalPinConfigured;
  }

  get preview(): boolean {
    return this.#directory !== null;
  }

  requiresPin(target: ActiveProfileMode): boolean {
    if (target === this.mode || this.mode === 'owner') return false;
    if (target === 'owner') return true;
    if (!this.mode) return false;
    if (this.mode !== 'kid' || target !== 'visitor') return false;
    const kid = this.activeChoice?.policy;
    if (!kid) return true;
    // Visitor inherits Owner policy. The preview Owner is unrestricted, so leaving Kid is a policy loosening.
    const owner = this.#directory ? this.#choice(this.#directory.owner)?.policy : undefined;
    return !owner || this.#policyIsLooser(owner, kid);
  }

  async switchToVisitor(pin?: string): Promise<boolean> {
    this.#assertOpen();
    if (this.mode === 'visitor') return true;
    if (!this.#session || !this.#visitorLock.available()) return false;
    if (this.requiresPin('visitor') && !(await this.#verifyPin(pin))) return false;
    const previous = this.#session;
    const next = this.#newVisitor(randomVisitorVisitId());
    try {
      await this.#visitorLock.run(`den:visitor:${next.identity.id}`, () =>
        keepActiveProfile(
          this.#storage,
          this.#directory
            ? { version: 1, mode: 'visitor', visitorNamespace: next.identity.id }
            : { mode: 'visitor', visitId: next.identity.id },
        ),
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
    if (this.requiresPin('owner') && !(await this.#verifyPin(pin))) return false;

    const previous = this.#session;
    // Revocation and deletion take the same visit-wide lock as writes. A write wins before deletion or observes the
    // Owner marker afterward; no interleaving can recreate the namespace after the visit ends.
    if (previous?.identity.kind === 'visitor')
      await (previous as VisitorProfileSession).endVisit(() =>
        keepActiveProfile(this.#storage, this.#ownerMarker()),
      );
    else {
      keepActiveProfile(this.#storage, this.#ownerMarker());
      this.#session?.close();
    }
    const next = this.#pendingOwner ?? this.#newOwner();
    this.#pendingOwner = null;
    this.#session = next;
    return true;
  }

  async switchToKid(pin?: string): Promise<boolean> {
    this.#assertOpen();
    const kid = this.#directory?.profiles.find((choice) => choice.role === 'kid');
    if (!kid?.id || this.mode === 'kid') return kid?.id !== null && this.mode === 'kid';
    if (this.requiresPin('kid') && !(await this.#verifyPin(pin))) return false;
    const previous = this.#session;
    const marker = { version: 1 as const, mode: 'persistent' as const, profileId: kid.id };
    if (previous?.identity.kind === 'visitor')
      await (previous as VisitorProfileSession).endVisit(() =>
        keepActiveProfile(this.#storage, marker),
      );
    else {
      keepActiveProfile(this.#storage, marker);
      previous?.close();
    }
    this.#session = this.#newKid(kid);
    return true;
  }

  /** Establishes an absent/corrupt marker only after proving this household has no Owner PIN. */
  establishUnprotectedOwner(): boolean {
    if (this.#session) return true;
    if (this.parentalPinConfigured !== false) return false;
    try {
      keepActiveProfile(this.#storage, this.#ownerMarker());
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
    return visitorProfileSession(
      this.#household,
      this.#storage,
      visitId,
      {
        active: () => {
          const current = readActiveProfile(this.#storage);
          return (
            current?.mode === 'visitor' &&
            ('visitorNamespace' in current ? current.visitorNamespace : current.visitId) === visitId
          );
        },
        lock: this.#visitorLock,
      },
      this.#directory ? (this.#choice(this.#directory.owner)?.policy ?? null) : null,
    );
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
      const visitId = 'visitorNamespace' in saved ? saved.visitorNamespace : saved.visitId;
      if (current?.identity.kind === 'visitor' && current.identity.id === visitId) {
        (current as VisitorProfileSession).reloadActivity();
        return;
      }
      current?.close();
      this.#pendingOwner?.close();
      this.#pendingOwner = null;
      this.#session = this.#newVisitor(visitorVisitId(visitId));
      return;
    }
    const persistent = saved?.mode === 'persistent' ? this.#choice(saved.profileId) : null;
    const ownerSelected = saved?.mode === 'owner' || persistent?.role === 'owner';
    const kidSelected = persistent?.role === 'kid' ? persistent : null;
    if (!ownerSelected && !kidSelected) return;
    const activate = () => {
      if (this.#disposed || this.#session !== current) return;
      this.#session = kidSelected
        ? this.#newKid(kidSelected)
        : (this.#pendingOwner ?? this.#newOwner());
      this.#pendingOwner = null;
    };
    if (current?.identity.kind === 'visitor')
      void (current as VisitorProfileSession)
        .endVisit()
        .then(activate)
        .catch(() => {
          // Keep the ended Visitor session visible so an explicit switch can retry the cleanup.
        });
    else {
      current?.close();
      activate();
    }
  };

  #choice(id: string): ProfileChoice | undefined {
    return this.#directory?.profiles.find((choice) => choice.id === id);
  }

  #newKid(choice: ProfileChoice): ProfileSession {
    if (!choice.id) throw new TypeError('Kid profile is missing its id');
    return new ProfileSession(
      persistentProfileIdentity(choice.id, `preview:${choice.id}`),
      this.#household,
      null,
      false,
      false,
      isolatedProfilePolicy(this.#pendingOwner?.policy ?? this.#session?.policy ?? null),
      null,
      choice.policy ?? null,
    );
  }

  #ownerMarker(): StoredActiveProfile {
    return this.#directory
      ? { version: 1, mode: 'persistent', profileId: this.#directory.owner }
      : { mode: 'owner' };
  }

  async #verifyPin(pin?: string): Promise<boolean> {
    if (this.#directory) return pin === '1234';
    const configured = this.parentalPinConfigured;
    if (configured === undefined) return false;
    return !configured || (!!pin && (await this.#ownerModel.verifyParentalPin(pin)));
  }

  #policyIsLooser(
    candidate: NonNullable<ProfileChoice['policy']>,
    current: NonNullable<ProfileChoice['policy']>,
  ): boolean {
    if (current.unknownRatings === 'block' && candidate.unknownRatings === 'allow') return true;
    if (current.maximumAge === null) return false;
    return candidate.maximumAge === null || candidate.maximumAge > current.maximumAge;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Profile mode coordinator is disposed');
  }
}

export type ProfilesCapability = 'enabled' | 'preview' | 'disabled' | 'indeterminate';

export const previewProfileDirectory = (): PreviewProfileDirectory => {
  const owner = profileId('00000000000000000000000000000001');
  return {
    owner,
    profiles: [
      {
        id: owner,
        role: 'owner',
        name: 'Owner',
        avatar: 'owner',
        policy: { maximumAge: null, unknownRatings: 'allow' },
      },
      {
        id: profileId('00000000000000000000000000000002'),
        role: 'kid',
        name: 'Kids',
        avatar: 'kid',
        policy: { maximumAge: 12, unknownRatings: 'block' },
      },
    ],
  };
};

/** Only an explicit, valid disabled answer may reveal the legacy Owner path. Every failure stays neutral. */
export async function profilesCapability(
  fetchImpl: typeof fetch = fetch,
  visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
  allowPreview = import.meta.env.DEV,
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
    const preview =
      allowPreview &&
      response.ok &&
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 2 &&
      'enabled' in value &&
      value.enabled === true &&
      'preview' in value &&
      value.preview === true;
    if (
      !response.ok ||
      !(value && typeof value === 'object') ||
      (!preview && Object.keys(value).length !== 1) ||
      !('enabled' in value) ||
      value.enabled !== true ||
      !visitorLock.available()
    )
      return 'indeterminate';
    await visitorLock.run('den:visitor:capability', () => {});
    return preview ? 'preview' : 'enabled';
  } catch {
    return 'indeterminate';
  }
}
