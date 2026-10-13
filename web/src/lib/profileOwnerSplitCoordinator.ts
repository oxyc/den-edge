import {
  profileCapability,
  profileMigrationDigest,
  type MigrationSealedRow,
  type ProfileCapabilityDecision,
} from './profileMigrationCore';
import {
  DormantOwnerSplitEffectExecutor,
  type OwnerSplitAttemptLookup,
  type OwnerSplitCandidateHandle,
  type OwnerSplitDurableEvidence,
  type OwnerSplitFence,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitJournalState,
  type VerifiedOwnerSplitBackup,
} from './profileOwnerSplitEngine';

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface OwnerSplitJournal {
  readonly version: 4;
  readonly attempt: string;
  readonly explicitIntent: true;
  readonly state: OwnerSplitJournalState;
  readonly fence?: OwnerSplitFence;
  readonly backup?: { readonly id: string; readonly digest: string };
  readonly householdId?: string;
  readonly candidate?: OwnerSplitCandidateHandle;
  readonly ownerHead?: string;
  readonly householdWrites?: readonly MigrationSealedRow[];
  readonly stagedDigest?: string;
  readonly ownerVerified?: boolean;
  readonly winnerVerified?: boolean;
  readonly candidateRetired?: boolean;
  readonly cancelRequested?: boolean;
  readonly attemptAborted?: boolean;
}

export interface OwnerSplitCommitAuthorization {
  readonly version: 1;
  readonly attempt: string;
  readonly ownerHead: string;
  readonly stagedDigest: string;
  readonly commitAuthorized: true;
}

export interface OwnerSplitRecoveryIntent {
  readonly version: 1;
  readonly attempt: string;
  readonly recoveryAttempt: string;
  readonly recoveryIntent: true;
}

/**
 * Device-secure durable boundary. `authorizeCommit` atomically stores the ready journal and a distinct authorization
 * record; neither raw candidate keys nor provider tokens are accepted by this interface.
 */
export interface OwnerSplitJournalStore {
  load(): Promise<OwnerSplitJournal | null>;
  save(journal: OwnerSplitJournal): Promise<void>;
  authorizeCommit(
    journal: OwnerSplitJournal & { readonly state: 'ready-to-commit' },
    authorization: OwnerSplitCommitAuthorization,
  ): Promise<void>;
  loadCommitAuthorization(attempt: string): Promise<OwnerSplitCommitAuthorization | null>;
  authorizeRecovery(intent: OwnerSplitRecoveryIntent): Promise<void>;
  loadRecoveryIntent(attempt: string): Promise<OwnerSplitRecoveryIntent | null>;
  clear(attempt: string): Promise<void>;
}

export type OwnerSplitRunResult =
  | { readonly kind: 'awaiting-confirmation'; readonly attempt: string; readonly ownerHead: string }
  | { readonly kind: 'commit-unknown'; readonly attempt: string }
  | { readonly kind: 'active'; readonly attempt: string }
  | { readonly kind: 'restored'; readonly attempt: string }
  | { readonly kind: 'recovery-blocked'; readonly attempt: string }
  | { readonly kind: 'restart-required' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'inactive' };

/**
 * Dormant coordinator for den-core #57 effects. It has no app caller and cannot enable its own effect executor.
 * Every decision comes from the secure worker's exact den-core planner; this class only performs that effect and
 * durably records evidence before any irreversible request.
 */
export class DormantOwnerSplitCoordinator {
  readonly #effects: DormantOwnerSplitEffectExecutor;
  readonly #store: OwnerSplitJournalStore;

  constructor(effects: DormantOwnerSplitEffectExecutor, store: OwnerSplitJournalStore) {
    this.#effects = effects;
    this.#store = store;
  }

  capability(input: {
    readonly enrollment: 'off' | 'prepare';
    readonly wireMin: number;
    readonly directory: 'absent' | 'valid' | 'invalid';
    readonly request: 'ordinary' | 'migration';
    readonly wire: number;
    readonly authenticated: boolean;
  }): ProfileCapabilityDecision {
    return profileCapability(input);
  }

  /** Explicit Owner intent prepares only. It always stops before final authorization, even after a reload. */
  async prepare(attempt: string): Promise<OwnerSplitRunResult> {
    checkedAttempt(attempt);
    if ((await this.#store.load()) !== null)
      throw new Error('Owner split already has a durable journal');
    await this.#store.save({
      version: 4,
      attempt,
      explicitIntent: true,
      state: 'idle',
    });
    return this.#drive(false);
  }

  async resume(): Promise<OwnerSplitRunResult> {
    return this.#drive(true);
  }

  /** A separate explicit action. The store must atomically persist the ready state and bound authorization record. */
  async authorizeCommit(attempt: string): Promise<void> {
    const journal = checkedJournal(await this.#store.load());
    if (
      journal === null ||
      journal.attempt !== attempt ||
      journal.state !== 'awaiting-confirmation' ||
      journal.ownerHead === undefined ||
      journal.stagedDigest === undefined
    )
      throw new Error('Owner split is not awaiting final confirmation');
    const ready = { ...journal, state: 'ready-to-commit' as const };
    await this.#store.authorizeCommit(ready, {
      version: 1,
      attempt,
      ownerHead: journal.ownerHead,
      stagedDigest: journal.stagedDigest,
      commitAuthorized: true,
    });
  }

  async cancel(attempt: string): Promise<OwnerSplitRunResult> {
    const journal = checkedJournal(await this.#store.load());
    if (journal === null || journal.attempt !== attempt)
      throw new Error('Owner split attempt is absent');
    await this.#store.save({ ...journal, cancelRequested: true });
    return this.#drive(true);
  }

  async authorizeRecovery(attempt: string, recoveryAttempt: string): Promise<OwnerSplitRunResult> {
    checkedAttempt(recoveryAttempt);
    const journal = checkedJournal(await this.#store.load());
    if (journal === null || journal.attempt !== attempt || journal.state !== 'restore-required')
      throw new Error('Owner split recovery is not required');
    await this.#store.authorizeRecovery({
      version: 1,
      attempt,
      recoveryAttempt,
      recoveryIntent: true,
    });
    return this.#drive(true);
  }

  async #drive(allowCommit: boolean): Promise<OwnerSplitRunResult> {
    let journal = checkedJournal(await this.#store.load());
    if (journal === null) return { kind: 'inactive' };
    let lookup: OwnerSplitAttemptLookup | undefined;
    let household: OwnerSplitHouseholdObservation | undefined;
    let householdFresh = false;
    let verifiedBackup: VerifiedOwnerSplitBackup | undefined;

    for (let step = 0; step < 32; step += 1) {
      const authorization = await this.#checkedAuthorization(journal);
      const recovery = await this.#checkedRecoveryIntent(journal);
      if (journal.backup && journal.fence && verifiedBackup === undefined)
        verifiedBackup = await this.#effects.reverifyBackup(
          journal.attempt,
          journal.fence,
          journal.backup,
        );
      if (household === undefined && journal.state !== 'commit-unknown')
        household = await this.#effects.readHousehold();

      const effect = await this.#effects.planNext({
        state: journal.state,
        explicitIntent: true,
        fence: journal.fence,
        backupVerified: verifiedBackup !== undefined,
        candidate: journal.candidate,
        candidateAttempt: journal.candidate ? journal.attempt : undefined,
        ownerVerified: journal.ownerVerified === true,
        candidateHead: journal.ownerVerified ? journal.ownerHead : undefined,
        winnerVerified: journal.winnerVerified === true,
        candidateRetired: journal.candidateRetired === true,
        commitAuthorized: allowCommit && authorization !== null,
        cancelRequested: journal.cancelRequested === true,
        attemptAborted: journal.attemptAborted === true,
        attemptLookup: lookup?.state,
        householdFresh,
        recoveryIntent: recovery !== null,
        household,
      });

      if (effect === 'no-op') return { kind: 'inactive' };
      if (effect === 'acquire-fence') {
        const opened = await this.#effects.open(journal.attempt, 'split');
        if (opened.state !== 'open' || opened.purpose !== 'split')
          throw new Error('Split attempt did not open');
        journal = await this.#save({ ...journal, state: 'fenced', fence: opened.fence });
        household = undefined;
        continue;
      }
      if (effect === 'create-backup') {
        const fence = requiredFence(journal);
        verifiedBackup = await this.#effects.createVerifiedBackup(journal.attempt, fence);
        journal = await this.#save({
          ...journal,
          state: 'backed-up',
          backup: {
            id: verifiedBackup.manifest.id,
            digest: verifiedBackup.manifest.digest,
          },
        });
        continue;
      }
      if (effect === 'create-owner-library') {
        if (verifiedBackup === undefined) throw new Error('Verified backup is absent');
        const prepared = await this.#effects.copyAndAuthenticateCandidate({
          attempt: journal.attempt,
          fence: requiredFence(journal),
          backup: verifiedBackup,
          candidate: journal.candidate,
        });
        journal = await this.#save({
          ...journal,
          state: 'owner-copied',
          householdId: prepared.householdId,
          candidate: prepared.candidate,
          ownerHead: prepared.ownerHead,
          householdWrites: prepared.householdWrites,
        });
        continue;
      }
      if (effect === 'verify-owner-library') {
        if (verifiedBackup === undefined) throw new Error('Verified backup is absent');
        const evidence = durableEvidence(journal);
        await this.#effects.verifyPreparedOwner({ evidence, backup: verifiedBackup });
        const stagedDigest = await this.#effects.stageHousehold({ evidence });
        if (stagedDigest !== profileMigrationDigest('staged', { rows: evidence.householdWrites }))
          throw new Error('Provider staged digest disagrees with den-core');
        journal = await this.#save({
          ...journal,
          state: 'awaiting-confirmation',
          ownerVerified: true,
          stagedDigest,
        });
        continue;
      }
      if (effect === 'await-final-confirmation')
        return {
          kind: 'awaiting-confirmation',
          attempt: journal.attempt,
          ownerHead: requiredDigest(journal.ownerHead, 'Owner head'),
        };
      if (effect === 'commit-fenced-household' || effect === 'retry-bound-commit') {
        if (!allowCommit || authorization === null)
          throw new Error('Commit effect lacks separately durable authorization');
        checkedAuthorizationBinding(journal, authorization);
        if (effect === 'commit-fenced-household') {
          journal = await this.#save({ ...journal, state: 'commit-unknown' });
        }
        await this.#effects.commitHousehold({
          evidence: durableEvidence(journal),
          stagedDigest: requiredDigest(journal.stagedDigest, 'staged digest'),
        });
        const authority = await this.#effects.lookupWithFreshAuthority(journal.attempt);
        lookup = authority.lookup;
        household = authority.household;
        householdFresh = true;
        continue;
      }
      if (effect === 'lookup-attempt' || effect === 'read-household') {
        const authority = await this.#effects.lookupWithFreshAuthority(journal.attempt);
        lookup = authority.lookup;
        household = authority.household;
        householdFresh = true;
        continue;
      }
      if (effect === 'verify-winner') {
        if (household === undefined) throw new Error('Fresh household authority is absent');
        await this.#effects.verifyWinner(household);
        journal = await this.#save({ ...journal, state: 'adopting', winnerVerified: true });
        continue;
      }
      if (effect === 'retire-losing-candidate') {
        if (household === undefined || lookup === undefined)
          throw new Error('Fresh candidate-cleanup authority is absent');
        await this.#effects.retireLoser(durableEvidence(journal), household, lookup);
        journal = await this.#save({
          ...journal,
          state: 'cleaning-loser',
          candidateRetired: true,
        });
        continue;
      }
      if (effect === 'activate') {
        if (household === undefined) household = await this.#effects.readHousehold();
        await this.#effects.adoptWinner(household);
        await this.#store.clear(journal.attempt);
        return { kind: 'active', attempt: journal.attempt };
      }
      if (effect === 'abort-attempt') {
        const authority = await this.#effects.abortWithFreshAuthority(journal.attempt);
        lookup = authority.lookup;
        household = authority.household;
        householdFresh = true;
        journal = await this.#save({ ...journal, attemptAborted: true });
        continue;
      }
      if (effect === 'discard-journal') {
        await this.#store.clear(journal.attempt);
        return { kind: 'cancelled' };
      }
      if (effect === 'restart') {
        await this.#store.clear(journal.attempt);
        return { kind: 'restart-required' };
      }
      if (effect === 'recovery-blocked')
        return { kind: 'recovery-blocked', attempt: journal.attempt };
      if (effect === 'open-recovery-attempt') {
        if (recovery === null || household === undefined || journal.backup === undefined)
          throw new Error('Recovery effect lacks durable evidence');
        const opened = await this.#effects.open(recovery.recoveryAttempt, 'restore');
        if (opened.state !== 'open' || opened.purpose !== 'restore')
          throw new Error('Recovery attempt did not open');
        const restored = await this.#effects.restore({
          recoveryAttempt: recovery.recoveryAttempt,
          originalAttempt: journal.attempt,
          backup: journal.backup,
          household,
        });
        if (restored.state !== 'restored')
          throw new Error('Recovery did not reach a durable terminal');
        await this.#store.clear(journal.attempt);
        return { kind: 'restored', attempt: journal.attempt };
      }
      if (effect === 'cleanup_targets_winner')
        throw new Error('den-core refused cleanup of a live winner');
    }
    throw new Error('Owner split exceeded its bounded effect budget');
  }

  async #checkedAuthorization(
    journal: OwnerSplitJournal,
  ): Promise<OwnerSplitCommitAuthorization | null> {
    const value = await this.#store.loadCommitAuthorization(journal.attempt);
    if (value === null) return null;
    if (
      value.version !== 1 ||
      value.commitAuthorized !== true ||
      value.attempt !== journal.attempt ||
      !DIGEST.test(value.ownerHead) ||
      !DIGEST.test(value.stagedDigest)
    )
      throw new Error('Invalid durable commit authorization');
    return value;
  }

  async #checkedRecoveryIntent(
    journal: OwnerSplitJournal,
  ): Promise<OwnerSplitRecoveryIntent | null> {
    const value = await this.#store.loadRecoveryIntent(journal.attempt);
    if (value === null) return null;
    if (
      value.version !== 1 ||
      value.recoveryIntent !== true ||
      value.attempt !== journal.attempt ||
      !ID.test(value.recoveryAttempt)
    )
      throw new Error('Invalid durable recovery intent');
    return value;
  }

  async #save(journal: OwnerSplitJournal): Promise<OwnerSplitJournal> {
    const checked = checkedJournal(journal);
    if (checked === null) throw new Error('Refusing invalid Owner split journal');
    await this.#store.save(checked);
    return checked;
  }
}

function checkedJournal(value: OwnerSplitJournal | null): OwnerSplitJournal | null {
  if (value === null) return null;
  if (
    value.version !== 4 ||
    value.explicitIntent !== true ||
    !ID.test(value.attempt) ||
    ![
      'idle',
      'fenced',
      'backed-up',
      'owner-copied',
      'awaiting-confirmation',
      'ready-to-commit',
      'commit-unknown',
      'adopting',
      'cleaning-loser',
      'active',
      'restore-required',
    ].includes(value.state)
  )
    throw new Error('Invalid Owner split journal');
  for (const digest of [value.backup?.digest, value.ownerHead, value.stagedDigest])
    if (digest !== undefined && !DIGEST.test(digest))
      throw new Error('Invalid Owner split journal');
  if (value.fence !== undefined) checkedJournalFence(value.fence);
  if (value.backup !== undefined && value.backup.id.length === 0)
    throw new Error('Invalid Owner split journal');
  if (value.householdId !== undefined && !ID.test(value.householdId))
    throw new Error('Invalid Owner split journal');
  if (value.candidate !== undefined) checkedJournalCandidate(value.candidate);
  if (value.householdWrites !== undefined) checkedJournalWrites(value.householdWrites);
  for (const flag of [
    value.ownerVerified,
    value.winnerVerified,
    value.candidateRetired,
    value.cancelRequested,
    value.attemptAborted,
  ])
    if (flag !== undefined && typeof flag !== 'boolean')
      throw new Error('Invalid Owner split journal');
  if (value.state !== 'idle' && value.fence === undefined)
    throw new Error('Invalid Owner split journal');
  if (!['idle', 'fenced'].includes(value.state) && value.backup === undefined)
    throw new Error('Invalid Owner split journal');
  if (
    [
      'owner-copied',
      'awaiting-confirmation',
      'ready-to-commit',
      'commit-unknown',
      'adopting',
      'cleaning-loser',
      'active',
    ].includes(value.state) &&
    (value.householdId === undefined ||
      value.candidate === undefined ||
      value.ownerHead === undefined ||
      value.householdWrites === undefined)
  )
    throw new Error('Invalid Owner split journal');
  if (
    [
      'awaiting-confirmation',
      'ready-to-commit',
      'commit-unknown',
      'adopting',
      'cleaning-loser',
    ].includes(value.state) &&
    (value.ownerVerified !== true || value.stagedDigest === undefined)
  )
    throw new Error('Invalid Owner split journal');
  return value;
}

function checkedJournalFence(value: OwnerSplitFence): void {
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.base) ||
    value.base < 0 ||
    !DIGEST.test(value.head) ||
    value.rewrite.length === 0
  )
    throw new Error('Invalid Owner split journal');
}

function checkedJournalCandidate(value: OwnerSplitCandidateHandle): void {
  if (
    !ID.test(value.profileId) ||
    !ID.test(value.libraryId) ||
    value.keyRef.length === 0 ||
    !DIGEST.test(value.keyFingerprint)
  )
    throw new Error('Invalid Owner split journal');
}

function checkedJournalWrites(value: readonly MigrationSealedRow[]): void {
  const keys = new Set<string>();
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid Owner split journal');
  for (const row of value) {
    if (!DIGEST.test(row.k) || typeof row.v !== 'string' || row.v.length === 0 || keys.has(row.k))
      throw new Error('Invalid Owner split journal');
    keys.add(row.k);
  }
}

function checkedAuthorizationBinding(
  journal: OwnerSplitJournal,
  authorization: OwnerSplitCommitAuthorization,
): void {
  if (
    authorization.attempt !== journal.attempt ||
    authorization.ownerHead !== journal.ownerHead ||
    authorization.stagedDigest !== journal.stagedDigest
  )
    throw new Error('Commit authorization is not bound to prepared evidence');
}

function durableEvidence(journal: OwnerSplitJournal): OwnerSplitDurableEvidence {
  if (
    journal.fence === undefined ||
    journal.backup === undefined ||
    journal.householdId === undefined ||
    journal.candidate === undefined ||
    journal.ownerHead === undefined ||
    journal.householdWrites === undefined
  )
    throw new Error('Owner split journal lacks prepared evidence');
  return {
    attempt: journal.attempt,
    householdId: journal.householdId,
    fence: journal.fence,
    backup: journal.backup,
    candidate: journal.candidate,
    ownerHead: journal.ownerHead,
    householdWrites: journal.householdWrites,
  };
}

function requiredFence(journal: OwnerSplitJournal): OwnerSplitFence {
  if (journal.fence === undefined) throw new Error('Owner split fence is absent');
  return journal.fence;
}

function requiredDigest(value: string | undefined, name: string): string {
  if (value === undefined || !DIGEST.test(value)) throw new Error(`${name} is absent`);
  return value;
}

function checkedAttempt(value: string): void {
  if (!ID.test(value)) throw new Error('Invalid Owner split attempt');
}
