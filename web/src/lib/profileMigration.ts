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
  /** den-edge store generation observed when the rewrite was opened. */
  readonly generation: string;
  /** The existing household head which the rewrite must compare-and-set. */
  readonly base: number;
  /** Opaque rewrite handle. It may expire; the executor must resolve that idempotently. */
  readonly rewrite: string;
}

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
  owner: string;
  profiles: Record<
    string,
    {
      library: { value: { key: string } };
      deleted: { value: boolean };
    }
  >;
};

export type HouseholdMigrationObservation =
  | { readonly kind: 'legacy'; readonly fence: 'same' | 'changed' }
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
  retireLosingCandidate(candidate: OwnerMigrationCandidate): Promise<'retired' | 'absent'>;
}

export interface ProfileMigrationJournal {
  readonly version: 1;
  readonly attempt: string;
  readonly state: ProfileMigrationState;
  readonly fence?: ProfileMigrationFence;
  readonly backup?: ProfileMigrationBackup;
  readonly candidate?: OwnerMigrationCandidate;
  readonly ownerVerification?: OwnerMigrationVerification;
  readonly prepared?: PreparedHouseholdRewrite;
  readonly winnerLibraryKey?: string;
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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

function validJournal(value: unknown): value is ProfileMigrationJournal {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.attempt !== 'string' ||
    !ID.test(value.attempt) ||
    typeof value.state !== 'string' ||
    !STATES.has(value.state as ProfileMigrationState)
  )
    return false;
  if (
    value.fence !== undefined &&
    (!record(value.fence) ||
      typeof value.fence.generation !== 'string' ||
      !Number.isSafeInteger(value.fence.base) ||
      (value.fence.base as number) < 0 ||
      typeof value.fence.rewrite !== 'string')
  )
    return false;
  if (
    value.backup !== undefined &&
    (!record(value.backup) ||
      typeof value.backup.id !== 'string' ||
      typeof value.backup.digest !== 'string')
  )
    return false;
  if (
    value.candidate !== undefined &&
    (!record(value.candidate) ||
      typeof value.candidate.profileId !== 'string' ||
      !ID.test(value.candidate.profileId) ||
      typeof value.candidate.libraryId !== 'string' ||
      typeof value.candidate.libraryKey !== 'string' ||
      value.candidate.libraryKey.length === 0)
  )
    return false;
  if (
    value.ownerVerification !== undefined &&
    (!record(value.ownerVerification) || typeof value.ownerVerification.head !== 'string')
  )
    return false;
  if (
    value.prepared !== undefined &&
    (!record(value.prepared) || typeof value.prepared.digest !== 'string')
  )
    return false;
  return (
    optionalString(value.winnerLibraryKey) &&
    (value.winnerVerified === undefined || typeof value.winnerVerified === 'boolean') &&
    (value.candidateRetired === undefined || typeof value.candidateRetired === 'boolean')
  );
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
    return this.#write({ version: 1, attempt, state: 'idle' });
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
    // A prepared rewrite may have been handed to an executor immediately before another participant committed.
    // Always resolve a canonical directory first; only offer this attempt's rewrite while its original fence is
    // still the observed household state.
    if (journal.prepared && observation.kind === 'legacy' && observation.fence === 'same')
      return { kind: 'ready-to-commit', prepared: journal.prepared };
    const decision = this.#planner({
      state: journal.state,
      observed: observation.kind,
      ...(journal.fence && observation.kind === 'legacy' ? { fence: observation.fence } : {}),
      ...(journal.backup ? { backupVerified: true } : {}),
      ...(journal.candidate ? { candidateLibrary: journal.candidate.libraryKey } : {}),
      ...(journal.ownerVerification ? { ownerVerified: true } : {}),
      ...(winnerLibraryKey ? { winnerLibrary: winnerLibraryKey } : {}),
      ...(journal.winnerVerified ? { winnerVerified: true } : {}),
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
        if (!journal.fence || !journal.candidate) throw new Error('Owner candidate is missing');
        const ownerVerification = await this.#executor.verifyOwnerLibrary(
          journal.attempt,
          journal.fence,
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
        this.#write({ ...journal, state: 'commit-unknown' });
        return { kind: 'progress', state: 'commit-unknown' };
      case 'retire-losing-candidate': {
        if (!journal.candidate) throw new Error('Losing Owner candidate is missing');
        if (
          journal.candidate.libraryKey === this.#householdLibraryKey ||
          (committed && liveLibraryKeys(committed).has(journal.candidate.libraryKey))
        )
          return { kind: 'blocked', reason: 'cleanup-targets-live-library' };
        this.#write({
          ...journal,
          state: 'cleaning-loser',
          ...(winnerLibraryKey ? { winnerLibraryKey } : {}),
        });
        await this.#executor.retireLosingCandidate(journal.candidate);
        this.#write({
          ...journal,
          state: committed ? 'adopting' : 'idle',
          candidateRetired: true,
          ...(winnerLibraryKey ? { winnerLibraryKey } : {}),
        });
        return { kind: 'progress', state: committed ? 'adopting' : 'idle' };
      }
      case 'verify-winner': {
        if (!committed || !winnerLibraryKey) throw new Error('Committed winner is missing');
        if (!(await this.#executor.verifyWinner(committed, winnerLibraryKey)))
          return { kind: 'progress', state: 'adopting' };
        this.#write({
          ...journal,
          state: 'adopting',
          winnerLibraryKey,
          winnerVerified: true,
        });
        return { kind: 'progress', state: 'adopting' };
      }
      case 'activate': {
        if (!committed || !winnerLibraryKey || !journal.winnerVerified)
          throw new Error('Verified committed winner is missing');
        const adopting = this.#write({
          ...journal,
          state: 'adopting',
          winnerLibraryKey,
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
