import { describe, expect, it, vi } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { profileMigrationDigest } from './profileMigrationCore';
import {
  DormantOwnerSplitCoordinator,
  type OwnerSplitCommitAuthorization,
  type OwnerSplitJournal,
  type OwnerSplitJournalStore,
  type OwnerSplitRecoveryIntent,
} from './profileOwnerSplitCoordinator';
import { planOwnerSplitWithCore } from './profileOwnerSplitCoreWorker';
import {
  DormantOwnerSplitEffectExecutor,
  type OwnerSplitAttemptLookup,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitProvider,
  type OwnerSplitSecureWorker,
} from './profileOwnerSplitEngine';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const RECOVERY = 'fedcba9876543210fedcba9876543210';
const HOUSEHOLD = '00112233445566778899aabbccddeeff';
const CANDIDATE_LIBRARY = '11112222333344445555666677778888';
const OWNER_KEY = 'ERERERERERERERERERERERERERERERERERERERERERE=';
const HEAD = 'a'.repeat(64);
const OWNER_HEAD = 'c'.repeat(64);
const BACKUP_DIGEST = 'b'.repeat(64);
const WRITE = { k: 'd'.repeat(64), v: 'sealed-household' };
const STAGED = profileMigrationDigest('staged', { rows: [WRITE] });
const fence = { generation: 7, base: 4, head: HEAD, rewrite: 'rewrite-7' };
const backup = {
  id: 'backup-7',
  digest: BACKUP_DIGEST,
  source: fence,
  householdId: HOUSEHOLD,
  attempt: ATTEMPT,
  wireMin: 4,
  authorization: { tokenHash: HEAD, memberHash: null },
  rows: [],
};
const candidate = {
  profileId: HOUSEHOLD,
  libraryId: CANDIDATE_LIBRARY,
  keyRef: 'secure-owner-key',
  keyFingerprint: 'e'.repeat(64),
};

class MemoryJournalStore implements OwnerSplitJournalStore {
  journal: OwnerSplitJournal | null = null;
  authorization: OwnerSplitCommitAuthorization | null = null;
  recovery: OwnerSplitRecoveryIntent | null = null;

  async load(): Promise<OwnerSplitJournal | null> {
    return this.journal && structuredClone(this.journal);
  }
  async save(journal: OwnerSplitJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }
  async authorizeCommit(
    journal: OwnerSplitJournal & { readonly state: 'ready-to-commit' },
    authorization: OwnerSplitCommitAuthorization,
  ): Promise<void> {
    this.authorization = structuredClone(authorization);
    this.journal = structuredClone(journal);
  }
  async loadCommitAuthorization(attempt: string): Promise<OwnerSplitCommitAuthorization | null> {
    return this.authorization?.attempt === attempt ? structuredClone(this.authorization) : null;
  }
  async authorizeRecovery(intent: OwnerSplitRecoveryIntent): Promise<void> {
    this.recovery = structuredClone(intent);
  }
  async loadRecoveryIntent(attempt: string): Promise<OwnerSplitRecoveryIntent | null> {
    return this.recovery?.attempt === attempt ? structuredClone(this.recovery) : null;
  }
  async clear(attempt: string): Promise<void> {
    if (this.journal?.attempt === attempt) this.journal = null;
    if (this.authorization?.attempt === attempt) this.authorization = null;
    if (this.recovery?.attempt === attempt) this.recovery = null;
  }
}

function harness(options: { crashCommit?: boolean; superseded?: boolean } = {}) {
  const store = new MemoryJournalStore();
  let household: OwnerSplitHouseholdObservation = {
    kind: 'legacy',
    generation: 7,
    base: 4,
    head: HEAD,
  };
  let commitCalls = 0;
  let aborted = false;
  const splitOpen: OwnerSplitAttemptLookup = {
    state: 'open',
    attempt: ATTEMPT,
    purpose: 'split',
    wireMin: 4,
    fence,
  };
  const provider: OwnerSplitProvider = {
    open: vi.fn(async (attempt, purpose) => ({
      state: 'open' as const,
      attempt,
      purpose,
      wireMin: purpose === 'restore' ? 5 : 4,
      fence,
    })),
    lookup: vi.fn(async () => {
      if (aborted) return { ...splitOpen, state: 'aborted' as const };
      if (household.kind !== 'committed') return splitOpen;
      if (options.superseded)
        return {
          ...splitOpen,
          state: 'superseded' as const,
          winner: {
            attempt: '9'.repeat(32),
            state: 'committed' as const,
            generation: 8,
            base: 5,
            head: 'f'.repeat(64),
            wireMin: 5,
            backup: { id: 'winner-backup', digest: '8'.repeat(64) },
            stagedDigest: '7'.repeat(64),
          },
        };
      return {
        ...splitOpen,
        state: 'committed' as const,
        purpose: 'split' as const,
        generation: 8,
        base: 5,
        head: 'f'.repeat(64),
        wireMin: 5,
        backup: { id: backup.id, digest: backup.digest },
        stagedDigest: STAGED,
      };
    }),
    abort: vi.fn(async () => {
      aborted = true;
      return { ...splitOpen, state: 'aborted' as const };
    }),
    createBackup: vi.fn(async () => ({ id: backup.id, digest: backup.digest })),
    readBackup: vi.fn(async () => backup),
    stage: vi.fn(async () => STAGED),
    commit: vi.fn(async () => {
      commitCalls += 1;
      const directory = structuredClone(fixture.migrationBase) as Record<string, unknown>;
      if (options.superseded) {
        (directory.migration as Record<string, unknown>).attempt = '9'.repeat(32);
        const profiles = directory.profiles as Record<string, Record<string, unknown>>;
        const owner = profiles[HOUSEHOLD]!;
        const library = owner.library as { value: { key: string } };
        library.value.key = 'REREREREREREREREREREREREREREREREREREREREREQ=';
      }
      household = {
        kind: 'committed',
        generation: 8,
        base: 5,
        head: 'f'.repeat(64),
        directory,
      };
      if (options.crashCommit && commitCalls === 1) throw new Error('simulated response loss');
      return provider.lookup(ATTEMPT);
    }),
    readHousehold: vi.fn(async () => household),
    retireCandidate: vi.fn(async () => 'retired' as const),
    restore: vi.fn(async () => ({
      state: 'restored' as const,
      attempt: RECOVERY,
      purpose: 'restore' as const,
      wireMin: 5,
      fence,
      generation: 9,
      base: 4,
      head: '6'.repeat(64),
      backup: { id: backup.id, digest: backup.digest },
      stagedDigest: null,
    })),
  };
  const secure: OwnerSplitSecureWorker = {
    allocateCandidate: vi.fn(async () => candidate),
    verifyBackup: vi.fn(async () => {}),
    copyAndAuthenticateOwner: vi.fn(async () => ({
      ownerHead: OWNER_HEAD,
      householdWrites: [WRITE],
    })),
    verifyOwnerLibrary: vi.fn(async () => {}),
    planNext: vi.fn(async (evidence) =>
      planOwnerSplitWithCore(evidence, evidence.candidate ? OWNER_KEY : undefined),
    ),
    verifyCommittedWinner: vi.fn(async () => ({
      ownerLibraryId: CANDIDATE_LIBRARY,
      protectedLibraryIds: [HOUSEHOLD, CANDIDATE_LIBRARY],
    })),
    inspectCommittedDirectory: vi.fn(async () => ({
      winnerAttempt: options.superseded ? '9'.repeat(32) : ATTEMPT,
      ownerHead: OWNER_HEAD,
      ownerLibraryId: options.superseded ? '2'.repeat(32) : CANDIDATE_LIBRARY,
      protectedLibraryIds: [HOUSEHOLD, options.superseded ? '2'.repeat(32) : CANDIDATE_LIBRARY],
    })),
    verifyDirectoryWinner: vi.fn(async () => ({
      winnerAttempt: options.superseded ? '9'.repeat(32) : ATTEMPT,
      ownerHead: OWNER_HEAD,
      ownerLibraryId: options.superseded ? '2'.repeat(32) : CANDIDATE_LIBRARY,
      protectedLibraryIds: [HOUSEHOLD, options.superseded ? '2'.repeat(32) : CANDIDATE_LIBRARY],
    })),
    adoptWinner: vi.fn(async () => {}),
    forgetCandidate: vi.fn(async () => {}),
  };
  const effects = new DormantOwnerSplitEffectExecutor({
    provider,
    secureWorker: secure,
    enabled: true,
  });
  return {
    store,
    provider,
    secure,
    coordinator: new DormantOwnerSplitCoordinator(effects, store),
    newCoordinator: () => new DormantOwnerSplitCoordinator(effects, store),
    setHousehold(value: OwnerSplitHouseholdObservation) {
      household = value;
    },
  };
}

describe('dormant full Owner split coordinator', () => {
  it('prepares only, survives reload without committing, then commits only after durable authorization', async () => {
    const value = harness();
    await expect(value.coordinator.prepare(ATTEMPT)).resolves.toEqual({
      kind: 'awaiting-confirmation',
      attempt: ATTEMPT,
      ownerHead: OWNER_HEAD,
    });
    expect(value.provider.commit).not.toHaveBeenCalled();
    await expect(value.newCoordinator().resume()).resolves.toMatchObject({
      kind: 'awaiting-confirmation',
    });
    expect(value.provider.commit).not.toHaveBeenCalled();

    await value.coordinator.authorizeCommit(ATTEMPT);
    expect(value.store.authorization).toMatchObject({
      attempt: ATTEMPT,
      ownerHead: OWNER_HEAD,
      stagedDigest: STAGED,
      commitAuthorized: true,
    });
    await expect(value.newCoordinator().resume()).resolves.toEqual({
      kind: 'active',
      attempt: ATTEMPT,
    });
    expect(value.provider.commit).toHaveBeenCalledOnce();
    expect(value.secure.adoptWinner).toHaveBeenCalledOnce();
    expect(value.store.journal).toBeNull();
  });

  it('recovers commit-unknown after response loss without issuing another commit', async () => {
    const value = harness({ crashCommit: true });
    await value.coordinator.prepare(ATTEMPT);
    await value.coordinator.authorizeCommit(ATTEMPT);
    await expect(value.coordinator.resume()).rejects.toThrow('simulated response loss');
    expect(value.store.journal?.state).toBe('commit-unknown');
    await expect(value.newCoordinator().resume()).resolves.toEqual({
      kind: 'active',
      attempt: ATTEMPT,
    });
    expect(value.provider.commit).toHaveBeenCalledOnce();
  });

  it('durably aborts a cancelled prepared attempt before any conditional cleanup', async () => {
    const value = harness();
    await value.coordinator.prepare(ATTEMPT);
    await expect(value.coordinator.cancel(ATTEMPT)).resolves.toEqual({ kind: 'cancelled' });
    expect(value.provider.abort).toHaveBeenCalledOnce();
    expect(value.provider.lookup).toHaveBeenCalled();
    expect(value.provider.readHousehold).toHaveBeenCalled();
    expect(value.provider.commit).not.toHaveBeenCalled();
    expect(value.store.journal).toBeNull();
  });

  it('verifies a racing winner, conditionally retires only the loser, then adopts', async () => {
    const value = harness({ superseded: true });
    await value.coordinator.prepare(ATTEMPT);
    await value.coordinator.authorizeCommit(ATTEMPT);
    await expect(value.coordinator.resume()).resolves.toEqual({ kind: 'active', attempt: ATTEMPT });
    expect(value.secure.verifyDirectoryWinner).toHaveBeenCalled();
    expect(value.provider.retireCandidate).toHaveBeenCalledOnce();
    expect(value.secure.forgetCandidate).toHaveBeenCalledWith(candidate.keyRef);
    expect(value.secure.adoptWinner).toHaveBeenCalledOnce();
  });

  it('requires separately durable recovery intent before executing restore', async () => {
    const value = harness();
    value.store.journal = {
      version: 4,
      attempt: ATTEMPT,
      explicitIntent: true,
      state: 'restore-required',
      fence,
      backup: { id: backup.id, digest: backup.digest },
    };
    value.setHousehold({ kind: 'corrupt', generation: 8, base: 5, head: 'f'.repeat(64) });
    await expect(value.coordinator.resume()).resolves.toEqual({
      kind: 'recovery-blocked',
      attempt: ATTEMPT,
    });
    expect(value.provider.restore).not.toHaveBeenCalled();
    await expect(value.coordinator.authorizeRecovery(ATTEMPT, RECOVERY)).resolves.toEqual({
      kind: 'restored',
      attempt: ATTEMPT,
    });
    expect(value.provider.open).toHaveBeenLastCalledWith(RECOVERY, 'restore');
    expect(value.provider.restore).toHaveBeenCalledOnce();
  });

  it('rejects malformed durable evidence before invoking provider or secure effects', async () => {
    const value = harness();
    value.store.journal = {
      version: 4,
      attempt: ATTEMPT,
      explicitIntent: true,
      state: 'owner-copied',
      fence,
      backup: { id: backup.id, digest: backup.digest },
      householdId: HOUSEHOLD,
      candidate: { ...candidate, keyFingerprint: 'not-a-digest' },
      ownerHead: OWNER_HEAD,
      householdWrites: [WRITE],
    };
    await expect(value.coordinator.resume()).rejects.toThrow('Invalid Owner split journal');
    expect(value.provider.lookup).not.toHaveBeenCalled();
    expect(value.provider.commit).not.toHaveBeenCalled();
  });
});
