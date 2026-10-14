import {
  profileCapability,
  profileMigrationDigest,
  type MigrationSealedRow,
  type ProfileMigrationAuthorization,
  type ProfileCapabilityDecision,
} from './profileMigrationCore';
import {
  DormantOwnerSplitEffectExecutor,
  isMigrationInProgress,
  isMigrationSourceChanged,
  type OwnerSplitAttemptLookup,
  type OwnerSplitBackupReference,
  type OwnerSplitCandidateHandle,
  type OwnerSplitDurableEvidence,
  type OwnerSplitFence,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitJournalState,
  type OwnerSplitSource,
  type VerifiedOwnerSplitBackup,
} from './profileOwnerSplitEngine';

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface OwnerSplitJournal {
  readonly version: 6;
  readonly attempt: string;
  readonly explicitIntent: true;
  readonly householdId: string;
  /** Exact pre-PIN source observed and durably bound before this split attempt may open. */
  readonly source: OwnerSplitSource;
  readonly splitAuthorization: ProfileMigrationAuthorization;
  readonly state: OwnerSplitJournalState;
  readonly fence?: OwnerSplitFence;
  readonly backup?: { readonly id: string; readonly digest: string };
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

export interface OwnerSplitRecoveryIntent {
  readonly version: 2;
  readonly attempt: string;
  readonly recoveryAttempt: string;
  readonly recoveryIntent: true;
  /** Recovery has its own fresh explicit authorization and therefore its own durable source binding. */
  readonly source: OwnerSplitSource;
}

/**
 * Journal-less Owner recovery: this device holds no split journal (lost, cleared, or never held) for a household whose
 * exclusive migration lock is still held. One fresh Owner PIN against a freshly observed source authorizes a new
 * restore attempt, durably recorded here BEFORE its open request so a lost answer replays that same attempt. `fence`
 * and `backup` are the open answer's bound values, recorded together once it arrives.
 */
export interface OwnerSplitHandoffRecovery {
  readonly version: 1;
  readonly recoveryAttempt: string;
  readonly source: OwnerSplitSource;
  readonly fence?: OwnerSplitFence;
  readonly backup?: OwnerSplitBackupReference;
}

/**
 * Device-secure durable boundary. The exact core authorization is part of the sealed journal; neither raw candidate
 * keys nor provider tokens are accepted by this interface.
 */
export interface OwnerSplitJournalStore {
  load(): Promise<OwnerSplitJournal | null>;
  save(journal: OwnerSplitJournal): Promise<void>;
  authorizeRecovery(intent: OwnerSplitRecoveryIntent): Promise<void>;
  loadRecoveryIntent(attempt: string): Promise<OwnerSplitRecoveryIntent | null>;
  /** Drop a recovery authorization den-edge refused, keeping the split journal it was recorded beside. */
  discardRecovery(attempt: string): Promise<void>;
  loadHandoff(): Promise<OwnerSplitHandoffRecovery | null>;
  saveHandoff(handoff: OwnerSplitHandoffRecovery): Promise<void>;
  clearHandoff(recoveryAttempt: string): Promise<void>;
  clear(attempt: string): Promise<void>;
}

export type OwnerSplitRunResult =
  | { readonly kind: 'awaiting-confirmation'; readonly attempt: string; readonly ownerHead: string }
  | { readonly kind: 'commit-unknown'; readonly attempt: string }
  | { readonly kind: 'active'; readonly attempt: string }
  | { readonly kind: 'restored'; readonly attempt: string }
  | { readonly kind: 'recovery-blocked'; readonly attempt: string }
  /** The locked household was intact: its restore attempt was aborted, the lock released, nothing else changed. */
  | { readonly kind: 'released'; readonly attempt: string }
  /**
   * `409 migration_in_progress`: another attempt holds the household's exclusive lock and den-edge named nothing
   * about it. Nothing was opened here and nothing is retried; only an explicit Owner Restore can take the lock over.
   */
  | { readonly kind: 'setup-in-progress' }
  | { readonly kind: 'restart-required' }
  /** den-core refused the source before anything was staged; the attempt was aborted and the lock released. */
  | { readonly kind: 'refused'; readonly attempt: string; readonly reason: string }
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
  readonly #household: string;

  constructor(
    effects: DormantOwnerSplitEffectExecutor,
    store: OwnerSplitJournalStore,
    householdId: string,
  ) {
    if (!ID.test(householdId)) throw new Error('Invalid household library identity');
    this.#effects = effects;
    this.#store = store;
    this.#household = householdId;
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

  observeSource(): Promise<OwnerSplitSource> {
    return this.#effects.observeSource();
  }

  /** A PIN-verified action binds the already observed source and authorizes this exact attempt end to end. */
  async prepare(attempt: string, source: OwnerSplitSource): Promise<OwnerSplitRunResult> {
    checkedAttempt(attempt);
    if ((await this.#store.load()) !== null || (await this.#store.loadHandoff()) !== null)
      throw new Error('Owner split already has a durable journal');
    const householdId = this.#householdId();
    const splitAuthorization = await this.#effects.prepareAuthorization({
      attempt,
      householdId,
      source,
    });
    await this.#store.save({
      version: 6,
      attempt,
      explicitIntent: true,
      householdId,
      state: 'idle',
      source,
      splitAuthorization,
    });
    return this.#drive();
  }

  async resume(): Promise<OwnerSplitRunResult> {
    return this.#drive();
  }

  async cancel(attempt: string): Promise<OwnerSplitRunResult> {
    const journal = checkedOwnerSplitJournal(await this.#store.load());
    if (journal === null || journal.attempt !== attempt)
      throw new Error('Owner split attempt is absent');
    await this.#store.save({ ...journal, cancelRequested: true });
    return this.#drive();
  }

  async authorizeRecovery(
    attempt: string,
    recoveryAttempt: string,
    source: OwnerSplitSource,
  ): Promise<OwnerSplitRunResult> {
    checkedAttempt(recoveryAttempt);
    const journal = checkedOwnerSplitJournal(await this.#store.load());
    if (journal === null || journal.attempt !== attempt || journal.state !== 'restore-required')
      throw new Error('Owner split recovery is not required');
    await this.#store.authorizeRecovery({
      version: 2,
      attempt,
      recoveryAttempt,
      recoveryIntent: true,
      source,
    });
    return this.#drive();
  }

  /**
   * Owner Restore on a device with no split journal, for a household whose exclusive lock is still held. The restore
   * attempt and its freshly observed source are recorded durably first; only then does den-edge hand the lock and the
   * split's exact backup to it. An already durable handoff is resumed as it is: den-edge allows one restore attempt,
   * so a second would be refused, and the one in flight may already have opened.
   */
  async recoverWithoutJournal(
    recoveryAttempt: string,
    source: OwnerSplitSource,
  ): Promise<OwnerSplitRunResult> {
    checkedAttempt(recoveryAttempt);
    checkedSource(source, 'Invalid recovery source');
    if (checkedOwnerSplitJournal(await this.#store.load()) !== null)
      throw new Error('A split journal exists on this device; recover through it');
    if ((await this.#store.loadHandoff()) === null)
      await this.#store.saveHandoff({ version: 1, recoveryAttempt, source });
    return this.#driveHandoff();
  }

  async #driveHandoff(): Promise<OwnerSplitRunResult> {
    let handoff = await this.#store.loadHandoff();
    if (handoff === null) return { kind: 'inactive' };
    const { recoveryAttempt } = handoff;
    if (handoff.fence === undefined) {
      let opened: OwnerSplitAttemptLookup;
      try {
        opened = await this.#effects.open(recoveryAttempt, 'restore', handoff.source);
      } catch (error) {
        // Neither refusal opened anything, and the handoff authorizes nothing else: forget it.
        if (isMigrationInProgress(error)) {
          await this.#store.clearHandoff(recoveryAttempt);
          return { kind: 'setup-in-progress' };
        }
        if (isMigrationSourceChanged(error)) {
          await this.#store.clearHandoff(recoveryAttempt);
          return { kind: 'restart-required' };
        }
        throw error;
      }
      if (opened.purpose !== 'restore') throw new Error('Recovery attempt did not open');
      if (opened.state === 'restored') {
        await this.#store.clearHandoff(recoveryAttempt);
        return { kind: 'restored', attempt: recoveryAttempt };
      }
      if (opened.state === 'aborted') {
        await this.#store.clearHandoff(recoveryAttempt);
        return { kind: 'restart-required' };
      }
      if (opened.state !== 'open') throw new Error('Recovery attempt did not open');
      const bound = { fence: opened.fence, backup: opened.backup };
      await this.#store.saveHandoff({ ...handoff, ...bound });
      handoff = { ...handoff, ...bound };
    }
    const { fence, backup } = handoff;
    if (fence === undefined || backup === undefined)
      throw new Error('Recovery handoff lacks its bound backup');

    const authority = await this.#effects.lookupWithFreshAuthority(recoveryAttempt);
    if (authority.lookup.purpose !== 'restore') throw new Error('Recovery attempt changed purpose');
    if (authority.lookup.state === 'restored') {
      await this.#store.clearHandoff(recoveryAttempt);
      return { kind: 'restored', attempt: recoveryAttempt };
    }
    let lookup: OwnerSplitAttemptLookup = authority.lookup;
    let household: OwnerSplitHouseholdObservation = authority.household;
    if (lookup.state === 'open') {
      if (
        lookup.backup.attempt !== backup.attempt ||
        lookup.backup.id !== backup.id ||
        lookup.backup.digest !== backup.digest
      )
        throw new Error('Recovery attempt’s bound backup changed');
      await this.#effects.verifyBoundBackup({ attempt: recoveryAttempt, fence, backup });
    } else if (lookup.state !== 'aborted') {
      throw new Error('Recovery attempt is not open');
    }
    // An aborted attempt (ours, abandoned between its DELETE and the journal discard) is no longer open, so its
    // backup is not re-read: den-core only needs the durable lookup and a fresh household read after it.
    let householdFresh = true;
    for (let step = 0; step < 8; step += 1) {
      const effect = await this.#effects.planNext({
        state: 'restore-required',
        explicitIntent: true,
        fence,
        backupVerified: true,
        ownerVerified: false,
        winnerVerified: false,
        candidateRetired: false,
        commitAuthorized: false,
        cancelRequested: false,
        attemptAborted: lookup.state === 'aborted',
        attemptLookup: lookup.state,
        householdFresh,
        recoveryIntent: true,
        household,
        attempt: recoveryAttempt,
        householdId: this.#household,
        backupDigest: backup.digest,
      });
      // den-core is the only authority for what happens next; this loop performs exactly that effect.
      if (effect === 'abort-attempt') {
        // An intact household needs no restore: aborting this restore attempt releases the lock, unchanged.
        ({ lookup, household } = await this.#effects.abortWithFreshAuthority(recoveryAttempt));
        householdFresh = true;
        continue;
      }
      if (effect === 'read-household') {
        household = await this.#effects.readHousehold();
        householdFresh = true;
        continue;
      }
      if (effect === 'discard-journal') {
        await this.#store.clearHandoff(recoveryAttempt);
        return { kind: 'released', attempt: recoveryAttempt };
      }
      if (effect === 'open-recovery-attempt') {
        const restored = await this.#effects.restore({
          recoveryAttempt,
          originalAttempt: backup.attempt,
          backup: { id: backup.id, digest: backup.digest },
          household,
        });
        if (restored.state !== 'restored')
          throw new Error('Recovery did not reach a durable terminal');
        await this.#store.clearHandoff(recoveryAttempt);
        return { kind: 'restored', attempt: recoveryAttempt };
      }
      // Anything else leaves the handoff durable, the lock held and the household untouched.
      return { kind: 'recovery-blocked', attempt: recoveryAttempt };
    }
    throw new Error('Journal-less recovery exceeded its bounded effect budget');
  }

  async #drive(): Promise<OwnerSplitRunResult> {
    let journal = checkedOwnerSplitJournal(await this.#store.load());
    if (journal === null) {
      return (await this.#store.loadHandoff()) === null
        ? { kind: 'inactive' }
        : this.#driveHandoff();
    }
    let lookup: OwnerSplitAttemptLookup | undefined;
    let household: OwnerSplitHouseholdObservation | undefined;
    let householdFresh = false;
    let verifiedBackup: VerifiedOwnerSplitBackup | undefined;
    let refused: string | null = null;

    for (let step = 0; step < 32; step += 1) {
      const recovery = await this.#checkedRecoveryIntent(journal);
      // A `fenced` journal's backup is verified by the planner's `verify-backup` effect, not ahead of it.
      if (
        journal.backup &&
        journal.fence &&
        journal.state !== 'fenced' &&
        verifiedBackup === undefined
      )
        verifiedBackup = await this.#effects.verifyBoundBackup({
          attempt: journal.attempt,
          fence: journal.fence,
          backup: { attempt: journal.attempt, ...journal.backup },
        });
      // The real Worker transport deliberately refuses household reads until a durable fence exists. The initial
      // source is a separate authenticated endpoint and was already persisted by prepare before this loop.
      if (household === undefined && journal.state !== 'idle' && journal.state !== 'commit-unknown')
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
        commitAuthorized:
          journal.state !== 'restore-required' && journal.splitAuthorization.commitBinding !== null,
        cancelRequested: journal.cancelRequested === true,
        attemptAborted: journal.attemptAborted === true,
        attemptLookup: lookup?.state,
        householdFresh,
        recoveryIntent: recovery !== null,
        legacyStaleCandidate: journal.candidate !== undefined && lookup?.state === 'superseded',
        source: journal.state === 'idle' ? journal.source : undefined,
        household,
        attempt: journal.attempt,
        householdId: journal.householdId,
        backupDigest: journal.backup?.digest,
        stagedDigest: journal.stagedDigest,
        splitAuthorization: journal.splitAuthorization,
      });

      if (effect === 'no-op') return { kind: 'inactive' };
      if (effect === 'acquire-fence') {
        // Opening is the lookup too: repeating this attempt, purpose and source is answered from den-edge's stored
        // result, so a reload or a lost response resumes the same attempt and never mints a second one.
        let opened: OwnerSplitAttemptLookup;
        try {
          opened = await this.#effects.open(journal.attempt, 'split', journal.source);
        } catch (error) {
          if (isMigrationSourceChanged(error)) {
            await this.#store.clear(journal.attempt);
            return { kind: 'restart-required' };
          }
          // Definitive: a replay of an attempt den-edge opened is answered, never refused. An `idle` journal has
          // allocated no candidate and written nothing, so nothing of ours is left to clean up or resume.
          if (isMigrationInProgress(error)) {
            await this.#store.clear(journal.attempt);
            return { kind: 'setup-in-progress' };
          }
          throw error;
        }
        // Another device's Owner Restore took this lock over and tombstoned the split: it can never be resumed.
        if (opened.state === 'aborted') {
          await this.#store.clear(journal.attempt);
          return { kind: 'restart-required' };
        }
        if (opened.state !== 'open' || opened.purpose !== 'split')
          throw new Error('Split attempt did not open');
        if (opened.backup.attempt !== journal.attempt)
          throw new Error('Split attempt was opened with another attempt’s backup');
        // The lock exists only together with its provider-verified backup, so fence and backup are recorded as one.
        journal = await this.#save({
          ...journal,
          state: 'fenced',
          fence: opened.fence,
          backup: { id: opened.backup.id, digest: opened.backup.digest },
        });
        household = undefined;
        continue;
      }
      if (effect === 'verify-backup') {
        const fence = requiredFence(journal);
        if (journal.backup === undefined)
          throw new Error('Owner split journal lacks the server-bound backup');
        verifiedBackup = await this.#effects.verifyBoundBackup({
          attempt: journal.attempt,
          fence,
          backup: { attempt: journal.attempt, ...journal.backup },
        });
        journal = await this.#save({ ...journal, state: 'backed-up' });
        continue;
      }
      if (effect === 'create-owner-library') {
        if (verifiedBackup === undefined) throw new Error('Verified backup is absent');
        let prepared: OwnerSplitDurableEvidence;
        try {
          prepared = await this.#effects.copyAndAuthenticateCandidate({
            attempt: journal.attempt,
            fence: requiredFence(journal),
            backup: verifiedBackup,
            candidate: journal.candidate,
          });
        } catch (error) {
          // den-core refused this frozen source (`legacy_source_row`: v2/v3 rows the library-v4 switch has not yet
          // folded). Nothing is staged, and the same backup is refused on every retry, so the attempt is cancelled
          // through den-core's own plan (abort, then discard), which releases the household lock.
          const reason = coreRefusal(error);
          if (reason === null) throw error;
          console.error(`den: den-core refused this profile setup's source (${reason})`, error);
          refused = reason;
          journal = await this.#save({ ...journal, cancelRequested: true });
          continue;
        }
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
      if (effect === 'record-commit-binding') {
        const evidence = durableEvidence(journal);
        const stagedDigest = requiredDigest(journal.stagedDigest, 'staged digest');
        const splitAuthorization = await this.#effects.bindAuthorization({
          authorization: journal.splitAuthorization,
          evidence,
          stagedDigest,
        });
        journal = await this.#save({
          ...journal,
          state: 'ready-to-commit',
          splitAuthorization,
        });
        continue;
      }
      if (effect === 'commit-fenced-household' || effect === 'retry-bound-commit') {
        if (journal.splitAuthorization.commitBinding === null)
          throw new Error('Commit effect lacks exact-attempt authorization');
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
        return refused === null
          ? { kind: 'cancelled' }
          : { kind: 'refused', attempt: journal.attempt, reason: refused };
      }
      if (effect === 'restart') {
        await this.#store.clear(journal.attempt);
        return { kind: 'restart-required' };
      }
      if (effect === 'invalidate-authorization') {
        if (lookup?.state === 'open') await this.#effects.abortWithFreshAuthority(journal.attempt);
        await this.#store.clear(journal.attempt);
        return { kind: 'restart-required' };
      }
      if (effect === 'recovery-blocked')
        return { kind: 'recovery-blocked', attempt: journal.attempt };
      if (effect === 'open-recovery-attempt') {
        if (recovery === null || household === undefined || journal.backup === undefined)
          throw new Error('Recovery effect lacks durable evidence');
        let opened: OwnerSplitAttemptLookup;
        try {
          opened = await this.#effects.open(recovery.recoveryAttempt, 'restore', recovery.source);
        } catch (error) {
          // The split journal stays: only the refused recovery authorization is dropped, so Restore can be asked
          // for again. Nothing is retried here.
          if (isMigrationInProgress(error)) {
            await this.#store.discardRecovery(journal.attempt);
            return { kind: 'setup-in-progress' };
          }
          if (isMigrationSourceChanged(error)) {
            await this.#store.discardRecovery(journal.attempt);
            return { kind: 'restart-required' };
          }
          throw error;
        }
        if (opened.state !== 'open' || opened.purpose !== 'restore')
          throw new Error('Recovery attempt did not open');
        // The handoff binds the exact backup this journal verified; nothing is replaced by inference.
        if (
          opened.backup.attempt !== journal.attempt ||
          opened.backup.id !== journal.backup.id ||
          opened.backup.digest !== journal.backup.digest
        )
          throw new Error('Recovery attempt was bound to a different backup than this journal’s');
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

  async #checkedRecoveryIntent(
    journal: OwnerSplitJournal,
  ): Promise<OwnerSplitRecoveryIntent | null> {
    const value = await this.#store.loadRecoveryIntent(journal.attempt);
    if (value === null) return null;
    if (
      value.version !== 2 ||
      value.recoveryIntent !== true ||
      value.attempt !== journal.attempt ||
      !ID.test(value.recoveryAttempt)
    )
      throw new Error('Invalid durable recovery intent');
    checkedSource(value.source, 'Invalid durable recovery intent');
    return value;
  }

  async #save(journal: OwnerSplitJournal): Promise<OwnerSplitJournal> {
    const checked = checkedOwnerSplitJournal(journal);
    if (checked === null) throw new Error('Refusing invalid Owner split journal');
    await this.#store.save(checked);
    return checked;
  }

  #householdId(): string {
    return this.#household;
  }
}

/** Strict durable boundary shared by the Worker store and coordinator. */
export function checkedOwnerSplitJournal(
  value: OwnerSplitJournal | null,
): OwnerSplitJournal | null {
  if (value === null) return null;
  if (
    value.version !== 6 ||
    value.explicitIntent !== true ||
    !ID.test(value.attempt) ||
    !ID.test(value.householdId) ||
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
  checkedSource(value.source, 'Invalid Owner split journal');
  checkedSplitAuthorization(value.splitAuthorization, value);
  for (const digest of [value.backup?.digest, value.ownerHead, value.stagedDigest])
    if (digest !== undefined && !DIGEST.test(digest))
      throw new Error('Invalid Owner split journal');
  if (value.fence !== undefined) checkedJournalFence(value.fence);
  if (value.backup !== undefined && value.backup.id.length === 0)
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

function checkedSource(value: unknown, message: string): asserts value is OwnerSplitSource {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'generation') ||
    !Object.hasOwn(value, 'head')
  )
    throw new Error(message);
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => key !== 'generation' && key !== 'head') ||
    !Number.isSafeInteger(source.generation) ||
    Number(source.generation) < 0 ||
    typeof source.head !== 'string' ||
    !DIGEST.test(source.head)
  )
    throw new Error(message);
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

function checkedSplitAuthorization(
  authorization: unknown,
  journal: Pick<OwnerSplitJournal, 'attempt' | 'householdId' | 'source'>,
): asserts authorization is ProfileMigrationAuthorization {
  if (typeof authorization !== 'object' || authorization === null || Array.isArray(authorization))
    throw new Error('Invalid Owner split journal');
  const record = authorization as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['intent', 'intentDigest', 'commitBinding'].includes(key)) ||
    typeof record.intent !== 'object' ||
    record.intent === null ||
    Array.isArray(record.intent)
  )
    throw new Error('Invalid Owner split journal');
  const intent = record.intent as Record<string, unknown>;
  if (
    Object.keys(intent).some(
      (key) => !['version', 'action', 'attempt', 'householdId', 'source'].includes(key),
    ) ||
    intent.version !== 1 ||
    intent.action !== 'enable-profiles' ||
    intent.attempt !== journal.attempt ||
    intent.householdId !== journal.householdId
  )
    throw new Error('Invalid Owner split journal');
  checkedSource(intent.source, 'Invalid Owner split journal');
  if (
    intent.source.generation !== journal.source.generation ||
    intent.source.head !== journal.source.head ||
    typeof record.intentDigest !== 'string' ||
    !DIGEST.test(record.intentDigest) ||
    (record.commitBinding !== null &&
      (typeof record.commitBinding !== 'string' || !DIGEST.test(record.commitBinding)))
  )
    throw new Error('Invalid Owner split journal');
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

/** The error code den-core answered with (`syncPolicy`), or null for any other failure. */
function coreRefusal(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^Sync policy rejected the action: (.+)$/.exec(error.message)?.[1] ?? null;
}
