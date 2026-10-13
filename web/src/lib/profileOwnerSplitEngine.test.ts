import { describe, expect, it, vi } from 'vitest';
import {
  DormantOwnerSplitEffectExecutor,
  OwnerSplitUnavailableError,
  type OwnerSplitAttemptLookup,
  type OwnerSplitCandidateHandle,
  type OwnerSplitDurableEvidence,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitProvider,
  type OwnerSplitSecureWorker,
} from './profileOwnerSplitEngine';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const PROFILE = '00112233445566778899aabbccddeeff';
const LIBRARY = '11112222333344445555666677778888';
const HEAD = 'a'.repeat(64);
const BACKUP = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
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
const evidence: OwnerSplitDurableEvidence = {
  attempt: ATTEMPT,
  fence,
  backup: { id: backup.id, digest: backup.digest },
  candidate,
  ownerHead: OWNER,
};

function harness() {
  let observation: OwnerSplitHouseholdObservation = {
    kind: 'legacy',
    generation: 8,
    base: 5,
    head: 'f'.repeat(64),
  };
  const opened: OwnerSplitAttemptLookup = { state: 'open', attempt: ATTEMPT, fence };
  const provider: OwnerSplitProvider = {
    open: vi.fn(async () => opened),
    lookup: vi.fn(async () => opened),
    abort: vi.fn(async () => ({ state: 'aborted' as const, attempt: ATTEMPT, fence })),
    createBackup: vi.fn(async () => ({ id: backup.id, digest: backup.digest })),
    readBackup: vi.fn(async () => backup),
    readHousehold: vi.fn(async () => observation),
    retireCandidate: vi.fn(async () => 'retired' as const),
    restore: vi.fn(async () => opened),
  };
  const secure: OwnerSplitSecureWorker = {
    allocateCandidate: vi.fn(async () => candidate),
    verifyBackup: vi.fn(async () => {}),
    copyAndAuthenticateOwner: vi.fn(async () => ({
      ownerHead: OWNER,
    })),
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
      lifecyclePlanner: 'unavailable',
      householdStage: 'unavailable',
      rawKeyPersistence: false,
    });
    expect('commitAuthorized' in executor).toBe(false);
    expect('stageHousehold' in executor).toBe(false);
    expect('restore' in executor).toBe(false);
    expect(() => executor.open(ATTEMPT, 'split')).toThrow(OwnerSplitUnavailableError);
  });

  it('creates, rereads and verifies a backup before returning it', async () => {
    const value = harness();
    expect(await value.executor.createVerifiedBackup(ATTEMPT, fence)).toEqual(backup);
    expect(value.provider.createBackup).toHaveBeenCalledOnce();
    expect(value.provider.readBackup).toHaveBeenCalledOnce();
    expect(value.secure.verifyBackup).toHaveBeenCalledWith({
      attempt: ATTEMPT,
      fence,
      created: { id: backup.id, digest: backup.digest },
      reread: backup,
    });
  });

  it('keeps the candidate key opaque while copying and reading back Owner', async () => {
    const value = harness();
    const result = await value.executor.copyAndAuthenticateCandidate({
      attempt: ATTEMPT,
      fence,
      backup,
    });
    expect(result).toEqual(evidence);
    expect(JSON.stringify(result)).not.toContain('libraryKey');
    expect(JSON.stringify(result)).not.toContain('candidateToken');
    expect(value.secure.copyAndAuthenticateOwner).toHaveBeenCalledOnce();
  });

  it('couples uncertain lookup and abort with a fresh household read', async () => {
    const value = harness();
    await value.executor.lookupWithFreshAuthority(ATTEMPT);
    expect(value.provider.lookup).toHaveBeenCalledOnce();
    expect(value.provider.readHousehold).toHaveBeenCalledOnce();
    vi.mocked(value.provider.lookup).mockResolvedValueOnce({
      state: 'aborted',
      attempt: ATTEMPT,
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
    expect(await value.executor.retireLoser(evidence, fresh)).toBe('retired');
    expect(value.secure.inspectCommittedDirectory).toHaveBeenCalledOnce();
    expect(value.provider.retireCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ protectedLibraryIds: [PROFILE, '2'.repeat(32)] }),
    );
    expect(value.secure.forgetCandidate).toHaveBeenCalledWith(candidate.keyRef);
  });

  it('refuses retirement against unchanged legacy authority or a live candidate', async () => {
    const value = harness();
    await expect(
      value.executor.retireLoser(evidence, {
        kind: 'legacy',
        generation: fence.generation,
        base: fence.base,
        head: fence.head,
      }),
    ).rejects.toThrow('unchanged legacy');
    vi.mocked(value.secure.inspectCommittedDirectory).mockResolvedValueOnce({
      winnerAttempt: '9'.repeat(32),
      ownerHead: OWNER,
      ownerLibraryId: LIBRARY,
      protectedLibraryIds: [PROFILE, LIBRARY],
    });
    await expect(
      value.executor.retireLoser(evidence, {
        kind: 'committed',
        generation: 8,
        base: 5,
        head: HEAD,
        directory: { kind: 'profiles' },
      }),
    ).rejects.toThrow('live profile');
    expect(value.provider.retireCandidate).not.toHaveBeenCalled();
  });
});
