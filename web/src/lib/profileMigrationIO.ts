import type {
  HouseholdMigrationObservation,
  OwnerMigrationCandidate,
  OwnerMigrationVerification,
  PreparedHouseholdRewrite,
  ProfileMigrationBackup,
  ProfileMigrationExecutor,
  ProfileMigrationFence,
  ProfileMigrationJournal,
  ProfilesDirectory,
} from './profileMigration';
import { validateStoredProfileDirectory } from './profileDirectory';

const DIGEST = /^[0-9a-f]{64}$/;
const LIBRARY_ID = /^[0-9a-f]{32}$/;

/** The exact profiles-v1 Owner payload. Preferences are partitioned by den-core, never by this list. */
export const OWNER_SPLIT_COPY_DOMAINS = Object.freeze([
  'title-and-season-documents',
  'personal-preferences',
  'tracker-credentials',
  'tracker-commands',
  'tracker-receipts',
  'tracker-pending-work',
  'tracker-held-work',
  'tracker-epochs',
  'tracker-delivery-settings',
  'tracker-delivery-documents',
] as const);

export type OwnerSplitCopyDomain = (typeof OWNER_SPLIT_COPY_DOMAINS)[number];

/** Exact output of den-core's `profiles_partition_preferences`; no local key list is accepted. */
export interface OwnerPreferencePartition {
  readonly household: Record<string, unknown>;
  readonly owner: Record<string, unknown>;
  readonly ownerMaturity: unknown;
}

export type OwnerPreferencePartitioner = (values: unknown) => OwnerPreferencePartition;
export type ProfilesDirectoryValidator = (document: unknown) => ProfilesDirectory;

export interface OwnerSplitAttemptContext {
  readonly attempt: string;
  readonly household: { readonly libraryId: string; readonly libraryKey: string };
}

export interface VerifiedOwnerSplitBackup extends ProfileMigrationBackup {
  readonly context: OwnerSplitAttemptContext;
  readonly digest: string;
  readonly readable: true;
  readonly source: ProfileMigrationFence;
  /** Complete legacy `set:prefs.values` read through `source.base`. */
  readonly preferenceValues: unknown;
}

export interface OwnerCopyPlan {
  readonly domains: readonly OwnerSplitCopyDomain[];
  readonly preferences: OwnerPreferencePartition;
}

export interface AuthenticatedOwnerCopy extends OwnerMigrationVerification {
  readonly authenticated: true;
  readonly context: OwnerSplitAttemptContext;
  readonly source: ProfileMigrationFence;
  readonly backup: ProfileMigrationBackup;
  readonly candidate: OwnerMigrationCandidate;
  readonly plan: OwnerCopyPlan;
  /** Source rows and every derived activity/delivery result were accounted for. */
  readonly partitionComplete: true;
}

export interface OwnerSplitPreparedRewrite extends PreparedHouseholdRewrite {
  readonly digest: string;
  readonly householdId: string;
  readonly householdLibraryKey: string;
  readonly source: ProfileMigrationFence;
  readonly ownerHead: string;
  readonly projection: 'configuration-and-directory-only';
  readonly wireMinimum: 5;
}

export interface ConditionalRetirementEvidence {
  readonly context: OwnerSplitAttemptContext;
  readonly source: ProfileMigrationFence;
  readonly result: 'retired' | 'absent' | 'blocked';
  readonly reason?: 'same-legacy-fence' | 'corrupt-household' | 'protected-library';
  readonly candidate: Pick<OwnerMigrationCandidate, 'libraryId' | 'libraryKey'>;
  /** Authenticated household state to which retirement was atomically conditioned. */
  readonly authority: {
    readonly generation: number;
    readonly head: string;
    readonly kind: 'committed' | 'changed-legacy';
  };
  readonly directoryValidated: boolean;
  /** Household plus every live committed profile identity at `authority.head`. */
  readonly protectedLibraryIds: readonly string[];
  readonly protectedLibraryKeys: readonly string[];
}

/**
 * Storage operations LibraryLog does not yet expose safely. A future implementation must produce these proofs;
 * it must not emulate them using separately timed reads and writes.
 */
export interface OwnerSplitStorage {
  observe(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly journal: ProfileMigrationJournal;
  }): Promise<HouseholdMigrationObservation>;
  acquireFence(context: OwnerSplitAttemptContext): Promise<ProfileMigrationFence>;
  createBackup(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly fence: ProfileMigrationFence;
  }): Promise<ProfileMigrationBackup>;
  /** Re-opens durable backup evidence; this must work after the creating process exits. */
  verifyBackup(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly fence: ProfileMigrationFence;
    readonly backup: ProfileMigrationBackup;
  }): Promise<VerifiedOwnerSplitBackup>;
  allocateOwner(context: OwnerSplitAttemptContext): Promise<OwnerMigrationCandidate>;
  copyOwner(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly fence: ProfileMigrationFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerMigrationCandidate;
    readonly plan: OwnerCopyPlan;
  }): Promise<void>;
  authenticateOwner(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly fence: ProfileMigrationFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerMigrationCandidate;
    readonly plan: OwnerCopyPlan;
  }): Promise<AuthenticatedOwnerCopy>;
  prepareHousehold(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly fence: ProfileMigrationFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerMigrationCandidate;
    readonly owner: AuthenticatedOwnerCopy;
  }): Promise<OwnerSplitPreparedRewrite>;
  verifyWinner(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly directory: ProfilesDirectory;
    readonly ownerLibraryKey: string;
  }): Promise<boolean>;
  /**
   * One atomic effect: freshly authenticate the household, den-core-validate any directory, exclude the household
   * and every live profile by id and key, then retire only if the generation/head condition still matches.
   */
  conditionallyRetireUnreferenced(input: {
    readonly context: OwnerSplitAttemptContext;
    readonly source: ProfileMigrationFence;
    readonly candidate: OwnerMigrationCandidate;
    readonly validateDirectory: ProfilesDirectoryValidator;
  }): Promise<ConditionalRetirementEvidence>;
}

export class OwnerSplitDisabledError extends Error {
  constructor() {
    super('Owner split storage is disabled');
    this.name = 'OwnerSplitDisabledError';
  }
}

/**
 * Default-off validation around the future worker implementation. It has no app/UI caller and cannot activate a
 * winner or commit wire 5. Those effects remain unavailable until LibraryLog has OwnerSplitStorage's primitives.
 */
export class DormantOwnerSplitExecutor implements ProfileMigrationExecutor {
  readonly #enabled: boolean;
  readonly #householdId: string;
  readonly #householdLibraryKey: string;
  readonly #storage: OwnerSplitStorage;
  readonly #partitionPreferences: OwnerPreferencePartitioner;

  constructor(
    storage: OwnerSplitStorage,
    options: {
      householdId: string;
      householdLibraryKey: string;
      partitionPreferences: OwnerPreferencePartitioner;
      enabled?: boolean;
    },
  ) {
    if (!LIBRARY_ID.test(options.householdId) || !canonicalLibraryKey(options.householdLibraryKey))
      throw new TypeError('Household identity is not canonical');
    this.#storage = storage;
    this.#householdId = options.householdId;
    this.#householdLibraryKey = options.householdLibraryKey;
    this.#partitionPreferences = options.partitionPreferences;
    this.#enabled = options.enabled ?? false;
  }

  dryRun(): {
    readonly enabled: boolean;
    readonly copyDomains: readonly OwnerSplitCopyDomain[];
    readonly canCommit: false;
    readonly canActivate: false;
  } {
    return {
      enabled: this.#enabled,
      copyDomains: OWNER_SPLIT_COPY_DOMAINS,
      canCommit: false,
      canActivate: false,
    };
  }

  async observe(journal: ProfileMigrationJournal): Promise<HouseholdMigrationObservation> {
    this.#requireEnabled();
    const context = this.#context(journal.attempt);
    if (journal.fence) validFence(journal.fence);
    if (journal.backup) validBackup(journal.backup);
    const candidate = journal.candidate ? this.#candidate(journal.candidate) : undefined;
    if (journal.ownerVerification && !DIGEST.test(journal.ownerVerification.head))
      throw new Error('Owner verification head is invalid');
    return await this.#storage.observe({
      context,
      journal: candidate ? { ...journal, candidate } : journal,
    });
  }

  async acquireFence(attempt: string): Promise<ProfileMigrationFence> {
    this.#requireEnabled();
    const context = this.#context(attempt);
    const fence = await this.#storage.acquireFence(context);
    validFence(fence);
    return fence;
  }

  async createAndVerifyBackup(
    attempt: string,
    fence: ProfileMigrationFence,
  ): Promise<ProfileMigrationBackup> {
    this.#requireEnabled();
    const context = this.#context(attempt);
    validFence(fence);
    const backup = await this.#storage.createBackup({ context, fence });
    validBackup(backup);
    const verified = await this.#verifiedBackup(attempt, fence, backup);
    return { id: verified.id, digest: verified.digest };
  }

  async createOwnerCandidate(attempt: string): Promise<OwnerMigrationCandidate> {
    this.#requireEnabled();
    const context = this.#context(attempt);
    return this.#candidate(await this.#storage.allocateOwner(context));
  }

  async copyOwnerPartition(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: ProfileMigrationBackup,
    candidate: OwnerMigrationCandidate,
  ): Promise<void> {
    this.#requireEnabled();
    const context = this.#context(attempt);
    validFence(fence);
    const checkedCandidate = this.#candidate(candidate);
    const verified = await this.#verifiedBackup(attempt, fence, backup);
    await this.#storage.copyOwner({
      context,
      fence,
      backup: verified,
      candidate: checkedCandidate,
      plan: this.#plan(verified.preferenceValues),
    });
  }

  async verifyOwnerLibrary(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: ProfileMigrationBackup,
    candidate: OwnerMigrationCandidate,
  ): Promise<OwnerMigrationVerification> {
    this.#requireEnabled();
    this.#context(attempt);
    validFence(fence);
    const checkedCandidate = this.#candidate(candidate);
    const verified = await this.#verifiedBackup(attempt, fence, backup);
    const evidence = await this.#authenticate(attempt, fence, verified, checkedCandidate);
    return { head: evidence.head };
  }

  async prepareHouseholdRewrite(
    journal: Required<
      Pick<
        ProfileMigrationJournal,
        'attempt' | 'fence' | 'backup' | 'candidate' | 'ownerVerification'
      >
    >,
  ): Promise<PreparedHouseholdRewrite> {
    this.#requireEnabled();
    const context = this.#context(journal.attempt);
    validFence(journal.fence);
    const candidate = this.#candidate(journal.candidate);
    const backup = await this.#verifiedBackup(journal.attempt, journal.fence, journal.backup);
    const owner = await this.#authenticate(journal.attempt, journal.fence, backup, candidate);
    if (owner.head !== journal.ownerVerification.head)
      throw new Error('Authenticated Owner copy evidence is missing');
    const prepared = await this.#storage.prepareHousehold({
      context,
      fence: journal.fence,
      candidate,
      backup,
      owner,
    });
    if (
      !DIGEST.test(prepared.digest) ||
      prepared.householdId !== this.#householdId ||
      prepared.householdLibraryKey !== this.#householdLibraryKey ||
      !sameFence(prepared.source, journal.fence) ||
      prepared.ownerHead !== owner.head ||
      prepared.projection !== 'configuration-and-directory-only' ||
      prepared.wireMinimum !== 5
    )
      throw new Error('Household rewrite is not bound to the original identity and evidence');
    return { digest: prepared.digest };
  }

  async verifyWinner(directory: ProfilesDirectory, ownerLibraryKey: string): Promise<boolean> {
    this.#requireEnabled();
    if (!canonicalLibraryKey(ownerLibraryKey)) throw new Error('Winner library key is invalid');
    const validated = validateStoredProfileDirectory(directory) as ProfilesDirectory;
    const migration = record(validated.migration) ? validated.migration : null;
    const attempt = migration?.attempt;
    if (typeof attempt !== 'string') throw new Error('Winner migration attempt is invalid');
    return await this.#storage.verifyWinner({
      context: this.#context(attempt),
      directory: validated,
      ownerLibraryKey,
    });
  }

  adoptWinner(_directory: ProfilesDirectory, _ownerLibraryKey: string): Promise<void> {
    return Promise.reject(new Error('Owner split activation is unavailable'));
  }

  async retireLosingCandidate(
    attempt: string,
    source: ProfileMigrationFence,
    candidate: OwnerMigrationCandidate,
  ): Promise<'retired' | 'absent'> {
    this.#requireEnabled();
    const context = this.#context(attempt);
    validFence(source);
    const checked = this.#candidate(candidate);
    const evidence = await this.#storage.conditionallyRetireUnreferenced({
      context,
      source,
      candidate: checked,
      validateDirectory: (directory) =>
        validateStoredProfileDirectory(directory) as ProfilesDirectory,
    });
    if (evidence.result === 'blocked')
      throw new Error(`Owner split cleanup refused: ${evidence.reason ?? 'unknown'}`);
    if (
      !validRetirementEvidence(
        evidence,
        context,
        source,
        checked,
        this.#householdId,
        this.#householdLibraryKey,
      )
    )
      throw new Error('Owner split cleanup proof is invalid');
    return evidence.result;
  }

  async #verifiedBackup(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: ProfileMigrationBackup,
  ): Promise<VerifiedOwnerSplitBackup> {
    validBackup(backup);
    const context = this.#context(attempt);
    const verified = await this.#storage.verifyBackup({ context, fence, backup });
    if (
      verified.id !== backup.id ||
      verified.digest !== backup.digest ||
      !sameContext(verified.context, context) ||
      !verified.readable ||
      !DIGEST.test(verified.digest) ||
      !sameFence(verified.source, fence)
    )
      throw new Error('Owner split backup is not verified at the migration fence');
    return verified;
  }

  async #authenticate(
    attempt: string,
    fence: ProfileMigrationFence,
    backup: VerifiedOwnerSplitBackup,
    candidate: OwnerMigrationCandidate,
  ): Promise<AuthenticatedOwnerCopy> {
    const plan = this.#plan(backup.preferenceValues);
    const context = this.#context(attempt);
    const evidence = await this.#storage.authenticateOwner({
      context,
      fence,
      backup,
      candidate,
      plan,
    });
    if (
      !evidence.authenticated ||
      !evidence.partitionComplete ||
      !DIGEST.test(evidence.head) ||
      !sameContext(evidence.context, context) ||
      !sameFence(evidence.source, fence) ||
      evidence.backup.id !== backup.id ||
      evidence.backup.digest !== backup.digest ||
      !sameCandidate(evidence.candidate, candidate) ||
      !sameDomains(evidence.plan.domains) ||
      canonical(evidence.plan.preferences) !== canonical(plan.preferences)
    )
      throw new Error('Owner copy is not authenticated, bound, and complete');
    return evidence;
  }

  #candidate(candidate: OwnerMigrationCandidate): OwnerMigrationCandidate {
    if (
      !LIBRARY_ID.test(candidate.profileId) ||
      !LIBRARY_ID.test(candidate.libraryId) ||
      !canonicalLibraryKey(candidate.libraryKey) ||
      candidate.libraryId === this.#householdId ||
      candidate.libraryKey === this.#householdLibraryKey
    )
      throw new Error('Owner split candidate is invalid');
    return { ...candidate };
  }

  #context(attempt: string): OwnerSplitAttemptContext {
    validAttempt(attempt);
    return {
      attempt,
      household: { libraryId: this.#householdId, libraryKey: this.#householdLibraryKey },
    };
  }

  #plan(values: unknown): OwnerCopyPlan {
    const preferences = this.#partitionPreferences(values);
    if (
      !record(preferences) ||
      !exactKeys(preferences, ['household', 'owner', 'ownerMaturity']) ||
      !record(preferences.household) ||
      !record(preferences.owner)
    )
      throw new Error('den-core preference partition is invalid');
    return { domains: OWNER_SPLIT_COPY_DOMAINS, preferences };
  }

  #requireEnabled(): void {
    if (!this.#enabled) throw new OwnerSplitDisabledError();
  }
}

function validAttempt(value: string): void {
  if (!LIBRARY_ID.test(value)) throw new Error('Owner split attempt is invalid');
}

function validFence(value: ProfileMigrationFence): void {
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !DIGEST.test(value.head) ||
    !Number.isSafeInteger(value.base) ||
    value.base < 0 ||
    value.rewrite.trim().length === 0 ||
    value.rewrite !== value.rewrite.trim()
  )
    throw new Error('Owner split fence is invalid');
}

function validBackup(value: ProfileMigrationBackup): void {
  if (value.id.trim().length === 0 || value.id !== value.id.trim() || !DIGEST.test(value.digest))
    throw new Error('Owner split backup identity is invalid');
}

function canonicalLibraryKey(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.length === 32 && btoa(String.fromCharCode(...bytes)) === value;
  } catch {
    return false;
  }
}

function sameFence(a: ProfileMigrationFence, b: ProfileMigrationFence): boolean {
  return (
    a.generation === b.generation &&
    a.head === b.head &&
    a.base === b.base &&
    a.rewrite === b.rewrite
  );
}

function sameContext(a: OwnerSplitAttemptContext, b: OwnerSplitAttemptContext): boolean {
  return (
    a.attempt === b.attempt &&
    a.household.libraryId === b.household.libraryId &&
    a.household.libraryKey === b.household.libraryKey
  );
}

function sameCandidate(a: OwnerMigrationCandidate, b: OwnerMigrationCandidate): boolean {
  return (
    a.profileId === b.profileId && a.libraryId === b.libraryId && a.libraryKey === b.libraryKey
  );
}

function sameDomains(value: readonly OwnerSplitCopyDomain[]): boolean {
  return (
    value.length === OWNER_SPLIT_COPY_DOMAINS.length &&
    OWNER_SPLIT_COPY_DOMAINS.every((domain) => value.includes(domain))
  );
}

function validRetirementEvidence(
  evidence: ConditionalRetirementEvidence,
  context: OwnerSplitAttemptContext,
  source: ProfileMigrationFence,
  candidate: OwnerMigrationCandidate,
  householdId: string,
  householdLibraryKey: string,
): boolean {
  const protectedIds = new Set(evidence.protectedLibraryIds);
  const protectedKeys = new Set(evidence.protectedLibraryKeys);
  const protectedIdentitiesAreCanonical =
    protectedIds.size === evidence.protectedLibraryIds.length &&
    protectedKeys.size === evidence.protectedLibraryKeys.length &&
    evidence.protectedLibraryIds.every((id) => LIBRARY_ID.test(id)) &&
    evidence.protectedLibraryKeys.every(canonicalLibraryKey);
  const directoryProof =
    evidence.authority.kind === 'committed'
      ? evidence.directoryValidated
      : !evidence.directoryValidated;
  const changedLegacyProof =
    evidence.authority.kind !== 'changed-legacy' ||
    evidence.authority.generation !== source.generation ||
    evidence.authority.head !== source.head;
  return (
    sameContext(evidence.context, context) &&
    sameFence(evidence.source, source) &&
    LIBRARY_ID.test(evidence.candidate.libraryId) &&
    canonicalLibraryKey(evidence.candidate.libraryKey) &&
    evidence.candidate.libraryId === candidate.libraryId &&
    evidence.candidate.libraryKey === candidate.libraryKey &&
    Number.isSafeInteger(evidence.authority.generation) &&
    evidence.authority.generation >= 0 &&
    DIGEST.test(evidence.authority.head) &&
    directoryProof &&
    changedLegacyProof &&
    protectedIdentitiesAreCanonical &&
    protectedIds.has(householdId) &&
    protectedKeys.has(householdLibraryKey) &&
    !protectedIds.has(candidate.libraryId) &&
    !protectedKeys.has(candidate.libraryKey)
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
