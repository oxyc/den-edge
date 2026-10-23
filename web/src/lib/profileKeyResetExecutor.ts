import { exclusive } from './exclusive';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import type { ProfileKidCreateVault } from './profileKidCreateWorker';
import { profilesMaterialize, profilesResetNext, profilesRotateLibrary } from './profilesCore';
import { Clock, compareStamps, deriveLibraryId, ZERO_STAMP, type Stamp } from './wire';

/*
 * Dormant, UI-free executor for profiles-v1 §9: one crash-safe compound key reset that rotates the household and
 * every live persistent profile library. It chooses no lifecycle policy: each copy, publish, retirement and
 * completion step is what den-core's `profiles_reset_next` asks for. The only sequencing added here is acquiring one
 * exclusive lock set before den-core is consulted, and persisting the intent of every effect before performing it.
 */

export type ProfileResetErrorCode =
  | 'reset-already-pending'
  | 'invalid-attempt'
  | 'invalid-household-key'
  | 'invalid-fence'
  | 'invalid-directory'
  | 'random-key-failure'
  | 'corrupt-journal'
  | 'invalid-locks'
  | 'invalid-profile-verification'
  | 'successor-not-verified';

export class ProfileResetError extends Error {
  constructor(readonly code: ProfileResetErrorCode) {
    super(`Profile key reset refused: ${code}`);
    this.name = 'ProfileResetError';
  }
}

/**
 * A refusal den-edge will repeat for the same request (a moved source, a lock held by someone else, a successor that
 * is not ready). Before the successor commit nothing irreversible has happened, so the executor releases the locks
 * (profiles-v1 §9.1 *Abort*) and discards the journal; a retry generates entirely new keys.
 */
export class ProfileResetRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`Profile key reset refused by den-edge: ${reason}`);
    this.name = 'ProfileResetRefusedError';
  }
}

/** den-edge ended this attempt (an abort, or a recovery's rollback): nothing was adopted, so the journal is void. */
export class ProfileResetRolledBackError extends Error {
  constructor() {
    super('Profile key reset was rolled back by den-edge');
    this.name = 'ProfileResetRolledBackError';
  }
}

export type ProfileResetPhase =
  | 'prepared'
  | 'locked'
  | 'moving-profiles'
  | 'publishing-household'
  | 'commit-unknown'
  | 'retiring-old'
  | 'adopting'
  | 'complete';

export type ProfileResetEffectIntent =
  | { readonly kind: 'move-profile'; readonly profile: string }
  | { readonly kind: 'publish-household' }
  | { readonly kind: 'verify-household' }
  | { readonly kind: 'retire-profile'; readonly profile: string }
  | { readonly kind: 'retire-household' }
  | { readonly kind: 'adopt-successor' }
  | { readonly kind: 'verify-adoption' };

export interface ProfileResetFence {
  readonly generation: number;
  readonly head: string;
}

export interface ProfileResetEvidence {
  readonly profile: string;
  /** Standard padded base64 of the 32-byte library keys, exactly as the directory carries them. */
  readonly oldKey: string;
  readonly newKey: string;
  readonly oldVersion: number;
  readonly newVersion: number;
  copiedHead: string | null;
  verified: boolean;
  oldRetired: boolean;
}

export interface ProfileResetLockHandle {
  readonly libraryId: string;
  readonly value: string;
}

export interface ProfileResetLockSet {
  readonly attempt: string;
  readonly household: ProfileResetLockHandle;
  readonly profiles: Readonly<Record<string, ProfileResetLockHandle>>;
}

/**
 * The durable attempt. It holds every old and successor key needed to resume after the tab dies, so a backend MUST
 * keep it in the household-sealed secure store (see `VaultProfileResetJournal`) and never anywhere else.
 */
export interface ProfileResetJournal {
  readonly version: 1;
  readonly attempt: string;
  /** The committed directory the attempt was authorized against. */
  readonly directory: ProfileDirectoryDocument;
  readonly fence: ProfileResetFence;
  readonly oldHouseholdKey: string;
  readonly newHouseholdKey: string;
  /** One stamp later than every stamped directory field observed at authorization time. */
  readonly resetStamp: Stamp;
  profiles: ProfileResetEvidence[];
  locks: ProfileResetLockSet | null;
  successorDirectory: ProfileDirectoryDocument | null;
  successorHouseholdHead: string | null;
  householdCommitted: boolean;
  oldHouseholdRetired: boolean;
  phase: ProfileResetPhase;
  pending: ProfileResetEffectIntent | null;
}

export interface ProfileResetLockRequest {
  readonly attempt: string;
  readonly fence: ProfileResetFence;
  readonly household: { readonly libraryId: string; readonly key: string };
  readonly profiles: Readonly<Record<string, { readonly libraryId: string; readonly key: string }>>;
  /** The library ids of the successor keys, which the household lock declares (§9.1 *Acquire*); ids reveal no key. */
  readonly successors: {
    readonly household: string;
    readonly profiles: Readonly<Record<string, string>>;
  };
}

export interface ProfileMoveRequest {
  readonly attempt: string;
  readonly profile: string;
  readonly oldKey: string;
  readonly newKey: string;
  readonly locks: ProfileResetLockSet;
}

export interface VerifiedProfileMove {
  readonly profile: string;
  readonly successorLibraryId: string;
  /** Authenticated digest of the complete successor library after readback. */
  readonly copiedHead: string;
}

export interface HouseholdPublishRequest {
  readonly attempt: string;
  readonly oldKey: string;
  readonly newKey: string;
  readonly fence: ProfileResetFence;
  readonly directory: ProfileDirectoryDocument;
  readonly locks: ProfileResetLockSet;
}

export interface HouseholdObservationRequest {
  readonly attempt: string;
  readonly successorKey: string;
  /** The directory the successor household must hold before den-edge is asked to commit it. */
  readonly directory: ProfileDirectoryDocument;
  readonly locks: ProfileResetLockSet;
}

export interface ProfileResetAbortRequest {
  readonly attempt: string;
  readonly household: { readonly libraryId: string; readonly key: string };
}

export type HouseholdObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'committed';
      readonly libraryId: string;
      readonly head: string;
      readonly directory: ProfileDirectoryDocument;
    };

export interface ProfileRetirementRequest {
  readonly attempt: string;
  readonly profile: string;
  readonly oldKey: string;
  readonly successorLibraryId: string;
  readonly locks: ProfileResetLockSet;
}

export interface HouseholdRetirementRequest {
  readonly attempt: string;
  readonly oldKey: string;
  readonly successorLibraryId: string;
  readonly locks: ProfileResetLockSet;
}

export interface ProfileAdoptionRequest {
  readonly attempt: string;
  readonly householdKey: string;
  readonly committedHead: string;
  readonly directory: ProfileDirectoryDocument;
  readonly locks: ProfileResetLockSet;
}

/**
 * The storage and network boundary of a compound reset. The executor performs no I/O of its own.
 *
 * Every mutating call receives the exact exclusive lock set acquired for the attempt. The backend MUST reject an
 * expired, mismatched or incomplete set before touching a library. Moving a profile means the complete library-v4
 * §12 reseal and authenticated readback of the successor, including delivery documents.
 */
export interface ProfileKeyResetBackend {
  loadJournal(): Promise<ProfileResetJournal | null>;
  /** Durable (secure storage) before it resolves; the executor performs an effect only after this has. */
  persistJournal(journal: ProfileResetJournal): Promise<void>;
  /** Erase the journal and every attempt-scoped old/candidate credential copy, idempotently. */
  clearJournal(attempt: string): Promise<void>;

  /** Exclusively lock the household and every live profile library at their exact authenticated state. */
  acquireLocks(request: ProfileResetLockRequest): Promise<ProfileResetLockSet>;
  /**
   * Release the whole set with the one household abort commit, valid only before the successor commit. Idempotent;
   * `committed` means den-edge refused because the successor household is already committed, so nothing was released.
   */
  abortReset(request: ProfileResetAbortRequest): Promise<'aborted' | 'committed'>;
  /** Idempotent for `(attempt, profile, newKey)`, including when the previous response was lost. */
  moveAndVerifyProfile(request: ProfileMoveRequest): Promise<VerifiedProfileMove>;
  /** Idempotent for the attempt and exact successor key and directory. */
  publishSuccessorHousehold(request: HouseholdPublishRequest): Promise<void>;
  /** Authenticated lookup of the successor household, the only way an ambiguous publish is settled. */
  observeSuccessorHousehold(request: HouseholdObservationRequest): Promise<HouseholdObservation>;
  /** Idempotent: an already-retired old library is success only when it names this successor. */
  retireProfileLibrary(request: ProfileRetirementRequest): Promise<void>;
  /** Idempotent: an already-retired old household is success only when it names this successor. */
  retireHouseholdLibrary(request: HouseholdRetirementRequest): Promise<void>;
  /**
   * Atomically replace the old household credential with the successor and activate its directory-backed topology.
   * The old household credential must not remain installed. Profile keys stay owned by that directory.
   */
  adoptSuccessor(request: ProfileAdoptionRequest): Promise<void>;
  /** Authenticated local readback of the exact installed household credential and active successor topology. */
  successorIsAdopted(request: ProfileAdoptionRequest): Promise<boolean>;
}

export interface ProfileKeyResetOptions {
  /** 32 random bytes. */
  readonly randomKey?: () => Uint8Array;
  /** A 32-character lowercase-hex attempt id. */
  readonly randomAttempt?: () => string;
  readonly now?: () => number;
}

export interface ProfileResetStatus {
  /** `aborted`: the locks were released (or den-edge rolled the attempt back) and the journal is gone. */
  readonly phase: ProfileResetPhase | 'aborted';
  readonly verifiedProfiles: number;
  readonly profileCount: number;
}

const ATTEMPT = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTOR = /^[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const PHASES: readonly ProfileResetPhase[] = [
  'prepared',
  'locked',
  'moving-profiles',
  'publishing-household',
  'commit-unknown',
  'retiring-old',
  'adopting',
  'complete',
];
const MAX_KEY_ATTEMPTS = 32;

/** Runs one reset per browser; every call is serialized, and each performs at most one effect. */
export class ProfileKeyResetExecutor {
  constructor(
    private readonly backend: ProfileKeyResetBackend,
    private readonly options: ProfileKeyResetOptions = {},
  ) {}

  status(): Promise<ProfileResetStatus | null> {
    return this.locked(async () => {
      const journal = await this.backend.loadJournal();
      if (!journal) return null;
      await this.validate(journal);
      return statusOf(journal);
    });
  }

  /**
   * Begin one reset from a freshly authenticated household snapshot. Every successor credential is generated and
   * persisted before the first lock or network effect. A caller must put this behind fresh Owner-PIN authority.
   */
  start(
    directory: ProfileDirectoryDocument,
    householdKey: string,
    fence: ProfileResetFence,
    /** A successor household key the caller already holds (the page's prepared key); otherwise one is generated. */
    successorHouseholdKey?: string,
  ): Promise<ProfileResetStatus> {
    return this.locked(async () => {
      if ((await this.backend.loadJournal()) !== null)
        throw new ProfileResetError('reset-already-pending');
      if (!canonicalKey(householdKey)) throw new ProfileResetError('invalid-household-key');
      checkedFence(fence);
      let document: ProfileDirectoryDocument;
      try {
        document = validateStoredProfileDirectory(structuredClone(directory));
      } catch {
        throw new ProfileResetError('invalid-directory');
      }
      const attempt = (this.options.randomAttempt ?? randomAttempt)();
      if (!ATTEMPT.test(attempt)) throw new ProfileResetError('invalid-attempt');
      const device = (await libraryId(householdKey)).slice(0, 16);
      const resetStamp = new Clock(device, latestStamp(document)).issue(
        (this.options.now ?? Date.now)(),
      );

      const live = liveEntries(document);
      const liveKeys = new Set([householdKey, ...live.map((entry) => entry.library.value.key)]);
      if (liveKeys.size !== live.length + 1) throw new ProfileResetError('invalid-directory');
      // A successor key also never equals a deleted profile's retired key.
      const used = new Set([
        ...liveKeys,
        ...Object.values(document.profiles).map((entry) => entry.library.value.key),
      ]);
      const freshKey = (): string => {
        for (let attemptNumber = 0; attemptNumber < MAX_KEY_ATTEMPTS; attemptNumber += 1) {
          const raw = (this.options.randomKey ?? randomKey)();
          const candidate = raw.length === 32 ? base64(raw) : null;
          raw.fill(0);
          if (candidate === null) throw new ProfileResetError('random-key-failure');
          if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
          }
        }
        throw new ProfileResetError('random-key-failure');
      };
      let newHouseholdKey: string;
      if (successorHouseholdKey === undefined) newHouseholdKey = freshKey();
      else {
        if (!canonicalKey(successorHouseholdKey) || used.has(successorHouseholdKey))
          throw new ProfileResetError('invalid-household-key');
        used.add(successorHouseholdKey);
        newHouseholdKey = successorHouseholdKey;
      }
      const profiles = live.map((entry): ProfileResetEvidence => {
        const { keyVersion, key } = entry.library.value;
        if (!Number.isSafeInteger(keyVersion) || keyVersion >= 0xffff_ffff)
          throw new ProfileResetError('invalid-directory');
        return {
          profile: entry.id,
          oldKey: key,
          newKey: freshKey(),
          oldVersion: keyVersion,
          newVersion: keyVersion + 1,
          copiedHead: null,
          verified: false,
          oldRetired: false,
        };
      });
      const journal: ProfileResetJournal = {
        version: 1,
        attempt,
        directory: document,
        fence: { generation: fence.generation, head: fence.head },
        oldHouseholdKey: householdKey,
        newHouseholdKey,
        resetStamp,
        profiles,
        locks: null,
        successorDirectory: null,
        successorHouseholdHead: null,
        householdCommitted: false,
        oldHouseholdRetired: false,
        phase: 'prepared',
        pending: null,
      };
      await this.validate(journal);
      await this.persist(journal);
      return this.guarded(journal, () => this.drive(journal));
    });
  }

  /** Resume only the exact durable attempt. It never creates credentials or substitutes current app state. */
  resume(): Promise<ProfileResetStatus | null> {
    return this.locked(async () => {
      const journal = await this.backend.loadJournal();
      if (!journal) return null;
      await this.validate(journal);
      return this.guarded(journal, () => this.drive(journal));
    });
  }

  /**
   * Ends the attempt when den-edge says it is over. A repeatable refusal before the successor commit releases the
   * locks and discards the journal; a rollback by a recovery only discards it. Any other failure keeps the journal.
   */
  private async guarded(
    journal: ProfileResetJournal,
    work: () => Promise<ProfileResetStatus>,
  ): Promise<ProfileResetStatus> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProfileResetRolledBackError && journal.phase !== 'complete')
        return this.discard(journal);
      if (error instanceof ProfileResetRefusedError && !journal.householdCommitted) {
        const request: ProfileResetAbortRequest = {
          attempt: journal.attempt,
          household: {
            libraryId: await libraryId(journal.oldHouseholdKey),
            key: journal.oldHouseholdKey,
          },
        };
        // A lost abort response leaves the journal, so the next resume refuses again and repeats the idempotent abort.
        if ((await this.backend.abortReset(request)) === 'aborted') return this.discard(journal);
      }
      throw error;
    }
  }

  private async discard(journal: ProfileResetJournal): Promise<ProfileResetStatus> {
    await this.backend.clearJournal(journal.attempt);
    return {
      phase: 'aborted',
      verifiedProfiles: journal.profiles.filter((p) => p.verified).length,
      profileCount: journal.profiles.length,
    };
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return exclusive('den.profileKeyReset', work);
  }

  private persist(journal: ProfileResetJournal): Promise<void> {
    // The backend owns what it stores; a retained reference must never see later in-memory edits.
    return this.backend.persistJournal(structuredClone(journal));
  }

  // One effect per call keeps process-death boundaries explicit and every network operation replayable.
  private async drive(journal: ProfileResetJournal): Promise<ProfileResetStatus> {
    if (journal.phase === 'complete') return statusOf(journal);
    if (journal.locks === null) {
      journal.phase = 'prepared';
      await this.persist(journal);
      const locks = await this.backend.acquireLocks(await lockRequest(journal));
      await this.validateLocks(locks, journal);
      journal.locks = locks;
      journal.phase = 'locked';
      await this.persist(journal);
      return statusOf(journal);
    }
    if (journal.pending !== null) {
      await this.perform(journal.pending, journal, journal.locks);
      return statusOf(journal);
    }

    let decision: ReturnType<typeof profilesResetNext>;
    try {
      decision = profilesResetNext(plannerInput(journal));
    } catch {
      throw new ProfileResetError('corrupt-journal');
    }
    switch (decision.effect) {
      case 'move-live-profiles': {
        const profile = decision.profiles[0];
        if (!profile || !journal.profiles.some((p) => p.profile === profile && !p.verified))
          throw new ProfileResetError('corrupt-journal');
        journal.phase = 'moving-profiles';
        journal.pending = { kind: 'move-profile', profile };
        break;
      }
      case 'commit-successor-household':
        if (!journal.profiles.every((p) => p.verified))
          throw new ProfileResetError('corrupt-journal');
        journal.successorDirectory ??= successorDirectory(journal);
        journal.phase = 'publishing-household';
        journal.pending = { kind: 'publish-household' };
        break;
      case 'retire-old-libraries': {
        if (!journal.householdCommitted || journal.successorDirectory === null)
          throw new ProfileResetError('corrupt-journal');
        journal.phase = 'retiring-old';
        const profile = decision.profiles[0];
        if (profile) journal.pending = { kind: 'retire-profile', profile };
        else if (decision.household) journal.pending = { kind: 'retire-household' };
        else throw new ProfileResetError('corrupt-journal');
        break;
      }
      case 'complete':
        if (
          !journal.householdCommitted ||
          !journal.oldHouseholdRetired ||
          !journal.profiles.every((p) => p.oldRetired)
        )
          throw new ProfileResetError('corrupt-journal');
        journal.phase = 'adopting';
        journal.pending = { kind: 'adopt-successor' };
        break;
    }
    await this.persist(journal);
    return statusOf(journal);
  }

  private async perform(
    effect: ProfileResetEffectIntent,
    journal: ProfileResetJournal,
    locks: ProfileResetLockSet,
  ): Promise<void> {
    switch (effect.kind) {
      case 'move-profile': {
        const evidence = journal.profiles.find((p) => p.profile === effect.profile && !p.verified);
        if (!evidence) throw new ProfileResetError('corrupt-journal');
        const verified = await this.backend.moveAndVerifyProfile({
          attempt: journal.attempt,
          profile: effect.profile,
          oldKey: evidence.oldKey,
          newKey: evidence.newKey,
          locks,
        });
        if (
          verified.profile !== effect.profile ||
          verified.successorLibraryId !== (await libraryId(evidence.newKey)) ||
          !DIGEST.test(verified.copiedHead)
        )
          throw new ProfileResetError('invalid-profile-verification');
        evidence.copiedHead = verified.copiedHead;
        evidence.verified = true;
        journal.pending = null;
        journal.phase = 'locked';
        await this.persist(journal);
        return;
      }
      case 'publish-household': {
        const directory = journal.successorDirectory;
        if (directory === null) throw new ProfileResetError('corrupt-journal');
        // The durable lookup marker is written before publication. A killed process therefore looks up the exact
        // successor rather than issuing a differently constructed commit.
        journal.pending = { kind: 'verify-household' };
        journal.phase = 'commit-unknown';
        await this.persist(journal);
        await this.backend.publishSuccessorHousehold({
          attempt: journal.attempt,
          oldKey: journal.oldHouseholdKey,
          newKey: journal.newHouseholdKey,
          fence: journal.fence,
          directory,
          locks,
        });
        return;
      }
      case 'verify-household': {
        if (journal.successorDirectory === null) throw new ProfileResetError('corrupt-journal');
        const observed = await this.backend.observeSuccessorHousehold({
          attempt: journal.attempt,
          successorKey: journal.newHouseholdKey,
          directory: journal.successorDirectory,
          locks,
        });
        if (observed.kind === 'absent') {
          journal.pending = { kind: 'publish-household' };
          journal.phase = 'publishing-household';
        } else if (observed.kind === 'unknown') {
          journal.phase = 'commit-unknown';
        } else {
          const expected = journal.successorDirectory;
          if (
            observed.libraryId !== (await libraryId(journal.newHouseholdKey)) ||
            !DIGEST.test(observed.head) ||
            expected === null ||
            !sameDirectory(observed.directory, expected)
          )
            throw new ProfileResetError('successor-not-verified');
          journal.successorHouseholdHead = observed.head;
          journal.householdCommitted = true;
          journal.pending = null;
          journal.phase = 'retiring-old';
        }
        await this.persist(journal);
        return;
      }
      case 'retire-profile': {
        const evidence = journal.profiles.find(
          (p) => p.profile === effect.profile && !p.oldRetired,
        );
        if (!journal.householdCommitted || !evidence)
          throw new ProfileResetError('corrupt-journal');
        await this.backend.retireProfileLibrary({
          attempt: journal.attempt,
          profile: effect.profile,
          oldKey: evidence.oldKey,
          successorLibraryId: await libraryId(evidence.newKey),
          locks,
        });
        evidence.oldRetired = true;
        journal.pending = null;
        await this.persist(journal);
        return;
      }
      case 'retire-household':
        if (!journal.householdCommitted || journal.oldHouseholdRetired)
          throw new ProfileResetError('corrupt-journal');
        await this.backend.retireHouseholdLibrary({
          attempt: journal.attempt,
          oldKey: journal.oldHouseholdKey,
          successorLibraryId: await libraryId(journal.newHouseholdKey),
          locks,
        });
        journal.oldHouseholdRetired = true;
        journal.pending = null;
        await this.persist(journal);
        return;
      case 'adopt-successor': {
        const request = adoptionRequest(journal, locks);
        // As with publication, lookup-first recovery is durable before the possibly successful call.
        journal.pending = { kind: 'verify-adoption' };
        await this.persist(journal);
        await this.backend.adoptSuccessor(request);
        return;
      }
      case 'verify-adoption': {
        if (!(await this.backend.successorIsAdopted(adoptionRequest(journal, locks)))) {
          journal.pending = { kind: 'adopt-successor' };
          await this.persist(journal);
          return;
        }
        // The journal is the last copy of the old and provisional credentials. It is erased only after exact
        // adoption readback; a lost clear response is safe because the next load finds either this verify marker
        // or no journal at all.
        journal.phase = 'complete';
        journal.pending = null;
        await this.backend.clearJournal(journal.attempt);
        return;
      }
    }
  }

  /** The backend's answer must be exactly one distinct, non-empty handle per library of this attempt. */
  private async validateLocks(locks: ProfileResetLockSet, journal: ProfileResetJournal) {
    const expected = await lockRequest(journal);
    const ids = Object.keys(expected.profiles);
    if (!record(locks) || !record(locks.household) || !record(locks.profiles))
      throw new ProfileResetError('invalid-locks');
    const handles = [locks.household, ...ids.map((id) => locks.profiles[id])];
    if (
      locks.attempt !== journal.attempt ||
      locks.household.libraryId !== expected.household.libraryId ||
      !handles.every((handle) => typeof handle?.value === 'string' && handle.value !== '') ||
      Object.keys(locks.profiles).length !== ids.length ||
      new Set(handles.map((handle) => handle!.value)).size !== handles.length ||
      !ids.every((id) => locks.profiles[id]?.libraryId === expected.profiles[id]!.libraryId)
    )
      throw new ProfileResetError('invalid-locks');
  }

  // One cross-field trust-boundary validation: the invariants belong together.
  private async validate(journal: ProfileResetJournal): Promise<void> {
    const corrupt = () => new ProfileResetError('corrupt-journal');
    if (
      !record(journal) ||
      journal.version !== 1 ||
      !ATTEMPT.test(String(journal.attempt)) ||
      !canonicalKey(journal.oldHouseholdKey) ||
      !canonicalKey(journal.newHouseholdKey) ||
      journal.oldHouseholdKey === journal.newHouseholdKey ||
      !PHASES.includes(journal.phase)
    )
      throw corrupt();
    try {
      checkedFence(journal.fence);
    } catch {
      throw corrupt();
    }
    let directory: ProfileDirectoryDocument;
    let previous: Stamp;
    try {
      directory = validateStoredProfileDirectory(journal.directory);
      previous = latestStamp(directory);
    } catch {
      throw corrupt();
    }
    if (
      !stamp(journal.resetStamp) ||
      compareStamps(journal.resetStamp, previous) <= 0 ||
      journal.resetStamp[2] !== (await libraryId(journal.oldHouseholdKey)).slice(0, 16)
    )
      throw corrupt();

    const live = liveEntries(directory);
    if (!Array.isArray(journal.profiles)) throw corrupt();
    const ids = journal.profiles.map((evidence) => (record(evidence) ? evidence.profile : ''));
    if (
      ids.join() !== [...ids].sort().join() ||
      new Set(ids).size !== ids.length ||
      ids.join() !== live.map(({ id }) => id).join() ||
      !journal.profiles.every((evidence) => {
        const entry = directory.profiles[evidence.profile];
        return (
          record(evidence) &&
          canonicalKey(evidence.oldKey) &&
          canonicalKey(evidence.newKey) &&
          entry?.library.value.key === evidence.oldKey &&
          entry.library.value.keyVersion === evidence.oldVersion &&
          evidence.newVersion === evidence.oldVersion + 1 &&
          typeof evidence.verified === 'boolean' &&
          typeof evidence.oldRetired === 'boolean' &&
          evidence.verified === (evidence.copiedHead !== null) &&
          (evidence.copiedHead === null || DIGEST.test(evidence.copiedHead))
        );
      })
    )
      throw corrupt();
    const oldKeys = [...journal.profiles.map((p) => p.oldKey), journal.oldHouseholdKey];
    const newKeys = [...journal.profiles.map((p) => p.newKey), journal.newHouseholdKey];
    if (
      new Set(oldKeys).size !== oldKeys.length ||
      new Set(newKeys).size !== newKeys.length ||
      oldKeys.some((key) => newKeys.includes(key))
    )
      throw corrupt();

    const allVerified = journal.profiles.every((p) => p.verified);
    if (
      typeof journal.householdCommitted !== 'boolean' ||
      typeof journal.oldHouseholdRetired !== 'boolean' ||
      (journal.oldHouseholdRetired && !journal.householdCommitted) ||
      (journal.profiles.some((p) => p.oldRetired) && !journal.householdCommitted) ||
      (journal.householdCommitted && !allVerified) ||
      (journal.successorDirectory !== null && !allVerified) ||
      (journal.householdCommitted && journal.successorDirectory === null) ||
      (journal.successorHouseholdHead !== null) !== journal.householdCommitted ||
      (journal.successorHouseholdHead !== null && !DIGEST.test(journal.successorHouseholdHead))
    )
      throw corrupt();
    if (journal.locks !== null) {
      try {
        await this.validateLocks(journal.locks, journal);
      } catch {
        throw corrupt();
      }
    }
    if (journal.successorDirectory !== null) {
      let recomputed: ProfileDirectoryDocument;
      try {
        recomputed = successorDirectory(journal);
      } catch {
        throw corrupt();
      }
      if (!sameDirectory(journal.successorDirectory, recomputed)) throw corrupt();
    }
    if (!validPhase(journal)) throw corrupt();
    try {
      profilesResetNext(plannerInput(journal));
    } catch {
      throw corrupt();
    }
  }
}

const NAME = 'profile-reset/v1/journal';

/** The durable journal over the household-sealed vault the Worker already uses for its other crash journals. */
export class VaultProfileResetJournal {
  constructor(private readonly vault: ProfileKidCreateVault) {}

  async load(): Promise<ProfileResetJournal | null> {
    const kept = await this.vault.keptRequired<ProfileResetJournal>(NAME, this.binding());
    return kept.kind === 'absent' ? null : kept.value;
  }

  async persist(journal: ProfileResetJournal): Promise<void> {
    await this.vault.keepRequired(NAME, journal, this.binding());
  }

  /** Idempotent; refuses to erase a different attempt's journal. */
  async clear(attempt: string): Promise<void> {
    const current = await this.load();
    if (current === null) return;
    if (current.attempt !== attempt)
      throw new Error('Profile reset journal belongs to another attempt');
    await this.vault.discardKept(NAME);
  }

  private binding(): string {
    return `profile-reset:${this.vault.libraryId}:1`;
  }
}

function statusOf(journal: ProfileResetJournal): ProfileResetStatus {
  return {
    phase: journal.phase,
    verifiedProfiles: journal.profiles.filter((p) => p.verified).length,
    profileCount: journal.profiles.length,
  };
}

function validPhase(journal: ProfileResetJournal): boolean {
  const pending = journal.pending?.kind ?? null;
  const retired =
    journal.householdCommitted &&
    journal.oldHouseholdRetired &&
    journal.profiles.every((p) => p.oldRetired);
  switch (journal.phase) {
    case 'prepared':
      return pending === null && journal.locks === null;
    case 'locked':
      return pending === null && journal.locks !== null && !journal.householdCommitted;
    case 'moving-profiles':
      return pending === 'move-profile' && journal.locks !== null && !journal.householdCommitted;
    case 'publishing-household':
      return (
        pending === 'publish-household' &&
        journal.successorDirectory !== null &&
        !journal.householdCommitted
      );
    case 'commit-unknown':
      return (
        pending === 'verify-household' &&
        journal.successorDirectory !== null &&
        !journal.householdCommitted
      );
    case 'retiring-old':
      return (
        journal.householdCommitted &&
        (pending === null || pending === 'retire-profile' || pending === 'retire-household')
      );
    case 'adopting':
      return (pending === 'adopt-successor' || pending === 'verify-adoption') && retired;
    case 'complete':
      return pending === null && retired;
  }
}

function plannerInput(journal: ProfileResetJournal): Record<string, unknown> {
  return {
    directory: journal.directory,
    fence: { generation: journal.fence.generation, head: journal.fence.head },
    profiles: journal.profiles.map((p) => ({
      profile: p.profile,
      oldKey: p.oldKey,
      newKey: p.newKey,
      oldVersion: p.oldVersion,
      newVersion: p.newVersion,
      copiedHead: p.copiedHead,
      verified: p.verified,
      oldRetired: p.oldRetired,
    })),
    householdCommitted: journal.householdCommitted,
    oldHouseholdRetired: journal.oldHouseholdRetired,
  };
}

/** Rotate each verified candidate through den-core's stamped `library` operation, with the one durable stamp. */
function successorDirectory(journal: ProfileResetJournal): ProfileDirectoryDocument {
  let candidate = journal.directory;
  for (const evidence of journal.profiles) {
    if (!evidence.verified || evidence.copiedHead === null)
      throw new ProfileResetError('corrupt-journal');
    candidate = profilesRotateLibrary({
      document: candidate,
      profile: evidence.profile,
      keyVersion: evidence.newVersion,
      key: evidence.newKey,
      at: journal.resetStamp,
    });
  }
  let canonical: ProfileDirectoryDocument;
  try {
    canonical = validateStoredProfileDirectory(candidate);
  } catch {
    throw new ProfileResetError('invalid-directory');
  }
  const live = liveEntries(canonical);
  if (
    live.length !== journal.profiles.length ||
    !journal.profiles.every((evidence) => {
      const library = canonical.profiles[evidence.profile]?.library;
      return (
        library?.value.key === evidence.newKey &&
        library.value.keyVersion === evidence.newVersion &&
        compareStamps(library.at, journal.resetStamp) === 0
      );
    })
  )
    throw new ProfileResetError('invalid-directory');
  return canonical;
}

export function adoptionRequest(
  journal: ProfileResetJournal,
  locks: ProfileResetLockSet,
): ProfileAdoptionRequest {
  if (
    journal.successorHouseholdHead === null ||
    journal.successorDirectory === null ||
    !journal.householdCommitted ||
    !journal.oldHouseholdRetired ||
    !journal.profiles.every((p) => p.oldRetired)
  )
    throw new ProfileResetError('corrupt-journal');
  return {
    attempt: journal.attempt,
    householdKey: journal.newHouseholdKey,
    committedHead: journal.successorHouseholdHead,
    directory: journal.successorDirectory,
    locks,
  };
}

async function lockRequest(journal: ProfileResetJournal): Promise<ProfileResetLockRequest> {
  const profiles: Record<string, { libraryId: string; key: string }> = {};
  const successors: Record<string, string> = {};
  for (const evidence of journal.profiles) {
    profiles[evidence.profile] = {
      libraryId: await libraryId(evidence.oldKey),
      key: evidence.oldKey,
    };
    successors[evidence.profile] = await libraryId(evidence.newKey);
  }
  return {
    attempt: journal.attempt,
    fence: journal.fence,
    household: {
      libraryId: await libraryId(journal.oldHouseholdKey),
      key: journal.oldHouseholdKey,
    },
    profiles,
    successors: {
      household: await libraryId(journal.newHouseholdKey),
      profiles: successors,
    },
  };
}

function liveEntries(directory: ProfileDirectoryDocument) {
  return Object.values(directory.profiles)
    .filter((entry) => !entry.deleted.value)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function latestStamp(directory: ProfileDirectoryDocument): Stamp {
  let latest = ZERO_STAMP;
  for (const entry of Object.values(directory.profiles))
    for (const field of [entry.display, entry.library, entry.policy, entry.deleted]) {
      if (!stamp(field.at)) throw new ProfileResetError('invalid-directory');
      if (compareStamps(field.at, latest) > 0) latest = field.at;
    }
  return latest;
}

export function sameDirectory(
  left: ProfileDirectoryDocument,
  right: ProfileDirectoryDocument,
): boolean {
  try {
    return (
      profilesMaterialize(validateStoredProfileDirectory(left)).jcs ===
      profilesMaterialize(validateStoredProfileDirectory(right)).jcs
    );
  } catch {
    return false;
  }
}

function checkedFence(fence: ProfileResetFence): void {
  if (
    !record(fence) ||
    !Number.isSafeInteger(fence.generation) ||
    fence.generation < 0 ||
    typeof fence.head !== 'string' ||
    !DIGEST.test(fence.head)
  )
    throw new ProfileResetError('invalid-fence');
}

function stamp(value: unknown): value is Stamp {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isSafeInteger(value[0]) &&
    (value[0] as number) >= 0 &&
    Number.isSafeInteger(value[1]) &&
    (value[1] as number) >= 0 &&
    typeof value[2] === 'string' &&
    ACTOR.test(value[2])
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical padded base64 of exactly 32 bytes, the only key spelling the directory and den-core accept. */
function canonicalKey(value: unknown): value is string {
  if (typeof value !== 'string' || !KEY.test(value)) return false;
  return base64(Uint8Array.from(atob(value), (character) => character.charCodeAt(0))) === value;
}

/** The `/lib/{id}` of a canonical padded-base64 library key. */
export async function libraryId(key: string): Promise<string> {
  const raw = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
  try {
    return await deriveLibraryId(raw);
  } finally {
    raw.fill(0);
  }
}

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function randomAttempt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
