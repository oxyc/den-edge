import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type {
  ConnectionsView,
  LibraryServiceFailure,
  ProfileDirectoryView,
  TitleRef,
} from './libraryServiceProtocol';
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
import { startupMark } from './startupTiming';
import {
  crossTabVisitorActivityLock,
  purgeOrphanVisitorNamespaces,
  randomVisitorVisitId,
  VISITOR_CLEANUP_SUPERSEDED,
  visitorNamespaceIds,
  visitorProfileSession,
  type VisitorActivityLock,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';

const ACTIVE_PROFILE_KEY = 'den.profile.active.v1';

/** The Kid a household not made yet will have: offered by the switcher, and made with the household (den#295). */
const UNBORN_KID = {
  id: profileId('ffffffffffffffffffffffffffffffff'),
  role: 'kid' as const,
  name: 'Kids',
  avatar: 'kid',
  policy: { maximumAge: 12, unknownRatings: 'block' as const },
};
export type ActiveProfileMode = 'owner' | 'kid' | 'visitor';

export type ParentalControlsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly configured: boolean }
  | { readonly kind: 'failed'; readonly error: Readonly<LibraryServiceFailure> | undefined };
export type ProfileTransitionResult =
  | { readonly outcome: 'success' }
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'failed'; readonly cause: unknown }
  | { readonly outcome: 'superseded' };

const TRANSITION_SUCCESS: ProfileTransitionResult = { outcome: 'success' };
const TRANSITION_DENIED: ProfileTransitionResult = { outcome: 'denied' };
const TRANSITION_SUPERSEDED: ProfileTransitionResult = VISITOR_CLEANUP_SUPERSEDED;
export interface ProfileChoice {
  readonly id: ProfileId | null;
  readonly role: ActiveProfileMode;
  readonly name: string;
  readonly avatar: string;
  readonly policy?: ProfileContentPolicy;
  readonly approvals?: readonly { type: 'movie' | 'tv'; id: number }[];
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
  const supported = view.profiles.filter(
    (profile) => !profile.deleted && (profile.role === 'owner' || profile.role === 'kid'),
  );
  if (
    !supported.some((profile) => profile.id === view.owner && profile.role === 'owner') ||
    supported.some(
      (profile) =>
        !profile.libraryKey || !Number.isSafeInteger(profile.keyVersion) || profile.keyVersion < 1,
    )
  )
    return null;
  try {
    return {
      owner: profileId(view.owner),
      profiles: supported.map((profile) => ({
        id: profileId(profile.id),
        role: profile.role as 'owner' | 'kid',
        name: profile.name,
        avatar: profile.avatar ?? profile.role,
        policy: profile.policy,
        approvals: profile.approvals,
        libraryKey: profile.libraryKey,
        keyVersion: profile.keyVersion,
      })),
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
 * without profiles, or a browser-local library); `invalid` is a directory that exists but cannot be opened.
 */
export function profileDirectoryState(
  view: ProfileDirectoryView | undefined,
): ProfileDirectoryState {
  if (!view) return { kind: 'pending' };
  if (view.state !== 'present') return { kind: view.state };
  const directory = profileDirectoryChoices(view);
  return directory ? { kind: 'present', directory } : { kind: 'invalid' };
}

type StorageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type StoredActiveProfile =
  | { readonly mode: 'owner' }
  | { readonly mode: 'visitor'; readonly visitId: string }
  | { readonly version: 1; readonly mode: 'persistent'; readonly profileId: string }
  | { readonly version: 1; readonly mode: 'visitor'; readonly visitorNamespace: string };

type ActiveProfile =
  | { readonly mode: 'owner' }
  | { readonly mode: 'visitor'; readonly visitId: string }
  | { readonly mode: 'persistent'; readonly profileId: string };

export const readActiveProfile = (storage: Storage): ActiveProfile | null => {
  try {
    const value: unknown = JSON.parse(storage.getItem(ACTIVE_PROFILE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const marker = value as Record<string, unknown>;
    if (marker.mode === 'owner') return { mode: 'owner' };
    if (marker.mode === 'visitor') {
      const visitId = validProfileId(marker.visitId)
        ? marker.visitId
        : marker.version === 1 && validProfileId(marker.visitorNamespace)
          ? marker.visitorNamespace
          : null;
      return visitId ? { mode: 'visitor', visitId } : null;
    }
    if (marker.mode === 'persistent' && validProfileId(marker.profileId))
      return marker.version === 1 ? { mode: 'persistent', profileId: marker.profileId } : null;
  } catch {
    // Missing and damaged preferences both require establishing an Owner below.
  }
  return null;
};

const validProfileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);

/**
 * After this browser's household joined another (den#295): the profile it had open is the one it became there, a Kid
 * the Kid it merged into and the Owner the joined household's Owner (whose PIN the join asked for, when it has one). A
 * Visitor stays a Visitor. Nothing changes for a household without profiles (`owner` null).
 */
export function carryActiveProfile(
  storage: Storage,
  owner: string | null,
  kids: Readonly<Record<string, string>>,
): void {
  if (!owner) return;
  const saved = readActiveProfile(storage);
  if (saved?.mode === 'visitor') return;
  const kid = saved?.mode === 'persistent' ? kids[saved.profileId] : undefined;
  keepActiveProfile(storage, { version: 1, mode: 'persistent', profileId: kid ?? owner });
}

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
  /**
   * The Owner PIN that opened the active Kid's Settings. A successful/local or cross-tab profile switch clears it;
   * a session the directory replaces for that same Kid (its policy changed) is not a switch and keeps the unlock.
   */
  #settingsPin = $state.raw<string | null>(null);
  readonly #ownerActivityModel;
  readonly #ownerIdentity;
  readonly #household;
  readonly #local;
  readonly #storage;
  readonly #events: StorageEvents | null;
  readonly #visitorLock: VisitorActivityLock;
  readonly #connections: LibraryModelLease<ConnectionsView>;
  // Reactive: a Kid made while the page is open reaches the switcher's choices without a reload.
  #directory = $state.raw<PreviewProfileDirectory | null>(null);
  readonly #profileModels: ProfileActivityModelFactory | null;
  readonly #preview: boolean;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Ownership bookkeeping; UI observes session only.
  readonly #openingModels = new Set<ProfileActivityModelHandle>();
  #pendingOwner: ProfileSession | null;
  #transition = 0;
  #restoring = $state(0);
  #disposed = false;
  readonly #startsKid: ((pin: string) => Promise<boolean>) | null;
  #startPin: string | null = null;

  /**
   * `startsKid`, for a browser whose household is not made yet (den#295): its switcher offers the Kid it will have.
   * Choosing it takes a new Owner PIN, twice, and hands it to `startsKid`, which makes the household; true once made.
   */
  constructor(
    owner: ProfileSession,
    storage: Storage = localStorage,
    events: StorageEvents | null = typeof window === 'undefined' ? null : window,
    visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
    directory: PreviewProfileDirectory | null = null,
    profileModels: ProfileActivityModelFactory | null = null,
    startsKid: ((pin: string) => Promise<boolean>) | null = null,
  ) {
    this.#startsKid = directory ? null : startsKid;
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
    // The Owner library the page already opened is a profile library too.
    if (profileModels) this.#seedPreferences(owner.model);

    this.#storageChanged({ key: ACTIVE_PROFILE_KEY, storageArea: storage });
    this.#events?.addEventListener('storage', this.#storageChanged);
    // Reads no reactive state: the committed-household constructor runs inside a tracked effect.
    startupMark(
      'coordinator created',
      directory ? (profileModels ? 'household' : 'preview') : 'staging',
    );
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

  /**
   * Whether the active Kid's Settings are still behind the Owner PIN. The unlock lasts for the session only: leaving
   * the profile and coming back opens a new session, which is locked again. With no PIN set there is nothing to ask.
   */
  get settingsLocked(): boolean {
    return (
      this.mode === 'kid' && this.parentalPinConfigured !== false && this.#settingsPin === null
    );
  }

  /** Open the active Kid's Settings with the Owner PIN (the one that switches Kid to Owner); false when it is wrong. */
  async unlockSettings(pin: string): Promise<boolean> {
    this.#assertOpen();
    const session = this.#session;
    if (this.mode !== 'kid' || !session) return true;
    if (!(await this.#verifyPin(pin))) return false;
    if (this.#session !== session) return false;
    // Kept in memory for this unlock only: changing the Kid's policy from its Settings is authorized by the same PIN.
    this.#settingsPin = pin;
    return true;
  }

  /**
   * Change the active Kid's content policy from its unlocked Settings (profiles-v1 §5): the owner-authorized directory
   * write, authorized by the PIN that unlocked them. False when Settings are locked or the write was refused.
   */
  async setKidPolicy(policy: {
    maximumAge: number | null;
    unknownRatings: 'allow' | 'block';
  }): Promise<boolean> {
    this.#assertOpen();
    const pin = this.#settingsPin;
    const kid = this.#session;
    if (this.mode !== 'kid' || this.settingsLocked || pin === null || !kid) return false;
    try {
      return await this.#household.setKidPolicy(kid.identity.id, policy, pin);
    } catch (error) {
      console.warn('den: the Kid’s content policy could not be changed', error);
      return false;
    }
  }

  /** Owner-only, freshly PIN-authorized change to one Kid's title exception. */
  async setKidTitleApproval(
    profile: string,
    title: TitleRef,
    allow: boolean,
    pin: string,
  ): Promise<boolean> {
    this.#assertOpen();
    if (this.mode !== 'owner') return false;
    const kid = this.#choice(profile);
    if (!kid || kid.role !== 'kid' || !kid.id) return false;
    try {
      return await this.#household.setKidTitleApproval(kid.id, title, allow, pin);
    } catch (error) {
      console.warn('den: Kid title access could not be changed', error);
      return false;
    }
  }

  get mode(): ActiveProfileMode | null {
    const session = this.#session;
    if (session?.identity.kind === 'visitor') return 'visitor';
    if (session?.identity.kind === 'profile')
      return this.#choice(session.identity.id)?.role === 'owner' ? 'owner' : 'kid';
    return session ? 'owner' : null;
  }

  get choices(): readonly ProfileChoice[] {
    const choices: readonly ProfileChoice[] = this.#directory
      ? [...this.#directory.profiles, this.#visitorChoice()]
      : [
          { id: null, role: 'owner', name: 'Owner', avatar: 'owner' },
          ...(this.#startsKid ? [UNBORN_KID] : []),
          this.#visitorChoice(),
        ];
    return choices.map((choice) => this.#publicChoice(choice)!);
  }

  get activeChoice(): ProfileChoice | null {
    const mode = this.mode;
    if (mode === 'visitor') return this.#visitorChoice();
    if (mode === 'owner' && this.#directory)
      return this.#publicChoice(this.#choice(this.#directory.owner));
    const id = this.session?.identity.id;
    return this.#directory && id ? this.#publicChoice(this.#choice(id)) : (this.choices[0] ?? null);
  }

  /** A security decision is current only while its exact Connections selection is authoritative. */
  get parentalControls(): ParentalControlsState {
    if (this.#preview) return { kind: 'ready', configured: true };
    const snapshot = this.#connections.snapshot;
    if (snapshot.connection === 'ready' && snapshot.value)
      return { kind: 'ready', configured: snapshot.value.parentalPinConfigured };
    if (snapshot.connection === 'failed' || snapshot.connection === 'closed')
      return { kind: 'failed', error: snapshot.error };
    return { kind: 'loading' };
  }

  /** Undefined while parental-control authority is opening or failed; callers therefore remain fail-closed. */
  get parentalPinConfigured(): boolean | undefined {
    const state = this.parentalControls;
    return state.kind === 'ready' ? state.configured : undefined;
  }

  /** Reacquire only the failed household security selection; the ready service and its other views stay intact. */
  retryParentalControls(): boolean {
    this.#assertOpen();
    if (this.parentalControls.kind !== 'failed') return false;
    return this.#connections.rebind();
  }

  get preview(): boolean {
    return this.#preview;
  }

  /**
   * Whether choosing `target` first sets the Owner PIN (den#295): Kid is in every household from the start, and the
   * first switch to it, with no PIN yet, makes the one that brings the Owner back.
   */
  setsPin(target: ActiveProfileMode): boolean {
    const mode = this.mode;
    if (this.#startsKid) return target === 'kid' && mode !== null && mode !== 'kid';
    return (
      target === 'kid' && !this.#preview && mode === 'owner' && this.parentalPinConfigured === false
    );
  }

  /**
   * Whether choosing `target` must wait until the Owner PIN's state is known: that state decides whether the choice
   * first sets the PIN (`setsPin`), and choosing Kid before it is known would switch with none to bring the Owner back.
   */
  waitsForPin(target: ActiveProfileMode): boolean {
    return (
      !this.#startsKid &&
      target === 'kid' &&
      !this.#preview &&
      this.mode === 'owner' &&
      this.parentalPinConfigured === undefined
    );
  }

  /**
   * The Owner sets the household's Owner PIN; true once den-edge holds it. With no household yet it is kept for the
   * household the Kid choice makes (`startsKid`).
   */
  async setOwnerPin(pin: string): Promise<boolean> {
    this.#assertOpen();
    if (!/^\d{4}$/.test(pin)) return false;
    if (this.#startsKid) {
      this.#startPin = pin;
      return true;
    }
    if (this.mode !== 'owner') return false;
    return this.#household.setParentalPin(pin);
  }

  requiresPin(target: ActiveProfileMode): boolean {
    const mode = this.mode;
    if (target === mode || mode === 'owner') return false;
    if (target === 'owner') return true;
    if (mode !== 'kid' || target !== 'visitor') return false;
    const kid = this.activeChoice?.policy;
    if (!kid) return true;
    // Visitor inherits Owner policy. The preview Owner is unrestricted, so leaving Kid is a policy loosening.
    const owner = this.#directory ? this.#choice(this.#directory.owner)?.policy : undefined;
    return !owner || this.#policyIsLooser(owner, kid);
  }

  switchToVisitor(pin?: string): Promise<ProfileTransitionResult> {
    return this.#switchProfile('visitor', pin);
  }

  /**
   * A transition publishes exactly one explicit outcome. A wrong PIN is denied, an operational failure carries its
   * cause, and cancellation/key rotation/disposal is superseded without changing the active session or marker.
   */
  switchToOwner(pin?: string): Promise<ProfileTransitionResult> {
    return this.#switchProfile(null, pin);
  }

  switchToPersistent(target: ProfileId, pin?: string): Promise<ProfileTransitionResult> {
    return this.#switchProfile(target, pin);
  }

  async #switchProfile(
    target: ProfileId | 'visitor' | null,
    pin?: string,
  ): Promise<ProfileTransitionResult> {
    let opened: ProfileSession | null = null;
    if (this.#disposed) return TRANSITION_SUPERSEDED;
    const previous = this.#session;
    this.#cancelOpenings();
    const token = this.#transition;
    const assertCurrent = () => this.#assertTransition(token, previous);
    try {
      const mode: ActiveProfileMode =
        target === 'visitor' ? 'visitor' : target === null ? 'owner' : 'kid';
      let choice: ProfileChoice | undefined;
      if (mode === 'visitor') {
        if (this.mode === mode) return TRANSITION_SUCCESS;
        if (!previous || !this.#visitorLock.available())
          throw new Error('Visitor activity is unavailable');
      } else if (mode === 'owner') {
        if (this.mode === 'owner') return TRANSITION_SUCCESS;
      } else if (this.#startsKid && target === UNBORN_KID.id) {
        const chosen = this.#startPin;
        this.#startPin = null;
        if (chosen === null) return TRANSITION_DENIED;
        const started = await this.#startsKid(chosen);
        assertCurrent();
        if (!started) throw new Error('the profile household could not be started');
        return TRANSITION_SUCCESS;
      } else {
        choice = this.#choice(target as ProfileId);
        if (!choice?.id || choice.role !== 'kid') return TRANSITION_DENIED;
        if (this.session?.identity.kind === 'profile' && this.session.identity.id === choice.id)
          return TRANSITION_SUCCESS;
      }
      if (this.requiresPin(mode)) {
        const allowed = await this.#verifyPin(pin);
        assertCurrent();
        if (!allowed) return TRANSITION_DENIED;
      }
      if (mode === 'visitor') {
        const visitor = this.#newVisitor(randomVisitorVisitId());
        opened = visitor;
        await this.#visitorLock.run(`den:visitor:${visitor.identity.id}`, () => {
          assertCurrent();
          keepActiveProfile(
            this.#storage,
            this.#directory
              ? { version: 1, mode: 'visitor', visitorNamespace: visitor.identity.id }
              : { mode: 'visitor', visitId: visitor.identity.id },
          );
          this.#settingsPin = null;
          this.#session = visitor;
          previous!.close();
        });
        return TRANSITION_SUCCESS;
      }
      const owner = mode === 'owner';
      if (owner) {
        // With no selected session, this is explicit recovery from missing/corrupt/unsupported selection state. Its
        // Visitor object no longer exists, so retire every exact orphan namespace before Owner can open or record.
        if (!previous)
          await purgeOrphanVisitorNamespaces(this.#storage, this.#visitorLock, assertCurrent);
        choice = this.#directory ? this.#choice(this.#directory.owner) : undefined;
        if (this.#profileModels && !choice)
          throw new Error('the household directory names no Owner');
      }
      if (this.#profileModels && !choice?.libraryKey)
        throw new Error(`${owner ? 'the Owner profile' : choice!.name} names no activity library`);
      const marker = owner
        ? this.#ownerMarker()
        : { version: 1 as const, mode: 'persistent' as const, profileId: choice!.id! };
      const nextPersistent =
        this.#profileModels && choice ? await this.#preparePersistent(choice, false) : null;
      opened = nextPersistent;
      if (this.#profileModels && !nextPersistent) return TRANSITION_SUPERSEDED;
      // Revocation and deletion take the same visit-wide lock as writes. A write wins before deletion or observes the
      // next marker afterward; no interleaving can recreate the namespace after the visit ends.
      const commit = () => {
        assertCurrent();
        keepActiveProfile(this.#storage, marker);
      };
      if (previous?.identity.kind === 'visitor')
        await (previous as VisitorProfileSession).endVisit(commit).then(assertCurrent);
      else commit();
      const next =
        nextPersistent ??
        (owner ? (this.#pendingOwner ?? this.#newOwner()) : this.#newKid(choice!));
      this.#releasePendingOwner(next);
      this.#settingsPin = null;
      this.#session = next;
      previous?.close();
      return TRANSITION_SUCCESS;
    } catch (cause) {
      opened?.close();
      return this.#transitionCurrent(token, previous)
        ? { outcome: 'failed', cause }
        : TRANSITION_SUPERSEDED;
    }
  }

  /** Establishes an absent/corrupt marker only after proving this household has no Owner PIN. */
  establishUnprotectedOwner(): boolean {
    if (this.#session) return true;
    // Namespace retirement is asynchronous and lock-protected. Leave the Owner gate visible so its explicit
    // `switchToOwner` path performs that cleanup before publishing Owner, even where no PIN exists.
    if (visitorNamespaceIds(this.#storage).length) return false;
    if (this.#profileModels) {
      // A real Owner must open its own encrypted activity library asynchronously; never reveal the household model.
      const saved = readActiveProfile(this.#storage);
      if (saved?.mode === 'persistent' && this.#choice(saved.profileId)) return false;
      if (saved?.mode === 'owner' || saved?.mode === 'visitor') return false;
    }
    if (this.parentalPinConfigured !== false) return false;
    if (this.#profileModels && !this.#pendingOwner) {
      void this.switchToOwner();
      return false;
    }
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
    // The page hands over every replacement of the directory's lease, including ones equal to what it holds (the
    // household's other writes republish it: setting the Owner PIN on the way to a Kid does). While a profile is
    // opening, an equal one changes nothing: cancelling then threw a remembered Kid's open away and opened it twice, and
    // failed a switch to a Kid outright, which the switcher showed as a wrong PIN.
    if (
      (this.#restoring > 0 || this.#openingModels.size > 0) &&
      JSON.stringify(directory) === JSON.stringify(this.#directory)
    )
      return;
    const current = this.#session;
    const previousChoice =
      current?.identity.kind === 'profile' ? this.#choice(current.identity.id) : undefined;
    const previousOwner = this.#directory ? this.#choice(this.#directory.owner) : undefined;
    this.#directory = directory;
    this.#cancelOpenings();
    if (!this.#profileModels) return;
    if (!current) {
      const saved = readActiveProfile(this.#storage);
      // Reapply the same durable selection as a cross-tab marker change. A Visitor remains hidden while its directory
      // is absent, matching the constructor's fail-closed recovery path.
      if (saved?.mode !== 'visitor' || directory)
        this.#storageChanged({ key: ACTIVE_PROFILE_KEY, storageArea: this.#storage });
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
          return current?.mode === 'visitor' && current.visitId === visitId;
        },
        lock: this.#visitorLock,
        // Visitor preferences belong to the disposable visit namespace in both preview and real profile mode.
        personalPreferences: true,
        events: this.#events,
      },
      this.#directory ? (this.#choice(this.#directory.owner)?.policy ?? null) : null,
    );
  }

  readonly #storageChanged = (event: Pick<StorageEvent, 'key' | 'storageArea'>): void => {
    if (this.#disposed || (event.storageArea && event.storageArea !== this.#storage)) return;
    const current = this.#session;
    const visitor =
      current?.identity.kind === 'visitor' ? (current as VisitorProfileSession) : null;
    if (event.key !== ACTIVE_PROFILE_KEY) {
      if (visitor?.activity.ownsStorageKey(event.key)) visitor.reloadActivity();
      return;
    }
    this.#settingsPin = null;
    this.#cancelOpenings();
    const token = this.#transition;
    const saved = readActiveProfile(this.#storage);
    const visitId = saved?.mode === 'visitor' ? saved.visitId : null;
    if (visitId) {
      if (!this.#visitorLock.available()) {
        this.#neutralize(current);
        return;
      }
      if (visitor?.identity.id === visitId) {
        visitor.reloadActivity();
        return;
      }
    }
    const selected =
      saved?.mode === 'persistent'
        ? this.#choice(saved.profileId)
        : saved?.mode === 'owner'
          ? this.#directory
            ? this.#choice(this.#directory.owner)
            : { id: null, role: 'owner' as const, name: 'Owner', avatar: 'owner' }
          : null;
    if (!visitId && selected?.role !== 'owner' && selected?.role !== 'kid') {
      this.#neutralize(current);
      return;
    }
    const activate = () => {
      if (!this.#transitionCurrent(token, current)) return;
      current?.close();
      if (visitId) {
        const next = this.#newVisitor(visitorVisitId(visitId));
        this.#releasePendingOwner(next);
        this.#session = next;
      } else if (this.#profileModels) {
        const pending = this.#pendingOwner;
        this.#pendingOwner = null;
        if (
          pending?.identity.kind === 'profile' &&
          pending.identity.id === selected?.id &&
          pending.identity.libraryKey === selected.libraryKey
        ) {
          this.#session = pending;
        } else {
          pending?.close();
          this.#session = null;
          if (selected?.id) void this.#restorePersistent(selected, saved?.mode === 'owner');
        }
      } else {
        const next =
          selected?.role === 'kid'
            ? this.#newKid(selected)
            : (this.#pendingOwner ?? this.#newOwner());
        this.#releasePendingOwner(next);
        this.#session = next;
      }
    };
    if (visitor)
      void visitor
        .endVisit(() => this.#assertTransition(token, current))
        .then(activate)
        .catch(() => {
          // Keep Visitor visible so an explicit switch can retry failed cleanup.
        });
    else activate();
  };

  #choice(id: string): ProfileChoice | undefined {
    return this.#directory?.profiles.find((choice) => choice.id === id);
  }

  #visitorChoice(): ProfileChoice {
    return { id: null, role: 'visitor', name: 'Visitor', avatar: 'visitor' };
  }

  #publicChoice(choice: ProfileChoice | undefined): ProfileChoice | null {
    if (!choice) return null;
    const { id, role, name, avatar, policy, approvals } = choice;
    return {
      id,
      role,
      name,
      avatar,
      ...(policy ? { policy } : {}),
      ...(approvals ? { approvals } : {}),
    };
  }

  /**
   * Preferences are per profile (profiles-v1 §6): a profile library that has not decided one yet is given the older
   * household's, once. Writes carry the household's stamps, so repeating this on every open changes nothing.
   */
  #seedPreferences(profile: LibraryModel): void {
    void Promise.resolve()
      .then(() => this.#household.seedProfilePreferences(profile))
      .catch((error: unknown) => console.warn('den: profile preference seeding failed', error));
  }

  async #preparePersistent(
    choice: ProfileChoice,
    cancelExisting = true,
  ): Promise<ProfileSession | null> {
    if (!choice.id || !choice.libraryKey || !this.#profileModels) return null;
    // User selections already established their transition generation before any PIN or lock await. Restores have no
    // such generation, so they cancel older restore work here before opening a model.
    if (cancelExisting) this.#cancelOpenings();
    const token = this.#transition;
    const key = choice.libraryKey;
    const handle = this.#profileModels(key);
    this.#openingModels.add(handle);
    try {
      await handle.model.ready;
    } catch (error) {
      // Cancelled by a later selection: nothing failed. Otherwise the library itself could not be opened.
      if (!this.#openingModels.delete(handle)) return null;
      handle.close();
      throw new Error(`${choice.name}’s library could not be opened`, { cause: error });
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
    this.#seedPreferences(handle.model);
    return activeProfileSession(
      persistentProfileIdentity(choice.id, key),
      this.#household,
      handle.model,
      () => handle.close(),
      current.policy ?? null,
      current.role === 'owner',
      current.role === 'kid',
      current.approvals ?? [],
    );
  }

  async #restorePersistent(choice: ProfileChoice, acceptLegacyOwner = false): Promise<void> {
    this.#restoring++;
    let next: ProfileSession | null = null;
    try {
      next = await this.#preparePersistent(choice);
      if (!next) return;
      const saved = readActiveProfile(this.#storage);
      const selected =
        (saved?.mode === 'persistent' && saved.profileId === choice.id) ||
        (acceptLegacyOwner && saved?.mode === 'owner' && choice.role === 'owner');
      if (!selected || this.#session !== null) {
        next.close();
        return;
      }
      if (saved?.mode === 'owner') keepActiveProfile(this.#storage, this.#ownerMarker());
      this.#releasePendingOwner(next);
      this.#session = next;
    } catch (error) {
      // No one waits on a restore: the page stays at the profile gate, and the reason is logged. A failed legacy
      // marker convergence also discards the session prepared above.
      next?.close();
      console.warn('den: the remembered profile could not be opened', error);
    } finally {
      this.#restoring--;
    }
  }

  #samePersistentChoice(a: ProfileChoice | undefined, b: ProfileChoice | undefined): boolean {
    return (
      !!a &&
      !!b &&
      a.id === b.id &&
      a.libraryKey === b.libraryKey &&
      a.keyVersion === b.keyVersion &&
      this.#sameContentPolicy(a.policy, b.policy) &&
      this.#sameApprovals(a.approvals, b.approvals)
    );
  }

  #sameApprovals(a: ProfileChoice['approvals'], b: ProfileChoice['approvals']): boolean {
    if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
    if (!a?.length) return true;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- One immutable comparison index.
    const keys = new Set(a.map(({ type, id }) => `${type}:${id}`));
    return b!.every(({ type, id }) => keys.has(`${type}:${id}`));
  }

  #sameContentPolicy(
    a: ProfileContentPolicy | undefined,
    b: ProfileContentPolicy | undefined,
  ): boolean {
    if (!a || !b) return a === b;
    return a.maximumAge === b.maximumAge && a.unknownRatings === b.unknownRatings;
  }

  #neutralize(current: ProfileSession | null): void {
    current?.close();
    this.#session = null;
  }

  #transitionCurrent(token: number, previous: ProfileSession | null): boolean {
    return !this.#disposed && token === this.#transition && this.#session === previous;
  }

  #assertTransition(token: number, previous: ProfileSession | null): void {
    if (!this.#transitionCurrent(token, previous)) throw TRANSITION_SUPERSEDED;
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
      choice.approvals ?? [],
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
  return capability === 'disabled'
    ? true
    : capability === 'enabled' || capability === 'preview'
      ? activeOwner
      : !markerPresent;
}

export type ProfilesCapability = 'enabled' | 'preview' | 'disabled' | 'indeterminate';

/** Cache-Control is a comma-separated directive list. Substring matching would accept made-up, cacheable
 * directives such as `x-no-store` or `no-store-if`; only the actual no-store directive makes the capability
 * safe to use without surviving a host-gate rollback. */
const hasNoStore = (value: string | null): boolean =>
  /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value ?? '');

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

/** The page's host answer and question in flight. A profile household can open several sessions in sequence. */
let knownCapability: Exclude<ProfilesCapability, 'indeterminate'> | undefined;
let askingCapability: Promise<ProfilesCapability> | undefined;

export function profilesCapability(
  fetchImpl?: typeof fetch,
  visitorLock?: VisitorActivityLock,
): Promise<ProfilesCapability> {
  // Only the page's own question is shared; an injected fetch or lock asks its own.
  if (fetchImpl || visitorLock) return askProfilesCapability(fetchImpl, visitorLock);
  if (knownCapability) return Promise.resolve(knownCapability);
  askingCapability ??= askProfilesCapability()
    .then((answer) => {
      // Enabled, preview and the exact disabled response are stable properties of this deployed host. Keep them for
      // the page lifetime; an uncertain network/protocol answer is deliberately retried by the next caller.
      if (answer !== 'indeterminate') knownCapability = answer;
      return answer;
    })
    .finally(() => (askingCapability = undefined));
  return askingCapability;
}

async function askProfilesCapability(
  fetchImpl: typeof fetch = fetch,
  visitorLock: VisitorActivityLock = crossTabVisitorActivityLock,
): Promise<ProfilesCapability> {
  const askedAt = performance.now();
  startupMark('capability requested');
  const answer = await readProfilesCapability(fetchImpl, visitorLock);
  startupMark('capability answered', `${answer} in ${Math.round(performance.now() - askedAt)}ms`);
  return answer;
}

/** Only an explicit, valid disabled answer may reveal the legacy Owner path. Every failure stays neutral. */
async function readProfilesCapability(
  fetchImpl: typeof fetch,
  visitorLock: VisitorActivityLock,
): Promise<ProfilesCapability> {
  try {
    const response = await fetchImpl('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!hasNoStore(response.headers.get('cache-control'))) return 'indeterminate';
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return 'indeterminate';
    const body = value as Record<string, unknown>;
    const keys = Object.keys(body).length;
    if (response.status === 404 && keys === 1 && body.error === 'not_found') return 'disabled';
    const preview = response.ok && keys === 2 && body.enabled === true && body.preview === true;
    if (
      !response.ok ||
      (!preview && !(keys === 1 && body.enabled === true)) ||
      !visitorLock.available()
    )
      return 'indeterminate';
    await visitorLock.run('den:visitor:capability', () => {});
    return preview ? 'preview' : 'enabled';
  } catch {
    return 'indeterminate';
  }
}
