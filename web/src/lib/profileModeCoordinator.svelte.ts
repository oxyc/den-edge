import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView, ProfileDirectoryView } from './libraryServiceProtocol';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  profileId,
  visitorVisitId,
  type ProfileId,
} from './profileIdentity';
import { activeProfileSession, ProfileSession } from './profileSession.svelte';
import { isolatedProfilePolicy, type ProfileContentPolicy } from './profilePolicy';
import { PreviewProfilePreferences } from './profilePreferences.svelte';
import {
  crossTabVisitorActivityLock,
  purgeOrphanVisitorNamespaces,
  randomVisitorVisitId,
  visitorNamespaceIds,
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
  /** Present only for a den-core-validated real directory; never returned by `choices`. */
  readonly libraryKey?: string;
  readonly keyVersion?: number;
}

export interface PreviewProfileDirectory {
  readonly owner: ProfileId;
  readonly profiles: readonly ProfileChoice[];
}

export interface ProfileActivityModelHandle {
  readonly model: LibraryModel;
  close(): void;
}

export type ProfileActivityModelFactory = (libraryKey: string) => ProfileActivityModelHandle;

/** Convert the service's already den-core-validated projection without allowing deleted or keyless sessions. */
export function profileDirectoryChoices(
  view: ProfileDirectoryView,
): PreviewProfileDirectory | null {
  if (!view.owner) return null;
  const active = view.profiles.filter((profile) => !profile.deleted);
  const owner = active.find((profile) => profile.id === view.owner && profile.role === 'owner');
  const supported = active.filter((profile) => profile.role === 'owner' || profile.role === 'kid');
  if (
    !owner ||
    supported.some(
      (profile) =>
        !profile.libraryKey || !Number.isSafeInteger(profile.keyVersion) || profile.keyVersion < 1,
    )
  )
    return null;
  try {
    const choice = (
      profile: ProfileDirectoryView['profiles'][number],
      role: 'owner' | 'kid',
    ): ProfileChoice => ({
      id: profileId(profile.id),
      role,
      name: profile.name,
      avatar: profile.avatar ?? profile.role,
      policy: profile.policy,
      libraryKey: profile.libraryKey,
      keyVersion: profile.keyVersion,
    });
    return {
      owner: profileId(owner.id),
      profiles: supported.map((profile) =>
        choice(profile, profile.role === 'owner' ? 'owner' : 'kid'),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Profiles belong to a linked household. A browser-local library is this browser's own, and a session without a
 * model has no directory to read, so neither waits on one.
 */
export function usesProfileDirectory(session: {
  readonly local: boolean;
  readonly model: unknown;
}): boolean {
  return !session.local && !!session.model;
}

export type ProfileDirectoryState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'present'; readonly directory: PreviewProfileDirectory };

/**
 * What the directory read says. `pending` is not yet answered (including a kept household that predates a committed
 * split and has yet to read it); `absent` is answered with no directory (a household
 * before its Owner split, or a browser-local library); `invalid` is a directory that exists but cannot be opened.
 */
export function profileDirectoryState(
  view: ProfileDirectoryView | undefined,
): ProfileDirectoryState {
  if (!view) return { kind: 'pending' };
  if (view.state === 'pending') return { kind: 'pending' };
  if (view.state === 'absent') return { kind: 'absent' };
  if (view.state === 'invalid') return { kind: 'invalid' };
  const directory = profileDirectoryChoices(view);
  return directory ? { kind: 'present', directory } : { kind: 'invalid' };
}

type StorageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type StoredActiveProfile =
  | { readonly mode: 'owner' }
  | { readonly mode: 'visitor'; readonly visitId: string }
  | { readonly version: 1; readonly mode: 'persistent'; readonly profileId: string }
  | { readonly version: 1; readonly mode: 'visitor'; readonly visitorNamespace: string };

export const readActiveProfile = (storage: Storage): StoredActiveProfile | null => {
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
  readonly #ownerActivityModel;
  readonly #ownerIdentity;
  readonly #household;
  readonly #local;
  readonly #storage;
  readonly #events: StorageEvents | null;
  readonly #visitorLock: VisitorActivityLock;
  readonly #connections: LibraryModelLease<ConnectionsView>;
  #directory: PreviewProfileDirectory | null;
  readonly #profileModels: ProfileActivityModelFactory | null;
  readonly #preview: boolean;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Ownership bookkeeping; UI observes session only.
  readonly #openingModels = new Set<ProfileActivityModelHandle>();
  #pendingOwner: ProfileSession | null;
  #transition = 0;
  #restoring = $state(0);
  #disposed = false;

  constructor(
    owner: ProfileSession,
    storage: Storage = localStorage,
    events: StorageEvents | null = typeof window === 'undefined' ? null : window,
    visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
    directory: PreviewProfileDirectory | null = null,
    profileModels: ProfileActivityModelFactory | null = null,
  ) {
    if (!owner.model || owner.identity.libraryKey === null)
      throw new TypeError('Profiles require an open Owner library');
    owner.relinquishHouseholdOwnership();
    this.#ownerActivityModel = owner.model;
    this.#ownerIdentity = owner.identity;
    this.#household = owner.household;
    this.#local = owner.local;
    this.#storage = storage;
    this.#events = events;
    this.#visitorLock = visitorLock;
    this.#connections = this.#household.controlConnections();
    this.#directory = directory;
    this.#profileModels = profileModels;
    this.#preview = directory !== null && profileModels === null;
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
      if (choice?.role === 'owner' && !this.#profileModels) {
        this.#session = owner;
        this.#pendingOwner = null;
      } else if (choice?.role === 'kid' && !this.#profileModels) {
        this.#session = this.#newKid(choice);
        this.#pendingOwner = null;
        owner.close();
      } else if (choice && this.#profileModels) {
        owner.close();
        this.#pendingOwner = null;
        void this.#restorePersistent(choice);
      }
    } else if (saved?.mode === 'owner') {
      if (this.#profileModels && directory) {
        const choice = this.#choice(directory.owner);
        owner.close();
        this.#pendingOwner = null;
        if (choice) void this.#restorePersistent(choice, true);
      } else {
        this.#session = owner;
        this.#pendingOwner = null;
      }
    }
    this.#events?.addEventListener('storage', this.#storageChanged);
  }

  get session(): ProfileSession | null {
    return this.#session;
  }

  /**
   * True while a remembered profile is still opening. No session exists yet, but that is not a decision
   * that a PIN is needed; the gate waits until this is false and the session is still absent.
   */
  get restoring(): boolean {
    return this.#restoring > 0;
  }

  get mode(): ActiveProfileMode | null {
    if (this.session?.identity.kind === 'visitor') return 'visitor';
    if (this.session?.identity.kind === 'profile')
      return this.#choice(this.session.identity.id)?.role === 'owner' ? 'owner' : 'kid';
    return this.session ? 'owner' : null;
  }

  get choices(): readonly ProfileChoice[] {
    const choices: readonly ProfileChoice[] = this.#directory
      ? [
          ...this.#directory.profiles,
          { id: null, role: 'visitor' as const, name: 'Visitor', avatar: 'visitor' },
        ]
      : [
          { id: null, role: 'owner' as const, name: 'Owner', avatar: 'owner' },
          { id: null, role: 'visitor' as const, name: 'Visitor', avatar: 'visitor' },
        ];
    return choices.map((choice) => this.#publicChoice(choice)!);
  }

  get activeChoice(): ProfileChoice | null {
    if (this.mode === 'visitor')
      return { id: null, role: 'visitor', name: 'Visitor', avatar: 'visitor' };
    if (this.mode === 'owner' && this.#directory)
      return this.#publicChoice(this.#choice(this.#directory.owner));
    const id = this.session?.identity.id;
    return this.#directory && id ? this.#publicChoice(this.#choice(id)) : (this.choices[0] ?? null);
  }

  /** Undefined only while the existing Settings-owned connection view is opening. */
  get parentalPinConfigured(): boolean | undefined {
    if (this.#preview) return true;
    return this.#connections.snapshot.value?.parentalPinConfigured;
  }

  get preview(): boolean {
    return this.#preview;
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
    // With no selected session, this is explicit recovery from missing/corrupt/unsupported selection state. Its
    // Visitor object no longer exists, so retire every exact orphan namespace before Owner can open or record.
    if (!previous) await purgeOrphanVisitorNamespaces(this.#storage, this.#visitorLock);
    const ownerChoice = this.#directory ? this.#choice(this.#directory.owner) : undefined;
    const nextPersistent =
      this.#profileModels && ownerChoice ? await this.#preparePersistent(ownerChoice) : null;
    if (this.#profileModels && !nextPersistent) return false;
    const preparedAt = this.#transition;
    // Revocation and deletion take the same visit-wide lock as writes. A write wins before deletion or observes the
    // Owner marker afterward; no interleaving can recreate the namespace after the visit ends.
    if (previous?.identity.kind === 'visitor')
      try {
        await (previous as VisitorProfileSession).endVisit(() =>
          this.#commitPrepared(preparedAt, previous, this.#ownerMarker()),
        );
      } catch (error) {
        nextPersistent?.close();
        throw error;
      }
    else {
      try {
        this.#commitPrepared(preparedAt, previous, this.#ownerMarker());
      } catch (error) {
        nextPersistent?.close();
        throw error;
      }
    }
    const next = nextPersistent ?? this.#pendingOwner ?? this.#newOwner();
    this.#releasePendingOwner(next);
    this.#session = next;
    previous?.close();
    return true;
  }

  async switchToKid(pin?: string): Promise<boolean> {
    this.#assertOpen();
    const kid = this.#directory?.profiles.find((choice) => choice.role === 'kid');
    return kid?.id ? this.switchToPersistent(kid.id, pin) : false;
  }

  async switchToPersistent(target: ProfileId, pin?: string): Promise<boolean> {
    this.#assertOpen();
    const kid = this.#choice(target);
    if (!kid?.id || kid.role !== 'kid') return false;
    if (this.session?.identity.kind === 'profile' && this.session.identity.id === kid.id)
      return true;
    if (this.requiresPin('kid') && !(await this.#verifyPin(pin))) return false;
    const previous = this.#session;
    const marker = { version: 1 as const, mode: 'persistent' as const, profileId: kid.id };
    const nextPersistent = this.#profileModels ? await this.#preparePersistent(kid) : null;
    if (this.#profileModels && !nextPersistent) return false;
    const preparedAt = this.#transition;
    if (previous?.identity.kind === 'visitor')
      try {
        await (previous as VisitorProfileSession).endVisit(() =>
          this.#commitPrepared(preparedAt, previous, marker),
        );
      } catch (error) {
        nextPersistent?.close();
        throw error;
      }
    else {
      try {
        this.#commitPrepared(preparedAt, previous, marker);
      } catch (error) {
        nextPersistent?.close();
        throw error;
      }
    }
    const next = nextPersistent ?? this.#newKid(kid);
    this.#releasePendingOwner(next);
    this.#session = next;
    previous?.close();
    return true;
  }

  /** Establishes an absent/corrupt marker only after proving this household has no Owner PIN. */
  establishUnprotectedOwner(): boolean {
    if (this.#session) return true;
    // Namespace retirement is asynchronous and lock-protected. Leave the Owner gate visible so its explicit
    // `switchToOwner` path performs that cleanup before publishing Owner, even where no PIN exists.
    if (visitorNamespaceIds(this.#storage).length) return false;
    // A real Owner must open its own encrypted activity library asynchronously; never reveal the household model.
    if (this.#profileModels) {
      const saved = readActiveProfile(this.#storage);
      if (saved?.mode === 'persistent' && this.#choice(saved.profileId)) return false;
      if (saved?.mode === 'owner' || saved?.mode === 'visitor') return false;
      if (this.parentalPinConfigured !== false) return false;
      if (this.#pendingOwner) {
        try {
          keepActiveProfile(this.#storage, this.#ownerMarker());
        } catch {
          return false;
        }
        this.#session = this.#pendingOwner;
        this.#pendingOwner = null;
        return true;
      }
      void this.switchToOwner();
      return false;
    }
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
    this.#cancelOpenings();
    this.#events?.removeEventListener('storage', this.#storageChanged);
    this.#connections.release();
    this.#session?.close();
    this.#pendingOwner?.close();
    this.#household.close();
  }

  /** Replace the validated control-plane projection. A changed/removed active entry is never kept alive. */
  updateDirectory(directory: PreviewProfileDirectory | null): void {
    this.#assertOpen();
    const current = this.#session;
    const previousChoice =
      current?.identity.kind === 'profile' ? this.#choice(current.identity.id) : undefined;
    const previousOwner = this.#directory ? this.#choice(this.#directory.owner) : undefined;
    this.#directory = directory;
    if (!this.#profileModels) return;
    this.#cancelOpenings();
    if (!current) {
      const saved = readActiveProfile(this.#storage);
      const selected = saved?.mode === 'persistent' ? this.#choice(saved.profileId) : undefined;
      if (selected) void this.#restorePersistent(selected);
      else if (saved?.mode === 'visitor' && directory && this.#visitorLock.available()) {
        const visitId = 'visitorNamespace' in saved ? saved.visitorNamespace : saved.visitId;
        const next = this.#newVisitor(visitorVisitId(visitId));
        this.#releasePendingOwner(next);
        this.#session = next;
      }
      return;
    }
    if (current?.identity.kind === 'visitor') {
      const nextOwner = directory ? this.#choice(directory.owner) : undefined;
      if (directory && this.#sameContentPolicy(previousOwner?.policy, nextOwner?.policy)) return;
      const visit = current.identity.id;
      current.close();
      this.#session = directory ? this.#newVisitor(visitorVisitId(visit)) : null;
      return;
    }
    if (current?.identity.kind !== 'profile') return;
    const nextChoice = this.#choice(current.identity.id);
    if (this.#samePersistentChoice(previousChoice, nextChoice)) return;
    current.close();
    this.#session = null;
    if (nextChoice) void this.#restorePersistent(nextChoice);
  }

  #newOwner(): ProfileSession {
    return new ProfileSession(
      this.#ownerIdentity.kind === 'owner' || this.#ownerIdentity.kind === 'personal'
        ? this.#ownerIdentity
        : legacyProfileIdentity(this.#ownerIdentity.libraryKey, this.#local),
      this.#household,
      this.#ownerActivityModel,
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
        // Visitor preferences belong to the disposable visit namespace in both preview and real profile mode.
        personalPreferences: true,
        events: this.#events,
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
      if (!this.#visitorLock.available()) {
        this.#neutralize(current);
        return;
      }
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
    if (!ownerSelected && !kidSelected) {
      this.#neutralize(current);
      return;
    }
    const realChoice = persistent ?? (this.#directory ? this.#choice(this.#directory.owner) : null);
    if (this.#profileModels) {
      this.#cancelOpenings();
      const restore = () => {
        if (this.#disposed || this.#session !== current) return;
        current?.close();
        this.#session = null;
        if (realChoice) void this.#restorePersistent(realChoice, saved?.mode === 'owner');
      };
      if (current?.identity.kind === 'visitor')
        void (current as VisitorProfileSession)
          .endVisit()
          .then(restore)
          .catch(() => {});
      else restore();
      return;
    }
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

  #publicChoice(choice: ProfileChoice | undefined): ProfileChoice | null {
    if (!choice) return null;
    const { id, role, name, avatar, policy } = choice;
    return { id, role, name, avatar, ...(policy ? { policy } : {}) };
  }

  async #preparePersistent(choice: ProfileChoice): Promise<ProfileSession | null> {
    if (!choice.id || !choice.libraryKey || !this.#profileModels) return null;
    this.#cancelOpenings();
    const token = this.#transition;
    const key = choice.libraryKey;
    const handle = this.#profileModels(key);
    this.#openingModels.add(handle);
    try {
      await handle.model.ready;
    } catch {
      if (this.#openingModels.delete(handle)) handle.close();
      return null;
    }
    if (!this.#openingModels.delete(handle)) return null;
    const current = this.#choice(choice.id);
    if (
      this.#disposed ||
      token !== this.#transition ||
      !current ||
      current.libraryKey !== key ||
      current.keyVersion !== choice.keyVersion
    ) {
      handle.close();
      return null;
    }
    return activeProfileSession(
      persistentProfileIdentity(choice.id, key),
      this.#household,
      handle.model,
      () => handle.close(),
      current.policy ?? null,
      current.role === 'owner',
      current.role === 'kid',
    );
  }

  async #restorePersistent(choice: ProfileChoice, acceptLegacyOwner = false): Promise<void> {
    this.#restoring++;
    try {
      await this.#finishRestore(choice, acceptLegacyOwner);
    } finally {
      this.#restoring--;
    }
  }

  async #finishRestore(choice: ProfileChoice, acceptLegacyOwner: boolean): Promise<void> {
    const next = await this.#preparePersistent(choice);
    if (!next || this.#disposed) return;
    const saved = readActiveProfile(this.#storage);
    const selected =
      (saved?.mode === 'persistent' && saved.profileId === choice.id) ||
      (acceptLegacyOwner && saved?.mode === 'owner' && choice.role === 'owner');
    if (!selected || this.#session !== null) {
      next.close();
      return;
    }
    if (saved?.mode === 'owner')
      try {
        keepActiveProfile(this.#storage, this.#ownerMarker());
      } catch {
        next.close();
        return;
      }
    this.#releasePendingOwner(next);
    this.#session = next;
  }

  #samePersistentChoice(a: ProfileChoice | undefined, b: ProfileChoice | undefined): boolean {
    return (
      !!a &&
      !!b &&
      a.id === b.id &&
      a.libraryKey === b.libraryKey &&
      a.keyVersion === b.keyVersion &&
      this.#sameContentPolicy(a.policy, b.policy)
    );
  }

  #sameContentPolicy(
    a: ProfileContentPolicy | undefined,
    b: ProfileContentPolicy | undefined,
  ): boolean {
    if (!a || !b) return a === b;
    return a.maximumAge === b.maximumAge && a.unknownRatings === b.unknownRatings;
  }

  #neutralize(current: ProfileSession | null): void {
    this.#cancelOpenings();
    current?.close();
    this.#session = null;
  }

  #commitPrepared(
    preparedAt: number,
    previous: ProfileSession | null,
    marker: StoredActiveProfile,
  ): void {
    if (this.#disposed || preparedAt !== this.#transition || this.#session !== previous)
      throw new Error('Profile selection changed while its activity library was opening');
    keepActiveProfile(this.#storage, marker);
  }

  #cancelOpenings(): void {
    ++this.#transition;
    for (const handle of this.#openingModels) handle.close();
    this.#openingModels.clear();
  }

  #releasePendingOwner(selected: ProfileSession): void {
    const pending = this.#pendingOwner;
    this.#pendingOwner = null;
    if (pending && pending !== selected) pending.close();
  }

  #newKid(choice: ProfileChoice): ProfileSession {
    if (!choice.id) throw new TypeError('Kid profile is missing its id');
    const identity = persistentProfileIdentity(choice.id, `preview:${choice.id}`);
    const householdPolicy = isolatedProfilePolicy(
      this.#pendingOwner?.policy ?? this.#session?.policy ?? null,
    );
    const preferences = householdPolicy
      ? new PreviewProfilePreferences(identity, householdPolicy, this.#storage, this.#events)
      : null;
    return new ProfileSession(
      identity,
      this.#household,
      null,
      false,
      false,
      preferences?.policy ?? householdPolicy,
      null,
      choice.policy ?? null,
      preferences,
      null,
      false,
      true,
    );
  }

  #ownerMarker(): StoredActiveProfile {
    return this.#directory
      ? { version: 1, mode: 'persistent', profileId: this.#directory.owner }
      : { mode: 'owner' };
  }

  async #verifyPin(pin?: string): Promise<boolean> {
    if (this.#preview) return pin === '1234';
    const configured = this.parentalPinConfigured;
    if (configured === undefined) return false;
    return !configured || (!!pin && (await this.#household.verifyParentalPin(pin)));
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

/**
 * Implicit assistant work is always Owner-only, even when Kid has a real writable activity model, and never runs
 * under a fail-closed policy: a queued assistant request names its title only once opened inside the library
 * service, where no policy is asked. An Owner ceiling that admits unknown ratings keeps its assistants.
 */
export function allowsImplicitAssistant(
  coordinator: Pick<ProfileModeCoordinator, 'mode' | 'session'> | null,
  session: ProfileSession,
): boolean {
  return (
    !coordinator ||
    (coordinator.session === session && coordinator.mode === 'owner' && !session.failsClosed)
  );
}

const safeStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Whether this browser has ever held a profile selection, i.e. belongs to a profile-aware household. */
export function profileMarkerPresent(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): boolean {
  try {
    return storage?.getItem(ACTIVE_PROFILE_KEY) != null;
  } catch {
    return true;
  }
}

/**
 * Whether household administration (invites, phone links, assistant consent, saved searches) is open. A household
 * without profiles is unchanged: open while discovery is pending or says no. Once profiles are active it is open only
 * to the active Owner session, and a profile-aware browser stays closed while discovery is unanswered.
 */
export function householdAdministration(
  capability: ProfilesCapability | 'checking',
  activeOwner: boolean,
  markerPresent: boolean,
): boolean {
  switch (capability) {
    case 'disabled':
      return true;
    case 'enabled':
    case 'preview':
      return activeOwner;
    default:
      return !markerPresent;
  }
}

export type ProfilesCapability = 'enabled' | 'preview' | 'disabled' | 'indeterminate';

/** Cache-Control is a comma-separated directive list. Substring matching would accept made-up, cacheable
 * directives such as `x-no-store` or `no-store-if`; only the actual no-store directive makes the capability
 * safe to use without surviving a host-gate rollback. */
const hasNoStore = (value: string | null): boolean =>
  value?.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store') === true;

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
): Promise<ProfilesCapability> {
  try {
    const response = await fetchImpl('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!hasNoStore(response.headers.get('cache-control'))) return 'indeterminate';
    const value: unknown = await response.json();
    const disabled =
      response.status === 404 &&
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      'error' in value &&
      value.error === 'not_found';
    const enabled =
      response.ok &&
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      'enabled' in value &&
      value.enabled === true;
    const preview =
      response.ok &&
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 2 &&
      'enabled' in value &&
      value.enabled === true &&
      'preview' in value &&
      value.preview === true;
    if (disabled && !preview) return 'disabled';
    if (
      (!response.ok && !preview) ||
      !(value && typeof value === 'object') ||
      (!preview && !enabled) ||
      !visitorLock.available()
    )
      return 'indeterminate';
    await visitorLock.run('den:visitor:capability', () => {});
    return preview ? 'preview' : 'enabled';
  } catch {
    return 'indeterminate';
  }
}
