import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import {
  constructOwnerDirectoryWithCore,
  planOwnerSplitWithCore,
} from './profileOwnerSplitCoreWorker';
import { profileMigrationAuthorization } from './profileMigrationCore';
import type { OwnerSplitPlannerEvidence } from './profileOwnerSplitEngine';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const HOUSEHOLD = '00112233445566778899aabbccddeeff';
const CANDIDATE_KEY = 'REREREREREREREREREREREREREREREREREREREREREQ=';
const fence = {
  generation: 7,
  base: 4,
  head: 'a'.repeat(64),
  rewrite: 'rewrite-7',
};
const splitAuthorization = profileMigrationAuthorization({
  intent: {
    version: 1,
    action: 'enable-profiles',
    attempt: ATTEMPT,
    householdId: HOUSEHOLD,
    source: { generation: 7, head: 'a'.repeat(64) },
  },
  evidence: null,
});

const evidence = (values: Partial<OwnerSplitPlannerEvidence>): OwnerSplitPlannerEvidence => ({
  attempt: ATTEMPT,
  householdId: HOUSEHOLD,
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
  splitAuthorization,
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
          backupDigest: 'd'.repeat(64),
          stagedDigest: 'e'.repeat(64),
        }),
        CANDIDATE_KEY,
      ),
    ).toBe('record-commit-binding');
  });

  it('asks to verify the server-bound backup at `fenced`, never to create one', () => {
    expect(
      planOwnerSplitWithCore(evidence({ state: 'fenced', fence, backupDigest: 'd'.repeat(64) })),
    ).toBe('verify-backup');
    expect(
      planOwnerSplitWithCore(
        evidence({ state: 'backed-up', fence, backupVerified: true, backupDigest: 'd'.repeat(64) }),
      ),
    ).toBe('create-owner-library');
  });

  describe('stale candidate cleanup needs den-edge’s legacy evidence', () => {
    const stale = (values: Partial<OwnerSplitPlannerEvidence>) =>
      evidence({
        state: 'ready-to-commit',
        household: {
          kind: 'committed',
          generation: 8,
          base: 5,
          head: 'f'.repeat(64),
          directory: fixture.migrationBase,
        },
        candidate: {
          profileId: '0'.repeat(32),
          libraryId: '1'.repeat(32),
          keyRef: 'secure-slot',
          keyFingerprint: 'b'.repeat(64),
        },
        candidateAttempt: 'fedcba9876543210fedcba9876543210',
        ...values,
      });

    it('refuses a candidate that is not the committed Owner without that evidence', () => {
      expect(() => planOwnerSplitWithCore(stale({}), CANDIDATE_KEY)).toThrow(
        'legacy_cleanup_evidence_required',
      );
    });

    it('lets the superseded-lookup evidence through to den-core’s own cleanup rules', () => {
      expect(planOwnerSplitWithCore(stale({ legacyStaleCandidate: true }), CANDIDATE_KEY)).toBe(
        'verify-winner',
      );
      // Evidence is not a bypass: a live profile key is still never cleanable.
      expect(
        planOwnerSplitWithCore(
          stale({ legacyStaleCandidate: true, state: 'cleaning-loser', winnerVerified: true }),
          'ERERERERERERERERERERERERERERERERERERERERERE=',
        ),
      ).toBe('cleanup_targets_winner');
    });
  });

  it('plans a journal-less Restore without any split authorization', () => {
    expect(
      planOwnerSplitWithCore(
        evidence({
          state: 'restore-required',
          fence,
          backupVerified: true,
          recoveryIntent: true,
          splitAuthorization: undefined,
          household: { kind: 'corrupt', generation: 8, base: 5, head: 'f'.repeat(64) },
        }),
      ),
    ).toBe('open-recovery-attempt');
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
