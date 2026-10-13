import type {
  MigrationSealedRow,
  MigrationSnapshotRow,
  ProfileMigrationAuthorization,
  ProfileMigrationEffect,
} from './profileMigrationCore';

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface OwnerSplitFence {
  readonly generation: number;
  readonly base: number;
  readonly head: string;
  readonly rewrite: string;
}

export interface OwnerSplitSource {
  readonly generation: number;
  readonly head: string;
}

export interface OwnerSplitBackup {
  readonly id: string;
  readonly digest: string;
  readonly source: OwnerSplitFence;
  readonly householdId: string;
  readonly attempt: string;
  readonly wireMin: number;
  readonly authorization: { readonly tokenHash: string; readonly memberHash: string | null };
  readonly rows: readonly MigrationSnapshotRow[];
}

/** Public handle only. The credential behind `keyRef` never crosses the worker boundary. */
export interface OwnerSplitCandidateHandle {
  readonly profileId: string;
  readonly libraryId: string;
  readonly keyRef: string;
  readonly keyFingerprint: string;
}

export interface OwnerSplitAuthenticatedCopy {
  readonly ownerHead: string;
  /** Fully sealed household rewrite rows, including core-constructed `profiles`; safe to persist and stage. */
  readonly householdWrites: readonly MigrationSealedRow[];
}

export type OwnerSplitPurpose = 'split' | 'restore';

interface OwnerSplitAttemptBase {
  readonly attempt: string;
  readonly purpose: OwnerSplitPurpose;
  readonly wireMin: number;
  readonly fence: OwnerSplitFence;
}

export interface OwnerSplitOpenAttempt extends OwnerSplitAttemptBase {
  readonly state: 'open';
}

interface OwnerSplitTerminal {
  readonly attempt: string;
  readonly generation: number;
  readonly base: number;
  readonly head: string;
  readonly wireMin: number;
  readonly backup: { readonly id: string; readonly digest: string };
}

export type OwnerSplitWinner =
  | (OwnerSplitTerminal & { readonly state: 'committed'; readonly stagedDigest: string })
  | (OwnerSplitTerminal & { readonly state: 'restored'; readonly stagedDigest: null });

export type OwnerSplitAttemptLookup =
  | OwnerSplitOpenAttempt
  | (OwnerSplitAttemptBase & { readonly state: 'aborted' })
  | (OwnerSplitAttemptBase &
      OwnerSplitTerminal & { readonly state: 'committed'; readonly stagedDigest: string })
  | (OwnerSplitAttemptBase &
      OwnerSplitTerminal & { readonly state: 'restored'; readonly stagedDigest: null })
  | (OwnerSplitAttemptBase & { readonly state: 'superseded'; readonly winner: OwnerSplitWinner });

export interface OwnerSplitHouseholdObservation {
  readonly kind: 'legacy' | 'committed' | 'corrupt';
  readonly generation: number;
  readonly base: number;
  readonly head: string;
  readonly directory?: unknown;
  readonly profilesRow?: {
    readonly k: string;
    readonly seq: number;
    readonly v: string;
    readonly digest: string;
  };
}

/** Worker-owned provider port. Tokens are never arguments, URL members, or journal fields. */
export interface OwnerSplitProvider {
  observeSource(): Promise<OwnerSplitSource>;
  open(
    attempt: string,
    purpose: 'split' | 'restore',
    expectedSource: OwnerSplitSource,
  ): Promise<OwnerSplitAttemptLookup>;
  lookup(attempt: string): Promise<OwnerSplitAttemptLookup>;
  abort(attempt: string): Promise<OwnerSplitAttemptLookup>;
  createBackup(attempt: string): Promise<{ readonly id: string; readonly digest: string }>;
  readBackup(attempt: string): Promise<OwnerSplitBackup>;
  stage(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: { readonly id: string; readonly digest: string };
    readonly writes: readonly MigrationSealedRow[];
  }): Promise<string>;
  commit(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: { readonly id: string; readonly digest: string };
    readonly stagedDigest: string;
  }): Promise<OwnerSplitAttemptLookup>;
  readHousehold(): Promise<OwnerSplitHouseholdObservation>;
  retireCandidate(input: {
    readonly attempt: string;
    readonly source: OwnerSplitFence;
    readonly authority: OwnerSplitHouseholdObservation;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly protectedLibraryIds: readonly string[];
  }): Promise<'retired' | 'absent'>;
  restore(input: {
    readonly attempt: string;
    readonly backup: Pick<OwnerSplitBackup, 'id' | 'digest'> & { readonly attempt: string };
    readonly observation: OwnerSplitHouseholdObservation;
    readonly plannerDecision: string;
  }): Promise<OwnerSplitAttemptLookup>;
}

/**
 * Injected worker/device-secure boundary. Candidate key bytes and provider credentials stay behind this interface.
 * There is intentionally no localStorage/IndexedDB implementation.
 */
export interface OwnerSplitSecureWorker {
  prepareAuthorization(input: {
    readonly attempt: string;
    readonly householdId: string;
    readonly source: OwnerSplitSource;
  }): Promise<ProfileMigrationAuthorization>;
  allocateCandidate(attempt: string): Promise<OwnerSplitCandidateHandle>;
  verifyBackup(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly created: { readonly id: string; readonly digest: string };
    readonly reread: OwnerSplitBackup;
  }): Promise<void>;
  copyAndAuthenticateOwner(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerSplitCandidateHandle;
  }): Promise<OwnerSplitAuthenticatedCopy>;
  verifyOwnerLibrary(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly expectedHead: string;
  }): Promise<void>;
  bindAuthorization(input: {
    readonly authorization: ProfileMigrationAuthorization;
    readonly evidence: OwnerSplitDurableEvidence;
    readonly stagedDigest: string;
  }): Promise<ProfileMigrationAuthorization>;
  /** Resolve opaque key refs and invoke den-core `profiles_migration_next`; no lifecycle policy lives in TS. */
  planNext(input: OwnerSplitPlannerEvidence): Promise<ProfileMigrationEffect>;
  verifyCommittedWinner(input: {
    readonly directory: unknown;
    readonly attempt: string;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly ownerHead: string;
  }): Promise<{ readonly ownerLibraryId: string; readonly protectedLibraryIds: readonly string[] }>;
  inspectCommittedDirectory(directory: unknown): Promise<{
    readonly winnerAttempt: string;
    readonly ownerHead: string;
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }>;
  verifyDirectoryWinner(directory: unknown): Promise<{
    readonly winnerAttempt: string;
    readonly ownerHead: string;
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }>;
  adoptWinner(directory: unknown): Promise<void>;
  forgetCandidate(keyRef: string): Promise<void>;
}

const VERIFIED_BACKUP: unique symbol = Symbol('verified-owner-split-backup');

/** Nominal proof produced only after create + reread + worker verification completes. */
export interface VerifiedOwnerSplitBackup {
  readonly manifest: OwnerSplitBackup;
  readonly [VERIFIED_BACKUP]: true;
}

export interface OwnerSplitDurableEvidence {
  readonly attempt: string;
  readonly householdId: string;
  readonly fence: OwnerSplitFence;
  readonly backup: { readonly id: string; readonly digest: string };
  readonly candidate: OwnerSplitCandidateHandle;
  readonly ownerHead: string;
  readonly householdWrites: readonly MigrationSealedRow[];
}

export interface OwnerSplitPlannerEvidence {
  readonly state: OwnerSplitJournalState;
  readonly explicitIntent: true;
  readonly fence?: OwnerSplitFence;
  readonly backupVerified: boolean;
  readonly candidate?: OwnerSplitCandidateHandle;
  readonly candidateAttempt?: string;
  readonly ownerVerified: boolean;
  readonly candidateHead?: string;
  readonly winnerVerified: boolean;
  readonly candidateRetired: boolean;
  readonly commitAuthorized: boolean;
  readonly cancelRequested: boolean;
  readonly attemptAborted: boolean;
  readonly attemptLookup?: OwnerSplitAttemptLookup['state'];
  readonly householdFresh: boolean;
  readonly recoveryIntent: boolean;
  /** Pre-fence authenticated source; den-core consumes it as the legacy observation without a household read. */
  readonly source?: OwnerSplitSource;
  readonly household?: OwnerSplitHouseholdObservation;
  readonly attempt: string;
  readonly householdId: string;
  readonly backupDigest?: string;
  readonly stagedDigest?: string;
  readonly splitAuthorization: ProfileMigrationAuthorization;
}

export type OwnerSplitJournalState =
  | 'idle'
  | 'fenced'
  | 'backed-up'
  | 'owner-copied'
  | 'awaiting-confirmation'
  | 'ready-to-commit'
  | 'commit-unknown'
  | 'adopting'
  | 'cleaning-loser'
  | 'active'
  | 'restore-required';

export class OwnerSplitUnavailableError extends Error {
  constructor() {
    super('Owner split lifecycle is dormant');
    this.name = 'OwnerSplitUnavailableError';
  }
}

/**
 * Real IO/crypto effects for the future core-owned lifecycle. The class is default-off, has no app caller, and has
 * no method which chooses an effect. In particular, it cannot turn an Owner gesture into commit authorization.
 */
export class DormantOwnerSplitEffectExecutor {
  readonly #provider: OwnerSplitProvider;
  readonly #secure: OwnerSplitSecureWorker;
  readonly #enabled: boolean;

  constructor(options: {
    provider: OwnerSplitProvider;
    secureWorker: OwnerSplitSecureWorker;
    enabled?: boolean;
  }) {
    this.#provider = options.provider;
    this.#secure = options.secureWorker;
    this.#enabled = options.enabled ?? false;
  }

  capabilities(): {
    readonly enabled: boolean;
    readonly activatable: false;
    readonly lifecyclePlanner: 'den-core';
    readonly householdStage: 'available';
    readonly rawKeyPersistence: false;
  } {
    return {
      enabled: this.#enabled,
      activatable: false,
      lifecyclePlanner: 'den-core',
      householdStage: 'available',
      rawKeyPersistence: false,
    };
  }

  async observeSource(): Promise<OwnerSplitSource> {
    this.#requireEnabled();
    const source = await this.#provider.observeSource();
    checkedSource(source);
    return source;
  }

  prepareAuthorization(input: {
    readonly attempt: string;
    readonly householdId: string;
    readonly source: OwnerSplitSource;
  }): Promise<ProfileMigrationAuthorization> {
    this.#requireEnabled();
    checkedAttempt(input.attempt);
    if (!ID.test(input.householdId)) throw new Error('Invalid household library identity');
    checkedSource(input.source);
    return this.#secure.prepareAuthorization(input);
  }

  open(
    attempt: string,
    purpose: 'split' | 'restore',
    expectedSource: OwnerSplitSource,
  ): Promise<OwnerSplitAttemptLookup> {
    this.#requireEnabled();
    checkedAttempt(attempt);
    checkedSource(expectedSource);
    return this.#provider.open(attempt, purpose, expectedSource);
  }

  async createVerifiedBackup(
    attempt: string,
    fence: OwnerSplitFence,
  ): Promise<VerifiedOwnerSplitBackup> {
    this.#requireEnabled();
    checkedAttempt(attempt);
    checkedFence(fence);
    const created = checkedBackup(await this.#provider.createBackup(attempt));
    const reread = await this.#provider.readBackup(attempt);
    await this.#secure.verifyBackup({ attempt, fence, created, reread });
    return { manifest: reread, [VERIFIED_BACKUP]: true };
  }

  async reverifyBackup(
    attempt: string,
    fence: OwnerSplitFence,
    reference: { readonly id: string; readonly digest: string },
  ): Promise<VerifiedOwnerSplitBackup> {
    this.#requireEnabled();
    checkedAttempt(attempt);
    checkedFence(fence);
    const created = checkedBackup(reference);
    const reread = await this.#provider.readBackup(attempt);
    await this.#secure.verifyBackup({ attempt, fence, created, reread });
    return { manifest: reread, [VERIFIED_BACKUP]: true };
  }

  async copyAndAuthenticateCandidate(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate?: OwnerSplitCandidateHandle;
  }): Promise<OwnerSplitDurableEvidence> {
    this.#requireEnabled();
    checkedAttempt(input.attempt);
    checkedFence(input.fence);
    const backup = checkedVerifiedBackup(input.backup);
    if (backup.attempt !== input.attempt || !sameFence(backup.source, input.fence))
      throw new Error('Verified backup does not belong to this attempt and fence');
    const candidate = input.candidate ?? (await this.#secure.allocateCandidate(input.attempt));
    checkedCandidate(candidate);
    const copied = await this.#secure.copyAndAuthenticateOwner({
      attempt: input.attempt,
      fence: input.fence,
      backup: input.backup,
      candidate,
    });
    checkedDigest(copied.ownerHead);
    checkedWrites(copied.householdWrites);
    return {
      attempt: input.attempt,
      householdId: backup.householdId,
      fence: input.fence,
      backup: { id: backup.id, digest: backup.digest },
      candidate,
      ownerHead: copied.ownerHead,
      householdWrites: copied.householdWrites,
    };
  }

  async verifyPreparedOwner(input: {
    readonly evidence: OwnerSplitDurableEvidence;
    readonly backup: VerifiedOwnerSplitBackup;
  }): Promise<void> {
    this.#requireEnabled();
    checkedEvidence(input.evidence);
    const manifest = checkedVerifiedBackup(input.backup);
    if (
      manifest.attempt !== input.evidence.attempt ||
      !sameFence(manifest.source, input.evidence.fence)
    )
      throw new Error('Verified backup does not belong to prepared Owner');
    await this.#secure.verifyOwnerLibrary({
      attempt: input.evidence.attempt,
      fence: input.evidence.fence,
      backup: input.backup,
      candidate: input.evidence.candidate,
      expectedHead: input.evidence.ownerHead,
    });
  }

  bindAuthorization(input: {
    readonly authorization: ProfileMigrationAuthorization;
    readonly evidence: OwnerSplitDurableEvidence;
    readonly stagedDigest: string;
  }): Promise<ProfileMigrationAuthorization> {
    this.#requireEnabled();
    checkedEvidence(input.evidence);
    checkedDigest(input.stagedDigest);
    return this.#secure.bindAuthorization(input);
  }

  async stageHousehold(input: { readonly evidence: OwnerSplitDurableEvidence }): Promise<string> {
    this.#requireEnabled();
    checkedEvidence(input.evidence);
    const stagedDigest = await this.#provider.stage({
      attempt: input.evidence.attempt,
      fence: input.evidence.fence,
      backup: input.evidence.backup,
      writes: input.evidence.householdWrites,
    });
    checkedDigest(stagedDigest);
    return stagedDigest;
  }

  commitHousehold(input: {
    readonly evidence: OwnerSplitDurableEvidence;
    readonly stagedDigest: string;
  }): Promise<OwnerSplitAttemptLookup> {
    this.#requireEnabled();
    checkedEvidence(input.evidence);
    checkedDigest(input.stagedDigest);
    return this.#provider.commit({
      attempt: input.evidence.attempt,
      fence: input.evidence.fence,
      backup: input.evidence.backup,
      stagedDigest: input.stagedDigest,
    });
  }

  planNext(input: OwnerSplitPlannerEvidence): Promise<ProfileMigrationEffect> {
    this.#requireEnabled();
    return this.#secure.planNext(input);
  }

  async adoptWinner(household: OwnerSplitHouseholdObservation): Promise<void> {
    this.#requireEnabled();
    if (household.kind !== 'committed' || household.directory === undefined)
      throw new Error('Winner adoption requires a fresh committed directory');
    await this.#secure.adoptWinner(household.directory);
  }

  async lookupWithFreshAuthority(attempt: string): Promise<{
    readonly lookup: OwnerSplitAttemptLookup;
    readonly household: OwnerSplitHouseholdObservation;
  }> {
    this.#requireEnabled();
    checkedAttempt(attempt);
    const lookup = await this.#provider.lookup(attempt);
    const household = await this.#provider.readHousehold();
    return { lookup, household };
  }

  async verifyOwnWinner(
    evidence: OwnerSplitDurableEvidence,
    household: OwnerSplitHouseholdObservation,
  ): Promise<void> {
    this.#requireEnabled();
    checkedEvidence(evidence);
    if (household.kind !== 'committed' || household.directory === undefined)
      throw new Error('Committed lookup lacks fresh household directory authority');
    await this.#secure.verifyCommittedWinner({
      directory: household.directory,
      attempt: evidence.attempt,
      candidate: evidence.candidate,
      ownerHead: evidence.ownerHead,
    });
  }

  async verifyWinner(household: OwnerSplitHouseholdObservation): Promise<{
    readonly winnerAttempt: string;
    readonly ownerHead: string;
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }> {
    this.#requireEnabled();
    if (household.kind !== 'committed' || household.directory === undefined)
      throw new Error('Winner verification requires a fresh committed directory');
    return this.#secure.verifyDirectoryWinner(household.directory);
  }

  readHousehold(): Promise<OwnerSplitHouseholdObservation> {
    this.#requireEnabled();
    return this.#provider.readHousehold();
  }

  async abortWithFreshAuthority(attempt: string): Promise<{
    readonly lookup: OwnerSplitAttemptLookup;
    readonly household: OwnerSplitHouseholdObservation;
  }> {
    this.#requireEnabled();
    checkedAttempt(attempt);
    await this.#provider.abort(attempt);
    const lookup = await this.#provider.lookup(attempt);
    if (lookup.state !== 'aborted') throw new Error('Migration abort is not durable');
    return { lookup, household: await this.#provider.readHousehold() };
  }

  async retireLoser(
    evidence: OwnerSplitDurableEvidence,
    household: OwnerSplitHouseholdObservation,
    lookup: OwnerSplitAttemptLookup,
  ): Promise<'retired' | 'absent'> {
    this.#requireEnabled();
    checkedEvidence(evidence);
    if (lookup.attempt !== evidence.attempt)
      throw new Error('Candidate cleanup attempt evidence does not match');
    if (
      household.kind === 'legacy' &&
      household.generation === evidence.fence.generation &&
      household.head === evidence.fence.head &&
      lookup.state !== 'aborted'
    )
      throw new Error('Refusing candidate cleanup against the unchanged legacy source');
    const directoryProtectedIds =
      household.kind === 'committed' && household.directory !== undefined
        ? (await this.#secure.inspectCommittedDirectory(household.directory)).protectedLibraryIds
        : [];
    const protectedLibraryIds = [...new Set([evidence.householdId, ...directoryProtectedIds])];
    if (protectedLibraryIds.includes(evidence.candidate.libraryId))
      throw new Error('Refusing to retire a live profile library');
    const result = await this.#provider.retireCandidate({
      attempt: evidence.attempt,
      source: evidence.fence,
      authority: household,
      candidate: evidence.candidate,
      protectedLibraryIds,
    });
    await this.#secure.forgetCandidate(evidence.candidate.keyRef);
    return result;
  }

  restore(input: {
    readonly recoveryAttempt: string;
    readonly originalAttempt: string;
    readonly backup: { readonly id: string; readonly digest: string };
    readonly household: OwnerSplitHouseholdObservation;
  }): Promise<OwnerSplitAttemptLookup> {
    this.#requireEnabled();
    checkedAttempt(input.recoveryAttempt);
    checkedAttempt(input.originalAttempt);
    checkedBackup(input.backup);
    return this.#provider.restore({
      attempt: input.recoveryAttempt,
      backup: { attempt: input.originalAttempt, ...input.backup },
      observation: input.household,
      plannerDecision: 'restore-backup',
    });
  }

  #requireEnabled(): void {
    if (!this.#enabled) throw new OwnerSplitUnavailableError();
  }
}

function checkedSource(source: OwnerSplitSource): void {
  if (
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !DIGEST.test(source.head)
  )
    throw new TypeError('Migration source is not canonical');
}

function checkedEvidence(value: OwnerSplitDurableEvidence): void {
  checkedAttempt(value.attempt);
  if (!ID.test(value.householdId)) throw new Error('Invalid household library identity');
  checkedFence(value.fence);
  checkedBackup(value.backup);
  checkedCandidate(value.candidate);
  checkedDigest(value.ownerHead);
  checkedWrites(value.householdWrites);
}

function checkedVerifiedBackup(value: VerifiedOwnerSplitBackup): OwnerSplitBackup {
  if (!value || value[VERIFIED_BACKUP] !== true)
    throw new Error('Owner split backup has not been verified');
  return value.manifest;
}

function sameFence(left: OwnerSplitFence, right: OwnerSplitFence): boolean {
  return (
    left.generation === right.generation &&
    left.base === right.base &&
    left.head === right.head &&
    left.rewrite === right.rewrite
  );
}

function checkedAttempt(value: string): void {
  if (!ID.test(value)) throw new Error('Invalid migration attempt');
}

function checkedFence(value: OwnerSplitFence): void {
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.base) ||
    value.base < 0 ||
    !DIGEST.test(value.head) ||
    value.rewrite.length === 0
  )
    throw new Error('Invalid Owner split fence');
}

function checkedBackup<T extends { readonly id: string; readonly digest: string }>(value: T): T {
  if (!value.id || !DIGEST.test(value.digest)) throw new Error('Invalid Owner split backup');
  return value;
}

function checkedCandidate(value: OwnerSplitCandidateHandle): void {
  if (
    !ID.test(value.profileId) ||
    !ID.test(value.libraryId) ||
    value.keyRef.length === 0 ||
    !DIGEST.test(value.keyFingerprint)
  )
    throw new Error('Invalid Owner candidate handle');
}

function checkedDigest(value: string): void {
  if (!DIGEST.test(value)) throw new Error('Invalid migration digest');
}

function checkedWrites(value: readonly MigrationSealedRow[]): void {
  const keys = new Set<string>();
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Invalid sealed household rewrite');
  for (const row of value) {
    if (!DIGEST.test(row.k) || typeof row.v !== 'string' || row.v.length === 0 || keys.has(row.k))
      throw new Error('Invalid sealed household rewrite');
    keys.add(row.k);
  }
}
