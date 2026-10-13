import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import {
  constructOwnerDirectoryWithCore,
  planOwnerSplitWithCore,
} from './profileOwnerSplitCoreWorker';
import type { OwnerSplitPlannerEvidence } from './profileOwnerSplitEngine';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const CANDIDATE_KEY = 'REREREREREREREREREREREREREREREREREREREREREQ=';
const fence = {
  generation: 7,
  base: 4,
  head: 'a'.repeat(64),
  rewrite: 'rewrite-7',
};

const evidence = (values: Partial<OwnerSplitPlannerEvidence>): OwnerSplitPlannerEvidence => ({
  state: 'idle',
  explicitIntent: true,
  backupVerified: false,
  ownerVerified: false,
  winnerVerified: false,
  candidateRetired: false,
  commitAuthorized: false,
  cancelRequested: false,
  attemptAborted: false,
  householdFresh: false,
  recoveryIntent: false,
  household: { kind: 'legacy', generation: 7, base: 4, head: 'a'.repeat(64) },
  ...values,
});

describe('Owner split worker den-core adapter', () => {
  it('maps opaque-ref evidence to the real lifecycle planner without local policy', () => {
    expect(planOwnerSplitWithCore(evidence({}))).toBe('acquire-fence');
    expect(
      planOwnerSplitWithCore(
        evidence({
          state: 'awaiting-confirmation',
          fence,
          backupVerified: true,
          ownerVerified: true,
          candidate: {
            profileId: '0'.repeat(32),
            libraryId: '1'.repeat(32),
            keyRef: 'secure-slot',
            keyFingerprint: 'b'.repeat(64),
          },
          candidateAttempt: ATTEMPT,
          candidateHead: 'c'.repeat(64),
        }),
        CANDIDATE_KEY,
      ),
    ).toBe('await-final-confirmation');
  });

  it('never permits a candidate evidence record without resolving its worker-owned key', () => {
    expect(() =>
      planOwnerSplitWithCore(
        evidence({
          state: 'owner-copied',
          fence,
          backupVerified: true,
          candidate: {
            profileId: '0'.repeat(32),
            libraryId: '1'.repeat(32),
            keyRef: 'secure-slot',
            keyFingerprint: 'b'.repeat(64),
          },
          candidateAttempt: ATTEMPT,
        }),
      ),
    ).toThrow('did not resolve');
  });

  it('returns den-core canonical and compressed directory bytes unchanged', () => {
    const constructed = constructOwnerDirectoryWithCore(
      fixture.migrationDirectoryConstructorInput as Record<string, unknown>,
    );
    const expected = fixture.migrationDirectoryConstructorCases[0]!.expect!;
    expect(constructed.directory).toEqual(JSON.parse(JSON.stringify(expected.directory)));
    expect(constructed.jcs).toBe(expected.jcs);
    expect(constructed.plaintext).toBe(expected.plaintext);
  });
});
