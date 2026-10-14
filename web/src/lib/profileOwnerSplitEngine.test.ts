import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DormantOwnerSplitEffectExecutor,
  OwnerSplitUnavailableError,
  type OwnerSplitAttemptLookup,
  type OwnerSplitCandidateHandle,
  type OwnerSplitDurableEvidence,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitProvider,
  type OwnerSplitSecureWorker,
  type VerifiedOwnerSplitBackup,
} from './profileOwnerSplitEngine';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const PROFILE = '00112233445566778899aabbccddeeff';
const LIBRARY = '11112222333344445555666677778888';
const HEAD = 'a'.repeat(64);
const BACKUP = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
const WRITE = { k: 'd'.repeat(64), v: 'sealed-household' };
const fence = { generation: 7, base: 4, head: HEAD, rewrite: 'rewrite-7' };
const candidate: OwnerSplitCandidateHandle = {
  profileId: PROFILE,
  libraryId: LIBRARY,
  keyRef: 'worker-key-slot-7',
  keyFingerprint: 'e'.repeat(64),
};
const backup = {
  id: 'backup-7',
  digest: BACKUP,
  source: fence,
  householdId: PROFILE,
  attempt: ATTEMPT,
  wireMin: 4 as const,
  authorization: { tokenHash: HEAD, memberHash: null },
  rows: [],
};
const boundBackup = { attempt: ATTEMPT, id: backup.id, digest: backup.digest };
const evidence: OwnerSplitDurableEvidence = {
  attempt: ATTEMPT,
  householdId: PROFILE,
  fence,
  backup: { id: backup.id, digest: backup.digest },
  candidate,
  ownerHead: OWNER,
  householdWrites: [WRITE],
};

function harness() {
  let observation: OwnerSplitHouseholdObservation = {
    kind: 'legacy',
    generation: 8,
    base: 5,
    head: 'f'.repeat(64),
  };
  const opened: OwnerSplitAttemptLookup = {
    state: 'open',
    attempt: ATTEMPT,
    purpose: 'split',
    wireMin: 4,
    fence,
    backup: { attempt: ATTEMPT, id: backup.id, digest: backup.digest },
  };
  const provider: OwnerSplitProvider = {
    observeSource: vi.fn(async () => ({
      generation: observation.generation,
      head: observation.head,
    })),
    open: vi.fn(async () => opened),
    lookup: vi.fn(async () => opened),
    abort: vi.fn(async () => ({
      state: 'aborted' as const,
      attempt: ATTEMPT,
      purpose: 'split' as const,
      wireMin: 4,
      fence,
    })),
    readBackup: vi.fn(async () => backup),
    stage: vi.fn(async () => 'f'.repeat(64)),
    commit: vi.fn(async () => opened),
    readHousehold: vi.fn(async () => observation),
    retireCandidate: vi.fn(async () => 'retired' as const),
    restore: vi.fn(async () => opened),
  };
  const secure: OwnerSplitSecureWorker = {
    prepareAuthorization: vi.fn(),
    bindAuthorization: vi.fn(),
    allocateCandidate: vi.fn(async () => candidate),
    verifyBackup: vi.fn(async () => {}),
    copyAndAuthenticateOwner: vi.fn(async () => ({
      ownerHead: OWNER,
      householdWrites: [WRITE],
    })),
    verifyOwnerLibrary: vi.fn(async () => {}),
    planNext: vi.fn(async () => 'no-op' as const),
    verifyCommittedWinner: vi.fn(async () => ({
      ownerLibraryId: LIBRARY,
      protectedLibraryIds: [PROFILE, LIBRARY],
    })),
    inspectCommittedDirectory: vi.fn(async () => ({
      winnerAttempt: '9'.repeat(32),
      ownerHead: OWNER,
      ownerLibraryId: '2'.repeat(32),
      protectedLibraryIds: [PROFILE, '2'.repeat(32)],
    })),
    verifyDirectoryWinner: vi.fn(async () => ({
      winnerAttempt: '9'.repeat(32),
      ownerHead: OWNER,
      ownerLibraryId: '2'.repeat(32),
      protectedLibraryIds: [PROFILE, '2'.repeat(32)],
    })),
    adoptWinner: vi.fn(async () => {}),
    forgetCandidate: vi.fn(async () => {}),
  };
  return {
    provider,
    secure,
    executor: new DormantOwnerSplitEffectExecutor({
      provider,
      secureWorker: secure,
      enabled: true,
    }),
    setObservation(value: OwnerSplitHouseholdObservation) {
      observation = value;
    },
  };
}

describe('dormant Owner split effect executor', () => {
  it('is default-off, non-activatable and declares the missing core lifecycle planner', () => {
    const value = harness();
    const executor = new DormantOwnerSplitEffectExecutor({
      provider: value.provider,
      secureWorker: value.secure,
    });
    expect(executor.capabilities()).toEqual({
      enabled: false,
      activatable: false,
      lifecyclePlanner: 'den-core',
      householdStage: 'available',
      rawKeyPersistence: false,
    });
    expect('commitAuthorized' in executor).toBe(false);
    expect('stageHousehold' in executor).toBe(true);
    expect('restore' in executor).toBe(true);
    expect(() => executor.open(ATTEMPT, 'split', { generation: 7, head: HEAD })).toThrow(
      OwnerSplitUnavailableError,
    );
  });

  it('rereads and verifies the backup an open bound, without creating one', async () => {
    const value = harness();
    const verified = await value.executor.verifyBoundBackup({
      attempt: ATTEMPT,
      fence,
      backup: boundBackup,
    });
    expect(verified.manifest).toEqual(backup);
    expect(value.provider.readBackup).toHaveBeenCalledOnce();
    expect(value.provider.readBackup).toHaveBeenCalledWith(ATTEMPT, ATTEMPT);
    expect(value.secure.verifyBackup).toHaveBeenCalledWith({
      attempt: ATTEMPT,
      fence,
      created: { id: backup.id, digest: backup.digest },
      reread: backup,
    });
    expect('createVerifiedBackup' in value.executor).toBe(false);
    expect('createBackup' in value.provider).toBe(false);
  });

  it('verifies a handed-off backup against its own split and the handoff source', async () => {
    const value = harness();
    const recovery = 'fedcba9876543210fedcba9876543210';
    // The restore attempt has its own rewrite handle, but the same frozen generation, base and head.
    const handoffFence = { ...fence, rewrite: 'rewrite-recovery' };
    const verified = await value.executor.verifyBoundBackup({
      attempt: recovery,
      fence: handoffFence,
      backup: boundBackup,
    });
    expect(value.provider.readBackup).toHaveBeenCalledWith(recovery, ATTEMPT);
    expect(value.secure.verifyBackup).toHaveBeenCalledWith({
      attempt: ATTEMPT,
      fence: backup.source,
      created: { id: backup.id, digest: backup.digest },
      reread: backup,
    });
    expect(verified.manifest.attempt).toBe(ATTEMPT);

    vi.mocked(value.secure.verifyBackup).mockClear();
    await expect(
      value.executor.verifyBoundBackup({
        attempt: recovery,
        fence: { ...handoffFence, head: 'e'.repeat(64) },
        backup: boundBackup,
      }),
    ).rejects.toThrow('does not describe the recovery attempt source');
    expect(value.secure.verifyBackup).not.toHaveBeenCalled();
  });

  it('keeps the candidate key opaque while copying and reading back Owner', async () => {
    const value = harness();
    const verified = await value.executor.verifyBoundBackup({
      attempt: ATTEMPT,
      fence,
      backup: boundBackup,
    });
    const result = await value.executor.copyAndAuthenticateCandidate({
      attempt: ATTEMPT,
      fence,
      backup: verified,
    });
    expect(result).toEqual(evidence);
    expect(JSON.stringify(result)).not.toContain('libraryKey');
    expect(JSON.stringify(result)).not.toContain('candidateToken');
    expect(value.secure.copyAndAuthenticateOwner).toHaveBeenCalledOnce();
  });

  it('requires nominal create+reread verification evidence before candidate copy', async () => {
    expectTypeOf(backup).not.toMatchTypeOf<VerifiedOwnerSplitBackup>();
    const value = harness();
    await expect(
      value.executor.copyAndAuthenticateCandidate({
        attempt: ATTEMPT,
        fence,
        backup: backup as unknown as VerifiedOwnerSplitBackup,
      }),
    ).rejects.toThrow('has not been verified');
    expect(value.secure.allocateCandidate).not.toHaveBeenCalled();
    expect(value.secure.copyAndAuthenticateOwner).not.toHaveBeenCalled();
  });

  it('couples uncertain lookup and abort with a fresh household read', async () => {
    const value = harness();
    await value.executor.lookupWithFreshAuthority(ATTEMPT);
    expect(value.provider.lookup).toHaveBeenCalledOnce();
    expect(value.provider.readHousehold).toHaveBeenCalledOnce();
    vi.mocked(value.provider.lookup).mockResolvedValueOnce({
      state: 'aborted',
      attempt: ATTEMPT,
      purpose: 'split',
      wireMin: 4,
      fence,
    });
    await value.executor.abortWithFreshAuthority(ATTEMPT);
    expect(value.provider.abort).toHaveBeenCalledOnce();
    expect(value.provider.readHousehold).toHaveBeenCalledTimes(2);
  });

  it('protects every validated committed profile before loser retirement', async () => {
    const value = harness();
    value.setObservation({
      kind: 'committed',
      generation: 8,
      base: 5,
      head: HEAD,
      directory: { kind: 'profiles' },
    });
    const fresh = await value.provider.readHousehold();
    const authority = await value.executor.lookupWithFreshAuthority(ATTEMPT);
    expect(await value.executor.retireLoser(evidence, fresh, authority.lookup)).toBe('retired');
    expect(value.secure.inspectCommittedDirectory).toHaveBeenCalledOnce();
    expect(value.provider.retireCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ protectedLibraryIds: [PROFILE, '2'.repeat(32)] }),
    );
    expect(value.secure.forgetCandidate).toHaveBeenCalledWith(candidate.keyRef);
  });

  it('protects the household library during changed-legacy loser retirement', async () => {
    const value = harness();
    const household = {
      kind: 'legacy' as const,
      generation: fence.generation + 1,
      base: fence.base + 1,
      head: 'f'.repeat(64),
    };
    value.setObservation(household);
    const authority = await value.executor.lookupWithFreshAuthority(ATTEMPT);
    await value.executor.retireLoser(evidence, household, authority.lookup);
    expect(value.provider.retireCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ protectedLibraryIds: [PROFILE] }),
    );
  });

  it('refuses retirement against unchanged legacy authority or a live candidate', async () => {
    const value = harness();
    await expect(
      value.executor.retireLoser(
        evidence,
        {
          kind: 'legacy',
          generation: fence.generation,
          base: fence.base,
          head: fence.head,
        },
        {
          state: 'open',
          attempt: ATTEMPT,
          purpose: 'split',
          wireMin: 4,
          fence,
          backup: boundBackup,
        },
      ),
    ).rejects.toThrow('unchanged legacy');
    vi.mocked(value.secure.inspectCommittedDirectory).mockResolvedValueOnce({
      winnerAttempt: '9'.repeat(32),
      ownerHead: OWNER,
      ownerLibraryId: LIBRARY,
      protectedLibraryIds: [PROFILE, LIBRARY],
    });
    await expect(
      value.executor.retireLoser(
        evidence,
        {
          kind: 'committed',
          generation: 8,
          base: 5,
          head: HEAD,
          directory: { kind: 'profiles' },
        },
        {
          state: 'superseded',
          attempt: ATTEMPT,
          purpose: 'split',
          wireMin: 4,
          fence,
          winner: {
            state: 'committed',
            attempt: '9'.repeat(32),
            generation: 8,
            base: 5,
            head: HEAD,
            wireMin: 5,
            backup: { id: 'winner', digest: BACKUP },
            stagedDigest: 'f'.repeat(64),
          },
        },
      ),
    ).rejects.toThrow('live profile');
    expect(value.provider.retireCandidate).not.toHaveBeenCalled();
  });
});
