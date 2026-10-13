import { ensureSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';

const JOURNAL_PREFIX = 'den.profile.migration.v1:';
const ID = /^[0-9a-f]{32}$/;
const STATES = new Set<ProfileMigrationState>([
  'idle',
  'fenced',
  'backed-up',
  'owner-copied',
  'ready-to-commit',
  'commit-unknown',
  'adopting',
  'cleaning-loser',
  'active',
  'restore-required',
]);

export type ProfileMigrationState =
  | 'idle'
  | 'fenced'
  | 'backed-up'
  | 'owner-copied'
  | 'ready-to-commit'
  | 'commit-unknown'
  | 'adopting'
  | 'cleaning-loser'
  | 'active'
  | 'restore-required';

export interface ProfileMigrationFence {
  /** den-edge's numeric store generation observed when the rewrite was opened. */
  readonly generation: number;
  /** Authenticated digest of every source row through `base`. */
  readonly head: string;
  /** The existing household head which the rewrite must compare-and-set. */
  readonly base: number;
  /** Opaque rewrite handle. It may expire; the executor must resolve that idempotently. */
  readonly rewrite: string;
}

export type ProfileMigrationFenceProjection = Pick<ProfileMigrationFence, 'generation' | 'head'>;

export interface ProfileMigrationBackup {
  readonly id: string;
  readonly digest: string;
}

export interface OwnerMigrationCandidate {
  readonly profileId: string;
  readonly libraryId: string;
  readonly libraryKey: string;
}

export interface OwnerMigrationVerification {
  readonly head: string;
}

/**
 * An opaque, locally prepared household rewrite. Persisting this is safe; this slice deliberately has no operation
 * which can submit it or raise a household's wire minimum.
 */
export interface PreparedHouseholdRewrite {
  readonly digest: string;
}

export type ProfilesDirectory = Record<string, unknown> & {
  format: 4;
  kind: 'profiles';
  schema: 1;
  owner: string;
  migration: {
    version: 1;
    attempt: string;
    source: ProfileMigrationFenceProjection;
    backup: ProfileMigrationBackup;
    ownerProfile: string;
    ownerHead: string;
  };
  profiles: Record<
    string,
    {
      library: { value: { key: string } };
      deleted: { value: boolean };
    }
  >;
};

export type HouseholdMigrationObservation =
  | { readonly kind: 'legacy'; readonly observedFence: ProfileMigrationFenceProjection }
  | { readonly kind: 'committed'; readonly directory: ProfilesDirectory }
  | { readonly kind: 'corrupt' };

/**
 * Effects remain behind this port so the ordering can be tested without live data. Every operation is keyed by the
 * durable attempt and must be idempotent: a process can die after the effect and before its journal update.
 */
export interface ProfileMigrationExecutor {
  observe(journal: ProfileMigrationJournal): Promise<HouseholdMigrationObservation>;
  acquireFence(attempt: string): Promise<ProfileMigrationFence>;
  createAndVerifyBackup(
    attempt: string,
    fence: ProfileMigrationFence,
  ): Promise<ProfileMigrationBackup>;
  createOwnerCandidate(attempt: string): Promise<OwnerMigrationCandidate>;
  copyOwnerPartition(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: ProfileMigrationBackup,
    candidate: OwnerMigrationCandidate,
  ): Promise<void>;
  verifyOwnerLibrary(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: ProfileMigrationBackup,
    candidate: OwnerMigrationCandidate,
  ): Promise<OwnerMigrationVerification>;
  prepareHouseholdRewrite(
    journal: Required<
      Pick<
        ProfileMigrationJournal,
        'attempt' | 'fence' | 'backup' | 'candidate' | 'ownerVerification'
      >
    >,
  ): Promise<PreparedHouseholdRewrite>;
  verifyWinner(directory: ProfilesDirectory, ownerLibraryKey: string): Promise<boolean>;
  adoptWinner(directory: ProfilesDirectory, ownerLibraryKey: string): Promise<void>;
  /** Retire just this candidate. The proof has already excluded the household and every live directory key. */
  retireLosingCandidate(
    attempt: string,
    source: ProfileMigrationFence,
    candidate: OwnerMigrationCandidate,
  ): Promise<'retired' | 'absent'>;
}

export interface ProfileMigrationJournal {
  readonly version: 2;
  readonly attempt: string;
  /** Persisted only by the explicit Owner action which created this attempt. */
  readonly explicitIntent: true;
  readonly state: ProfileMigrationState;
  readonly fence?: ProfileMigrationFence;
  readonly backup?: ProfileMigrationBackup;
  readonly candidate?: OwnerMigrationCandidate;
  readonly ownerVerification?: OwnerMigrationVerification;
  readonly prepared?: PreparedHouseholdRewrite;
  readonly winnerLibraryKey?: string;
  readonly winnerAttempt?: string;
  readonly winnerHead?: string;
  readonly winnerVerified?: boolean;
  readonly candidateRetired?: boolean;
}

export type ProfileMigrationStatus =
  | { readonly kind: 'inactive' }
  | { readonly kind: 'progress'; readonly state: ProfileMigrationState }
  | { readonly kind: 'ready-to-commit'; readonly prepared: PreparedHouseholdRewrite }
  | { readonly kind: 'restore-required' }
  | {
      readonly kind: 'blocked';
      readonly reason: 'invalid-journal' | 'cleanup-targets-live-library';
    }
  | { readonly kind: 'active'; readonly ownerLibraryKey: string };

export type ProfileMigrationDecision =
  | 'acquire-fence'
  | 'create-backup'
  | 'create-owner-library'
  | 'verify-owner-library'
  | 'commit-fenced-household'
  | 'read-household'
  | 'retire-losing-candidate'
  | 'verify-winner'
  | 'activate'
  | 'restore-backup'
  | 'recovery-blocked'
  | 'restart'
  | 'cleanup_targets_winner';

type MigrationPlanner = (input: Record<string, unknown>) => ProfileMigrationDecision;
type DirectoryValidator = (directory: ProfilesDirectory) => ProfilesDirectory;

const randomAttempt = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

function ownerLibrary(directory: ProfilesDirectory): string {
  const owner = directory.profiles[directory.owner];
  if (!owner || owner.deleted.value)
    throw new Error('Committed profiles directory has no live Owner');
  return owner.library.value.key;
}

function liveLibraryKeys(directory: ProfilesDirectory): Set<string> {
  return new Set(
    Object.values(directory.profiles)
      .filter((profile) => !profile.deleted.value)
      .map((profile) => profile.library.value.key),
  );
}

const fenceProjection = (fence: ProfileMigrationFence): ProfileMigrationFenceProjection => ({
  generation: fence.generation,
  head: fence.head,
});

const sameFence = (
  left: ProfileMigrationFenceProjection,
  right: ProfileMigrationFenceProjection,
): boolean => left.generation === right.generation && left.head === right.head;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

function canonicalLibraryKey(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.length === 32 && btoa(String.fromCharCode(...bytes)) === value;
  } catch {
    return false;
  }
}

function validJournal(value: unknown): value is ProfileMigrationJournal {
  if (
    !record(value) ||
    value.version !== 2 ||
    typeof value.attempt !== 'string' ||
    !ID.test(value.attempt) ||
    value.explicitIntent !== true ||
    typeof value.state !== 'string' ||
    !STATES.has(value.state as ProfileMigrationState)
  )
    return false;
  if (
    value.fence !== undefined &&
    (!record(value.fence) ||
      !Number.isSafeInteger(value.fence.generation) ||
      (value.fence.generation as number) < 0 ||
      typeof value.fence.head !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.fence.head) ||
      !Number.isSafeInteger(value.fence.base) ||
      (value.fence.base as number) < 0 ||
      typeof value.fence.rewrite !== 'string')
  )
    return false;
  if (
    value.backup !== undefined &&
    (!record(value.backup) ||
      typeof value.backup.id !== 'string' ||
      value.backup.id.length === 0 ||
      typeof value.backup.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.backup.digest))
  )
    return false;
  if (
    value.candidate !== undefined &&
    (!record(value.candidate) ||
      typeof value.candidate.profileId !== 'string' ||
      !ID.test(value.candidate.profileId) ||
      typeof value.candidate.libraryId !== 'string' ||
      !ID.test(value.candidate.libraryId) ||
      typeof value.candidate.libraryKey !== 'string' ||
      !canonicalLibraryKey(value.candidate.libraryKey))
  )
    return false;
  if (
    value.ownerVerification !== undefined &&
    (!record(value.ownerVerification) ||
      typeof value.ownerVerification.head !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.ownerVerification.head))
  )
    return false;
  if (
    value.prepared !== undefined &&
    (!record(value.prepared) ||
      typeof value.prepared.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.prepared.digest))
  )
    return false;
  if (
    !optionalString(value.winnerLibraryKey) ||
    !optionalString(value.winnerAttempt) ||
    !optionalString(value.winnerHead) ||
    (typeof value.winnerAttempt === 'string' && !ID.test(value.winnerAttempt)) ||
    (typeof value.winnerHead === 'string' && !/^[0-9a-f]{64}$/.test(value.winnerHead)) ||
    (typeof value.winnerLibraryKey === 'string' && !canonicalLibraryKey(value.winnerLibraryKey)) ||
    (value.winnerVerified !== undefined && typeof value.winnerVerified !== 'boolean') ||
    (value.candidateRetired !== undefined && typeof value.candidateRetired !== 'boolean') ||
    (value.winnerVerified === true &&
      (value.winnerLibraryKey === undefined ||
        value.winnerAttempt === undefined ||
        value.winnerHead === undefined)) ||
    (value.candidateRetired === true && value.candidate === undefined)
  )
    return false;

  const has = (key: string): boolean => value[key] !== undefined;
  const none = (...keys: string[]): boolean => keys.every((key) => !has(key));
  const initialEvidence = ['fence', 'backup', 'candidate', 'ownerVerification', 'prepared'];
  const winnerEvidence = [
    'winnerLibraryKey',
    'winnerAttempt',
    'winnerHead',
    'winnerVerified',
    'candidateRetired',
  ];
  switch (value.state) {
    case 'idle':
      return none(...initialEvidence, ...winnerEvidence);
    case 'fenced':
      return has('fence') && none(...initialEvidence.slice(1), ...winnerEvidence);
    case 'backed-up':
      // The candidate is durably named before its first copy, while the state remains backed-up. That crash
      // boundary is intentional: a retry must copy into, and eventually retire, the same library.
      return (
        has('fence') && has('backup') && none('ownerVerification', 'prepared', ...winnerEvidence)
      );
    case 'owner-copied':
      return (
        has('fence') &&
        has('backup') &&
        has('candidate') &&
        none('ownerVerification', 'prepared', ...winnerEvidence)
      );
    case 'ready-to-commit':
      return (
        has('fence') &&
        has('backup') &&
        has('candidate') &&
        has('ownerVerification') &&
        none('prepared', ...winnerEvidence)
      );
    case 'commit-unknown':
      return initialEvidence.every(has) && none(...winnerEvidence);
    case 'cleaning-loser':
      // A competing committed directory names its winner, while a changed legacy fence has no winner yet. Both
      // paths still have one safe cleanup target: this attempt's persisted candidate.
      return has('candidate') && value.candidateRetired !== true;
    case 'adopting':
      return has('winnerLibraryKey');
    case 'active':
      return has('winnerLibraryKey') && value.winnerVerified === true;
    case 'restore-required':
      return true;
  }
  return false;
}

/**
 * Durable, non-activating participation in profiles-v1's initial split. Construction and `resume()` are inert when
 * there is no journal. Only `beginExplicitOwnerAction` can create one, and this class stops after preparing the
 * fenced household rewrite: it cannot publish a directory, commit wire 5, or alter the household key/id.
 */
export class ProfileMigrationParticipant {
  readonly #key: string;
  readonly #householdLibraryKey: string;
  readonly #storage: Storage;
  readonly #executor: ProfileMigrationExecutor;
  readonly #planner: MigrationPlanner;
  readonly #validateDirectory: DirectoryValidator;
  readonly #ensurePolicy: () => Promise<void>;
  readonly #attempt: () => string;
  #invalidJournal = false;

  constructor(options: {
    householdId: string;
    householdLibraryKey: string;
    storage: Storage;
    executor: ProfileMigrationExecutor;
    planner?: MigrationPlanner;
    validateDirectory?: DirectoryValidator;
    randomAttempt?: () => string;
  }) {
    this.#key = `${JOURNAL_PREFIX}${options.householdId}`;
    this.#householdLibraryKey = options.householdLibraryKey;
    this.#storage = options.storage;
    this.#executor = options.executor;
    this.#planner =
      options.planner ??
      ((input) => syncPolicy<ProfileMigrationDecision>({ op: 'profiles_migration_next', input }));
    this.#validateDirectory =
      options.validateDirectory ??
      ((directory) =>
        syncPolicy<ProfilesDirectory>({ op: 'profiles_validate', document: directory }));
    this.#ensurePolicy = options.planner ? async () => {} : ensureSyncPolicy;
    this.#attempt = options.randomAttempt ?? randomAttempt;
    this.#read();
  }

  get journal(): ProfileMigrationJournal | null {
    return this.#read();
  }

  /** The caller must have just handled the explicit Owner action and owner-PIN gate. */
  beginExplicitOwnerAction(ownerPinVerified: true): ProfileMigrationJournal {
    if (ownerPinVerified !== true) throw new TypeError('Owner authorization is required');
    if (this.#invalidJournal) throw new Error('The migration journal requires recovery');
    const existing = this.#read();
    if (existing) return existing;
    const attempt = this.#attempt();
    if (!ID.test(attempt)) throw new TypeError('A migration attempt must be 128-bit lowercase hex');
    return this.#write({ version: 2, attempt, explicitIntent: true, state: 'idle' });
  }

  /** Continue at most one externally visible effect, so every crash boundary is durable and retryable. */
  async resume(): Promise<ProfileMigrationStatus> {
    const journal = this.#read();
    if (this.#invalidJournal) return { kind: 'blocked', reason: 'invalid-journal' };
    if (!journal) return { kind: 'inactive' };
    if (journal.state === 'active' && journal.winnerLibraryKey) {
      // Activation is durable before cleanup. If removeItem failed or the process died between those effects, a
      // relaunch must finish deleting the journal before it reports the already-adopted winner as active.
      this.#storage.removeItem(this.#key);
      return { kind: 'active', ownerLibraryKey: journal.winnerLibraryKey };
    }
    if (journal.state === 'restore-required') return { kind: 'restore-required' };

    await this.#ensurePolicy();
    const observation = await this.#executor.observe(journal);
    const committed =
      observation.kind === 'committed' ? this.#validated(observation.directory) : null;
    const winnerLibraryKey = committed ? ownerLibrary(committed) : undefined;
    const winnerAttempt = committed?.migration.attempt;
    const winnerHead = committed?.migration.ownerHead;
    const winnerVerified =
      journal.winnerVerified === true &&
      journal.winnerLibraryKey === winnerLibraryKey &&
      journal.winnerAttempt === winnerAttempt &&
      journal.winnerHead === winnerHead;
    const decision = this.#planner({
      state: journal.state,
      observed: observation.kind,
      ...(journal.state === 'idle' ? { explicitIntent: journal.explicitIntent } : {}),
      ...(journal.fence && observation.kind === 'legacy' && journal.state !== 'idle'
        ? {
            fence: fenceProjection(journal.fence),
            observedFence: observation.observedFence,
          }
        : {}),
      ...(committed ? { directory: committed } : {}),
      ...(journal.backup ? { backupVerified: true } : {}),
      ...(journal.candidate
        ? {
            candidateAttempt: journal.attempt,
            candidateKey: journal.candidate.libraryKey,
          }
        : {}),
      ...(journal.ownerVerification
        ? { ownerVerified: true, candidateHead: journal.ownerVerification.head }
        : {}),
      ...(winnerVerified ? { winnerVerified: true } : {}),
      ...(journal.candidateRetired ? { candidateRetired: true } : {}),
    });

    switch (decision) {
      case 'acquire-fence': {
        const fence = await this.#executor.acquireFence(journal.attempt);
        this.#write({ ...journal, state: 'fenced', fence });
        return { kind: 'progress', state: 'fenced' };
      }
      case 'create-backup': {
        if (!journal.fence) throw new Error('Migration fence is missing');
        const backup = await this.#executor.createAndVerifyBackup(journal.attempt, journal.fence);
        this.#write({ ...journal, state: 'backed-up', backup });
        return { kind: 'progress', state: 'backed-up' };
      }
      case 'create-owner-library': {
        if (!journal.fence || !journal.backup) throw new Error('Verified backup is missing');
        const candidate =
          journal.candidate ?? (await this.#executor.createOwnerCandidate(journal.attempt));
        if (candidate.libraryKey === this.#householdLibraryKey)
          throw new Error('Owner candidate cannot reuse the household key');
        // Persist the cleanup target before its first write. A retry reuses the same candidate and copy operation.
        if (!journal.candidate) this.#write({ ...journal, candidate });
        await this.#executor.copyOwnerPartition(
          journal.attempt,
          journal.fence,
          journal.backup,
          candidate,
        );
        this.#write({ ...journal, state: 'owner-copied', candidate });
        return { kind: 'progress', state: 'owner-copied' };
      }
      case 'verify-owner-library': {
        if (!journal.fence || !journal.backup || !journal.candidate)
          throw new Error('Owner candidate evidence is missing');
        const ownerVerification = await this.#executor.verifyOwnerLibrary(
          journal.attempt,
          journal.fence,
          journal.backup,
          journal.candidate,
        );
        this.#write({ ...journal, state: 'ready-to-commit', ownerVerification });
        return { kind: 'progress', state: 'ready-to-commit' };
      }
      case 'commit-fenced-household': {
        if (!journal.fence || !journal.backup || !journal.candidate || !journal.ownerVerification)
          throw new Error('Migration evidence is incomplete');
        const prepared = await this.#executor.prepareHouseholdRewrite({
          attempt: journal.attempt,
          fence: journal.fence,
          backup: journal.backup,
          candidate: journal.candidate,
          ownerVerification: journal.ownerVerification,
        });
        // The next externally visible effect will be the future executor's compare-and-set. Record uncertainty
        // before exposing the rewrite so process death or a timed-out commit can only resume through observation.
        this.#write({ ...journal, state: 'commit-unknown', prepared });
        return { kind: 'ready-to-commit', prepared };
      }
      case 'read-household':
        // Observation above executed den-core's mandatory read-household effect. Only the same authenticated
        // legacy fence may expose this attempt's already-prepared rewrite for an idempotent commit retry.
        if (
          journal.prepared &&
          journal.fence &&
          observation.kind === 'legacy' &&
          sameFence(journal.fence, observation.observedFence)
        )
          return { kind: 'ready-to-commit', prepared: journal.prepared };
        this.#write({ ...journal, state: 'commit-unknown' });
        return { kind: 'progress', state: 'commit-unknown' };
      case 'retire-losing-candidate': {
        if (!journal.fence || !journal.candidate)
          throw new Error('Losing Owner candidate evidence is missing');
        if (
          journal.candidate.libraryKey === this.#householdLibraryKey ||
          (committed && liveLibraryKeys(committed).has(journal.candidate.libraryKey))
        )
          return { kind: 'blocked', reason: 'cleanup-targets-live-library' };
        this.#write({
          ...journal,
          state: 'cleaning-loser',
          winnerVerified,
          ...(winnerLibraryKey && winnerAttempt && winnerHead
            ? { winnerLibraryKey, winnerAttempt, winnerHead }
            : {}),
        });
        await this.#executor.retireLosingCandidate(
          journal.attempt,
          journal.fence,
          journal.candidate,
        );
        if (!committed) {
          // A changed legacy source invalidates the whole attempt. Cleanup is complete, so wait for a new explicit
          // Owner action instead of carrying stale authorization or silently starting another fence.
          this.#storage.removeItem(this.#key);
          return { kind: 'inactive' };
        }
        this.#write({
          ...journal,
          state: 'adopting',
          candidateRetired: true,
          winnerVerified,
          ...(winnerLibraryKey && winnerAttempt && winnerHead
            ? { winnerLibraryKey, winnerAttempt, winnerHead }
            : {}),
        });
        return { kind: 'progress', state: 'adopting' };
      }
      case 'verify-winner': {
        if (!committed || !winnerLibraryKey) throw new Error('Committed winner is missing');
        if (!(await this.#executor.verifyWinner(committed, winnerLibraryKey)))
          return { kind: 'progress', state: 'adopting' };
        this.#write({
          ...journal,
          state: 'adopting',
          winnerLibraryKey,
          winnerAttempt,
          winnerHead,
          winnerVerified: true,
        });
        return { kind: 'progress', state: 'adopting' };
      }
      case 'activate': {
        if (!committed || !winnerLibraryKey || !winnerVerified)
          throw new Error('Verified committed winner is missing');
        const adopting = this.#write({
          ...journal,
          state: 'adopting',
          winnerLibraryKey,
          winnerAttempt,
          winnerHead,
          winnerVerified: true,
        });
        await this.#executor.adoptWinner(committed, winnerLibraryKey);
        this.#write({ ...adopting, state: 'active' });
        this.#storage.removeItem(this.#key);
        return { kind: 'active', ownerLibraryKey: winnerLibraryKey };
      }
      case 'restore-backup':
      case 'recovery-blocked':
        this.#write({ ...journal, state: 'restore-required' });
        return { kind: 'restore-required' };
      case 'restart':
        // A changed legacy fence ends this attempt. A new one still requires another explicit Owner action.
        this.#storage.removeItem(this.#key);
        return { kind: 'inactive' };
      case 'cleanup_targets_winner':
        return { kind: 'blocked', reason: 'cleanup-targets-live-library' };
      default:
        throw new Error(
          `Profile migration planner returned an unsupported effect: ${decision as string}`,
        );
    }
  }

  #validated(directory: ProfilesDirectory): ProfilesDirectory {
    return this.#validateDirectory(directory);
  }

  #read(): ProfileMigrationJournal | null {
    const encoded = this.#storage.getItem(this.#key);
    if (encoded === null) return null;
    try {
      const value: unknown = JSON.parse(encoded);
      if (!validJournal(value)) throw new Error('invalid journal');
      return value;
    } catch {
      this.#invalidJournal = true;
      return null;
    }
  }

  #write(journal: ProfileMigrationJournal): ProfileMigrationJournal {
    this.#storage.setItem(this.#key, JSON.stringify(journal));
    return journal;
  }
}
