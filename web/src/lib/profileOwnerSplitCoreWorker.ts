import {
  profileMigrationConstructDirectory,
  profileMigrationNext,
  type MigrationDirectoryConstruction,
  type ProfileMigrationEffect,
} from './profileMigrationCore';
import type { OwnerSplitPlannerEvidence } from './profileOwnerSplitEngine';

/**
 * Worker-only adapter for den-core #57. `candidateKey` is resolved from an opaque secure reference for this call and
 * must never be returned, logged or persisted. This function contains mapping only; den-core owns every decision.
 */
export function planOwnerSplitWithCore(
  evidence: OwnerSplitPlannerEvidence,
  candidateKey?: string,
): ProfileMigrationEffect {
  const input: Record<string, unknown> = {
    state: evidence.state,
    explicitIntent: true,
    backupVerified: evidence.backupVerified,
    ownerVerified: evidence.ownerVerified,
    winnerVerified: evidence.winnerVerified,
    candidateRetired: evidence.candidateRetired,
    commitAuthorized: evidence.commitAuthorized,
    cancelRequested: evidence.cancelRequested,
    attemptAborted: evidence.attemptAborted,
    householdFresh: evidence.householdFresh,
    recoveryIntent: evidence.recoveryIntent,
    attempt: evidence.attempt,
    householdId: evidence.householdId,
    splitAuthorization: evidence.splitAuthorization,
    wireMin: 5,
  };
  if (evidence.backupDigest) input.backupDigest = evidence.backupDigest;
  if (evidence.stagedDigest) input.stagedDigest = evidence.stagedDigest;
  if (evidence.fence)
    input.fence = { generation: evidence.fence.generation, head: evidence.fence.head };
  if (evidence.attemptLookup) input.attemptLookup = evidence.attemptLookup;
  if (evidence.candidate) {
    if (candidateKey === undefined) throw new Error('Candidate secure reference did not resolve');
    input.candidateKey = candidateKey;
    input.candidateAttempt = evidence.candidateAttempt;
  } else if (candidateKey !== undefined) {
    throw new Error('Unbound candidate key');
  }
  if (evidence.candidateHead) input.candidateHead = evidence.candidateHead;
  if (evidence.source && evidence.household)
    throw new Error('Pre-fence source cannot replace fresh household authority');
  if (evidence.source) {
    input.observed = 'legacy';
    input.observedFence = {
      generation: evidence.source.generation,
      head: evidence.source.head,
    };
  } else if (evidence.household) {
    input.observed = evidence.household.kind;
    if (evidence.household.kind === 'legacy')
      input.observedFence = {
        generation: evidence.household.generation,
        head: evidence.household.head,
      };
    if (evidence.household.kind === 'committed') input.directory = evidence.household.directory;
  }
  return profileMigrationNext(input);
}

/** Core-owned logical directory plus exact canonical and compressed seal-ready bytes. */
export function constructOwnerDirectoryWithCore(
  input: Record<string, unknown>,
): MigrationDirectoryConstruction {
  return profileMigrationConstructDirectory(input);
}
