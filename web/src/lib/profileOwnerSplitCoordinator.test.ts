import { describe, expect, it, vi } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { profileMigrationAuthorization, profileMigrationDigest } from './profileMigrationCore';
import {
  DormantOwnerSplitCoordinator,
  type OwnerSplitHandoffRecovery,
  type OwnerSplitJournal,
  type OwnerSplitJournalStore,
  type OwnerSplitRecoveryIntent,
} from './profileOwnerSplitCoordinator';
import { planOwnerSplitWithCore } from './profileOwnerSplitCoreWorker';
import {
  DormantOwnerSplitEffectExecutor,
  OwnerSplitRefusedError,
  type OwnerSplitAttemptLookup,
  type OwnerSplitHouseholdObservation,
  type OwnerSplitProvider,
  type OwnerSplitSecureWorker,
} from './profileOwnerSplitEngine';
import { HttpOwnerSplitProvider } from './profileOwnerSplitProvider';
import { OwnerSplitWorkerStore } from './profileOwnerSplitWorkerStore';
import {
  OwnerSplitWorkerTransport,
  type OwnerSplitWorkerNetwork,
} from './profileOwnerSplitWorkerTransport';

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
const source = { generation: 7, head: HEAD };
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
const preparedAuthorization = (attempt = ATTEMPT, observed = source) =>
  profileMigrationAuthorization({
    intent: {
      version: 1,
      action: 'enable-profiles',
      attempt,
      householdId: HOUSEHOLD,
      source: observed,
    },
    evidence: null,
  });

class MemoryJournalStore implements OwnerSplitJournalStore {
  journal: OwnerSplitJournal | null = null;
  recovery: OwnerSplitRecoveryIntent | null = null;
  handoff: OwnerSplitHandoffRecovery | null = null;

  async load(): Promise<OwnerSplitJournal | null> {
    return this.journal && structuredClone(this.journal);
  }
  async save(journal: OwnerSplitJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }
  async authorizeRecovery(intent: OwnerSplitRecoveryIntent): Promise<void> {
    this.recovery = structuredClone(intent);
  }
  async loadRecoveryIntent(attempt: string): Promise<OwnerSplitRecoveryIntent | null> {
    return this.recovery?.attempt === attempt ? structuredClone(this.recovery) : null;
  }
  async discardRecovery(attempt: string): Promise<void> {
    if (this.recovery?.attempt === attempt) this.recovery = null;
  }
  async loadHandoff(): Promise<OwnerSplitHandoffRecovery | null> {
    return this.handoff && structuredClone(this.handoff);
  }
  async saveHandoff(handoff: OwnerSplitHandoffRecovery): Promise<void> {
    this.handoff = structuredClone(handoff);
  }
  async clearHandoff(recoveryAttempt: string): Promise<void> {
    if (this.handoff?.recoveryAttempt === recoveryAttempt) this.handoff = null;
  }
  async clear(attempt: string): Promise<void> {
    if (this.journal?.attempt === attempt) this.journal = null;
    if (this.recovery?.attempt === attempt) this.recovery = null;
  }
}

const boundBackup = { attempt: ATTEMPT, id: backup.id, digest: backup.digest };
const refused = (status: number, code: string) => new OwnerSplitRefusedError(status, code);

function harness(
  options: {
    crashCommit?: boolean;
    superseded?: boolean;
    crashOpen?: boolean;
    changeSourceAfterObserve?: boolean;
    /** The refusal every open answers with, instead of opening. */
    openRefusal?: Error;
    /** The state a repeated open of an attempt den-edge already holds answers with. */
    openState?: 'aborted';
    /** The backup a restore open binds; a recovery handoff binds the split's backup. */
    restoreBackup?: typeof boundBackup;
    /** The manifest a restore attempt's backup route serves. */
    restoreManifest?: typeof backup;
  } = {},
) {
  const store = new MemoryJournalStore();
  /** What the durable handoff held at each open request. */
  const openSaw: (OwnerSplitHandoffRecovery | null)[] = [];
  let household: OwnerSplitHouseholdObservation = {
    kind: 'legacy',
    generation: 7,
    base: 4,
    head: HEAD,
  };
  let commitCalls = 0;
  let openCalls = 0;
  let aborted = false;
  let currentSource = source;
  const openedSources = new Map<string, typeof source>();
  const splitOpen: OwnerSplitAttemptLookup = {
    state: 'open',
    attempt: ATTEMPT,
    purpose: 'split',
    wireMin: 4,
    fence,
    backup: boundBackup,
  };
  const restoreBackup = options.restoreBackup ?? boundBackup;
  let recovery: 'open' | 'restored' | 'aborted' = 'open';
  const restoreOpen = (state: 'open' | 'aborted'): OwnerSplitAttemptLookup =>
    state === 'open'
      ? { state, attempt: RECOVERY, purpose: 'restore', wireMin: 5, fence, backup: restoreBackup }
      : { state, attempt: RECOVERY, purpose: 'restore', wireMin: 5, fence };
  const provider: OwnerSplitProvider = {
    observeSource: vi.fn(async () => {
      const observed = currentSource;
      if (options.changeSourceAfterObserve)
        currentSource = { generation: observed.generation, head: '9'.repeat(64) };
      return observed;
    }),
    open: vi.fn(async (attempt, purpose, expectedSource) => {
      openCalls += 1;
      openSaw.push(store.handoff && structuredClone(store.handoff));
      if (options.openRefusal) throw options.openRefusal;
      const opened = openedSources.get(attempt);
      if (opened) {
        if (expectedSource.generation !== opened.generation || expectedSource.head !== opened.head)
          throw refused(409, 'migration_attempt_mismatch');
        if (options.openState === 'aborted')
          return { ...splitOpen, state: 'aborted' as const, attempt };
      } else {
        if (
          expectedSource.generation !== currentSource.generation ||
          expectedSource.head !== currentSource.head
        )
          throw refused(409, 'migration_source_changed');
        openedSources.set(attempt, expectedSource);
      }
      if (options.crashOpen && openCalls === 1) throw new Error('simulated open response loss');
      return purpose === 'restore'
        ? { ...restoreOpen('open'), attempt }
        : { ...splitOpen, attempt, purpose };
    }),
    lookup: vi.fn(async (attempt: string) => {
      if (attempt === RECOVERY) {
        if (recovery === 'restored')
          return {
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
          };
        return restoreOpen(recovery);
      }
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
    readBackup: vi.fn(async (attempt: string) =>
      attempt === RECOVERY ? (options.restoreManifest ?? backup) : backup,
    ),
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
    restore: vi.fn(async () => {
      recovery = 'restored';
      return provider.lookup(RECOVERY);
    }),
  };
  const secure: OwnerSplitSecureWorker = {
    prepareAuthorization: vi.fn(async ({ attempt, source: observed }) =>
      preparedAuthorization(attempt, observed),
    ),
    allocateCandidate: vi.fn(async () => candidate),
    verifyBackup: vi.fn(async () => {}),
    copyAndAuthenticateOwner: vi.fn(async () => ({
      ownerHead: OWNER_HEAD,
      householdWrites: [WRITE],
    })),
    verifyOwnerLibrary: vi.fn(async () => {}),
    bindAuthorization: vi.fn(async ({ authorization, evidence, stagedDigest }) =>
      profileMigrationAuthorization({
        intent: authorization.intent,
        evidence: {
          attempt: evidence.attempt,
          householdId: evidence.householdId,
          fence: { generation: evidence.fence.generation, head: evidence.fence.head },
          backupDigest: evidence.backup.digest,
          candidateKey: OWNER_KEY,
          candidateHead: evidence.ownerHead,
          stagedDigest,
          wireMin: 5,
        },
      }),
    ),
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
    openSaw,
    coordinator: new DormantOwnerSplitCoordinator(effects, store, HOUSEHOLD),
    newCoordinator: () => new DormantOwnerSplitCoordinator(effects, store, HOUSEHOLD),
    setHousehold(value: OwnerSplitHouseholdObservation) {
      household = value;
    },
    setSource(value: typeof source) {
      currentSource = value;
    },
    /** The restore attempt reached a terminal on den-edge while this device's answer was lost. */
    setRecovery(value: typeof recovery) {
      recovery = value;
    },
  };
}

describe('dormant full Owner split coordinator', () => {
  it('composes source GET, durable binding and exact open before any household read', async () => {
    const values = new Map<string, unknown>();
    const bindings = new Map<string, string>();
    const store = new OwnerSplitWorkerStore({
      libraryId: HOUSEHOLD,
      keepRequired: async (name, value, binding = '') => {
        values.set(name, structuredClone(value));
        bindings.set(name, binding);
      },
      keptRequired: async <T>(name: string, binding = '') => {
        const value = values.get(name);
        if (value === undefined) return { kind: 'absent' as const };
        if (bindings.get(name) !== binding) throw new Error('corrupt test vault');
        return { kind: 'value' as const, value: structuredClone(value) as T };
      },
      discardKept: async (name) => {
        values.delete(name);
        bindings.delete(name);
      },
    });
    let openSawJournal: OwnerSplitJournal | null = null;
    const requests: Parameters<OwnerSplitWorkerNetwork['profileMigrationRequest']>[0][] = [];
    const readHousehold = vi.fn(async () => {
      throw new Error('stop after durable open');
    });
    const network: OwnerSplitWorkerNetwork = {
      libraryId: HOUSEHOLD,
      profileMigrationRequest: async (input) => {
        requests.push(structuredClone(input));
        if (input.path.endsWith('/profile-migration/source'))
          return { status: 200, body: { source } };
        if (input.path.endsWith('/profile-migration') && input.method === 'POST') {
          openSawJournal = await store.load();
          return {
            status: 200,
            body: {
              state: 'open',
              attempt: ATTEMPT,
              purpose: 'split',
              wireMin: 4,
              fence,
              backup: boundBackup,
            },
          };
        }
        throw new Error(`unexpected composition request ${input.method} ${input.path}`);
      },
      readProfileMigrationHousehold: readHousehold,
    };
    const transport = new OwnerSplitWorkerTransport(network, store);
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    const secure: OwnerSplitSecureWorker = {
      prepareAuthorization: vi.fn(async ({ attempt, source: observed }) =>
        preparedAuthorization(attempt, observed),
      ),
      allocateCandidate: vi.fn(),
      verifyBackup: vi.fn(),
      copyAndAuthenticateOwner: vi.fn(),
      verifyOwnerLibrary: vi.fn(),
      bindAuthorization: vi.fn(),
      planNext: vi.fn(async (evidence) =>
        planOwnerSplitWithCore(evidence, evidence.candidate ? OWNER_KEY : undefined),
      ),
      verifyCommittedWinner: vi.fn(),
      inspectCommittedDirectory: vi.fn(),
      verifyDirectoryWinner: vi.fn(),
      adoptWinner: vi.fn(),
      forgetCandidate: vi.fn(),
    };
    const coordinator = new DormantOwnerSplitCoordinator(
      new DormantOwnerSplitEffectExecutor({ provider, secureWorker: secure, enabled: true }),
      store,
      HOUSEHOLD,
    );

    const observed = await coordinator.observeSource();
    await expect(coordinator.prepare(ATTEMPT, observed)).rejects.toThrow('stop after durable open');
    expect(openSawJournal).toMatchObject({ version: 6, state: 'idle', attempt: ATTEMPT, source });
    expect(requests).toEqual([
      { method: 'GET', path: `/lib/${HOUSEHOLD}/profile-migration/source` },
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration`,
        body: { attempt: ATTEMPT, purpose: 'split', expectedSource: source },
      },
    ]);
    // Fence and the server-bound backup are recorded as one: the lock never exists without its backup.
    await expect(store.load()).resolves.toMatchObject({
      state: 'fenced',
      source,
      fence,
      backup: { id: backup.id, digest: backup.digest },
    });
    expect(readHousehold).toHaveBeenCalledOnce();
  });

  it('binds and commits the exact attempt without a second authorization action', async () => {
    const value = harness();
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).resolves.toEqual({
      kind: 'active',
      attempt: ATTEMPT,
    });
    expect(value.secure.bindAuthorization).toHaveBeenCalledOnce();
    expect(value.provider.commit).toHaveBeenCalledOnce();
    expect(value.secure.adoptWinner).toHaveBeenCalledOnce();
    expect(value.store.journal).toBeNull();
  });

  it('recovers commit-unknown after response loss without issuing another commit', async () => {
    const value = harness({ crashCommit: true });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).rejects.toThrow(
      'simulated response loss',
    );
    expect(value.store.journal?.state).toBe('commit-unknown');
    await expect(value.newCoordinator().resume()).resolves.toEqual({
      kind: 'active',
      attempt: ATTEMPT,
    });
    expect(value.provider.commit).toHaveBeenCalledOnce();
  });

  it('replays a response-lost open with only its durable source even after the live source changes', async () => {
    const value = harness({ crashOpen: true });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).rejects.toThrow(
      'simulated open response loss',
    );
    expect(value.store.journal).toMatchObject({ state: 'idle', source });
    value.setSource({ generation: 7, head: '9'.repeat(64) });

    await expect(value.newCoordinator().resume()).resolves.toMatchObject({ kind: 'active' });
    expect(value.provider.observeSource).toHaveBeenCalledOnce();
    expect(value.provider.open).toHaveBeenLastCalledWith(ATTEMPT, 'split', source);
  });

  it('does not replace a durably observed source when the source changes before open', async () => {
    const value = harness({ changeSourceAfterObserve: true });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).resolves.toEqual({
      kind: 'restart-required',
    });
    expect(value.store.journal).toBeNull();
    expect(value.provider.observeSource).toHaveBeenCalledOnce();
    expect(value.provider.open).toHaveBeenCalledOnce();
    expect(value.provider.open).toHaveBeenCalledWith(ATTEMPT, 'split', source);
    expect(value.provider.readHousehold).not.toHaveBeenCalled();
  });

  it('durably aborts a cancelled prepared attempt before any conditional cleanup', async () => {
    const value = harness();
    value.store.journal = {
      version: 6,
      attempt: ATTEMPT,
      explicitIntent: true,
      householdId: HOUSEHOLD,
      state: 'fenced',
      source,
      splitAuthorization: preparedAuthorization(),
      fence,
    };
    await expect(value.coordinator.cancel(ATTEMPT)).resolves.toEqual({ kind: 'cancelled' });
    expect(value.provider.abort).toHaveBeenCalledOnce();
    expect(value.provider.lookup).toHaveBeenCalled();
    expect(value.provider.readHousehold).toHaveBeenCalled();
    expect(value.provider.commit).not.toHaveBeenCalled();
    expect(value.store.journal).toBeNull();
  });

  it('verifies a racing winner, conditionally retires only the loser, then adopts', async () => {
    const value = harness({ superseded: true });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).resolves.toEqual({
      kind: 'active',
      attempt: ATTEMPT,
    });
    expect(value.secure.verifyDirectoryWinner).toHaveBeenCalled();
    expect(value.provider.retireCandidate).toHaveBeenCalledOnce();
    expect(value.secure.forgetCandidate).toHaveBeenCalledWith(candidate.keyRef);
    expect(value.secure.adoptWinner).toHaveBeenCalledOnce();
  });

  it('requires separately durable recovery intent before executing restore', async () => {
    const value = harness();
    value.store.journal = {
      version: 6,
      attempt: ATTEMPT,
      explicitIntent: true,
      householdId: HOUSEHOLD,
      state: 'restore-required',
      source,
      splitAuthorization: preparedAuthorization(),
      fence,
      backup: { id: backup.id, digest: backup.digest },
    };
    value.setHousehold({ kind: 'corrupt', generation: 8, base: 5, head: 'f'.repeat(64) });
    value.setSource({ generation: 8, head: 'f'.repeat(64) });
    await expect(value.coordinator.resume()).resolves.toEqual({
      kind: 'recovery-blocked',
      attempt: ATTEMPT,
    });
    expect(value.provider.restore).not.toHaveBeenCalled();
    await expect(
      value.coordinator.authorizeRecovery(ATTEMPT, RECOVERY, {
        generation: 8,
        head: 'f'.repeat(64),
      }),
    ).resolves.toEqual({
      kind: 'restored',
      attempt: ATTEMPT,
    });
    expect(value.provider.open).toHaveBeenLastCalledWith(RECOVERY, 'restore', {
      generation: 8,
      head: 'f'.repeat(64),
    });
    expect(value.provider.restore).toHaveBeenCalledOnce();
  });

  it('rejects malformed durable evidence before invoking provider or secure effects', async () => {
    const value = harness();
    value.store.journal = {
      version: 6,
      attempt: ATTEMPT,
      explicitIntent: true,
      householdId: HOUSEHOLD,
      state: 'owner-copied',
      source,
      splitAuthorization: preparedAuthorization(),
      fence,
      backup: { id: backup.id, digest: backup.digest },
      candidate: { ...candidate, keyFingerprint: 'not-a-digest' },
      ownerHead: OWNER_HEAD,
      householdWrites: [WRITE],
    };
    await expect(value.coordinator.resume()).rejects.toThrow('Invalid Owner split journal');
    expect(value.provider.lookup).not.toHaveBeenCalled();
    expect(value.provider.commit).not.toHaveBeenCalled();
  });
});

const idleJournal = (): OwnerSplitJournal => ({
  version: 6,
  attempt: ATTEMPT,
  explicitIntent: true,
  householdId: HOUSEHOLD,
  state: 'idle',
  source,
  splitAuthorization: preparedAuthorization(),
});
const fencedJournal = (): OwnerSplitJournal => ({
  ...idleJournal(),
  state: 'fenced',
  fence,
  backup: { id: backup.id, digest: backup.digest },
});
const restoreRequiredJournal = (): OwnerSplitJournal => ({
  ...fencedJournal(),
  state: 'restore-required',
});
const recoverySource = { generation: 8, head: 'f'.repeat(64) };
const corruptHousehold: OwnerSplitHouseholdObservation = {
  kind: 'corrupt',
  generation: 8,
  base: 5,
  head: 'f'.repeat(64),
};

describe('exclusive migration lock: the server-bound backup', () => {
  it('verifies the backup the open bound, reads it only, and asks den-core before trusting it', async () => {
    const value = harness();
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).resolves.toMatchObject({
      kind: 'active',
    });
    expect(value.provider.readBackup).toHaveBeenCalledWith(ATTEMPT, ATTEMPT);
    expect(value.secure.verifyBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: ATTEMPT,
        fence,
        created: { id: backup.id, digest: backup.digest },
      }),
    );
    // The provider port has no way to create a backup at all.
    expect(Object.keys(value.provider)).not.toContain('createBackup');
    // The planner answers `fenced` before the backup is treated as verified, and `backed-up` after.
    const asked = vi
      .mocked(value.secure.planNext)
      .mock.calls.map(([evidence]) => [evidence.state, evidence.backupVerified]);
    expect(asked).toContainEqual(['fenced', false]);
    expect(asked).toContainEqual(['backed-up', true]);
  });

  it('resumes a fenced journal by verifying its recorded backup, never by opening again', async () => {
    const value = harness();
    value.store.journal = fencedJournal();
    await expect(value.coordinator.resume()).resolves.toMatchObject({ kind: 'active' });
    expect(value.provider.open).not.toHaveBeenCalled();
    expect(value.provider.readBackup).toHaveBeenCalledWith(ATTEMPT, ATTEMPT);
  });

  it('stops before any Owner write when the bound backup fails verification', async () => {
    const value = harness();
    value.store.journal = fencedJournal();
    vi.mocked(value.secure.verifyBackup).mockRejectedValueOnce(
      new Error('Migration backup digest does not match'),
    );
    await expect(value.coordinator.resume()).rejects.toThrow('digest does not match');
    expect(value.secure.allocateCandidate).not.toHaveBeenCalled();
    expect(value.provider.stage).not.toHaveBeenCalled();
    expect(value.store.journal?.state).toBe('fenced');
  });

  it('refuses an open that binds a different attempt’s backup to a split', async () => {
    const value = harness();
    value.store.journal = idleJournal();
    vi.mocked(value.provider.open).mockResolvedValueOnce({
      state: 'open',
      attempt: ATTEMPT,
      purpose: 'split',
      wireMin: 4,
      fence,
      backup: { ...boundBackup, attempt: RECOVERY },
    });
    await expect(value.coordinator.resume()).rejects.toThrow('another attempt’s backup');
    expect(value.store.journal?.state).toBe('idle');
  });

  it('does not treat a stale candidate as cleanable without den-edge’s superseded answer', async () => {
    const plain = harness();
    await plain.coordinator.prepare(ATTEMPT, await plain.coordinator.observeSource());
    expect(
      vi.mocked(plain.secure.planNext).mock.calls.some(([e]) => e.legacyStaleCandidate === true),
    ).toBe(false);

    const stale = harness({ superseded: true });
    await stale.coordinator.prepare(ATTEMPT, await stale.coordinator.observeSource());
    const evidence = vi
      .mocked(stale.secure.planNext)
      .mock.calls.filter(([e]) => e.legacyStaleCandidate === true);
    expect(evidence.length).toBeGreaterThan(0);
    // Only with a candidate AND the durable `superseded` lookup behind it.
    expect(
      evidence.every(([e]) => e.candidate !== undefined && e.attemptLookup === 'superseded'),
    ).toBe(true);
  });
});

describe('exclusive migration lock: replay and refusal', () => {
  it('replays the same attempt after a lost open response and still binds the stored backup', async () => {
    const value = harness({ crashOpen: true });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).rejects.toThrow('response loss');
    await expect(value.newCoordinator().resume()).resolves.toMatchObject({ kind: 'active' });
    const opens = vi.mocked(value.provider.open).mock.calls;
    expect(opens).toHaveLength(2);
    expect(opens.every((call) => call[0] === ATTEMPT && call[1] === 'split')).toBe(true);
    expect(value.secure.verifyBackup).toHaveBeenCalledWith(
      expect.objectContaining({ created: { id: backup.id, digest: backup.digest } }),
    );
  });

  it('answers 409 migration_in_progress on a split open by stopping, with nothing to resume or retry', async () => {
    const value = harness({ openRefusal: refused(409, 'migration_in_progress') });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).resolves.toEqual({
      kind: 'setup-in-progress',
    });
    expect(value.provider.open).toHaveBeenCalledOnce();
    expect(value.store.journal).toBeNull();
    expect(value.provider.readBackup).not.toHaveBeenCalled();
    expect(value.provider.readHousehold).not.toHaveBeenCalled();
    expect(value.secure.allocateCandidate).not.toHaveBeenCalled();
    // A later explicit action may try again; nothing here does.
    await expect(value.coordinator.resume()).resolves.toEqual({ kind: 'inactive' });
    expect(value.provider.open).toHaveBeenCalledOnce();
  });

  it('does not swallow any other refusal of a split open', async () => {
    const value = harness({ openRefusal: refused(500, 'internal') });
    const observed = await value.coordinator.observeSource();
    await expect(value.coordinator.prepare(ATTEMPT, observed)).rejects.toThrow('refused 500');
    expect(value.store.journal?.state).toBe('idle');
  });

  it('drops a split another device’s Restore tombstoned, rather than resuming it', async () => {
    const value = harness({ openState: 'aborted' });
    await value.provider.open(ATTEMPT, 'split', source);
    value.store.journal = idleJournal();
    await expect(value.coordinator.resume()).resolves.toEqual({ kind: 'restart-required' });
    expect(value.store.journal).toBeNull();
    expect(value.provider.readBackup).not.toHaveBeenCalled();
  });

  it('keeps the split journal when a journal Restore meets 409 migration_in_progress', async () => {
    const value = harness({ openRefusal: refused(409, 'migration_in_progress') });
    value.store.journal = restoreRequiredJournal();
    value.setHousehold(corruptHousehold);
    await expect(
      value.coordinator.authorizeRecovery(ATTEMPT, RECOVERY, recoverySource),
    ).resolves.toEqual({ kind: 'setup-in-progress' });
    expect(value.provider.open).toHaveBeenCalledOnce();
    expect(value.provider.restore).not.toHaveBeenCalled();
    expect(value.store.journal?.state).toBe('restore-required');
    expect(value.store.recovery).toBeNull();
  });

  it('refuses a journal Restore whose handoff bound a different backup than the journal’s', async () => {
    const value = harness({
      restoreBackup: { ...boundBackup, digest: 'f'.repeat(64) },
    });
    value.store.journal = restoreRequiredJournal();
    value.setHousehold(corruptHousehold);
    value.setSource(recoverySource);
    await expect(
      value.coordinator.authorizeRecovery(ATTEMPT, RECOVERY, recoverySource),
    ).rejects.toThrow('different backup');
    expect(value.provider.restore).not.toHaveBeenCalled();
  });
});

describe('exclusive migration lock: journal-less Owner Restore', () => {
  it('records the attempt before the handoff, verifies the split’s backup, and restores only on den-core’s decision', async () => {
    const value = harness();
    value.setHousehold(corruptHousehold);
    value.setSource(recoverySource);
    await expect(
      value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource),
    ).resolves.toEqual({ kind: 'restored', attempt: RECOVERY });
    // Durable before the request, so a lost answer replays this attempt and never mints a second.
    expect(value.openSaw).toEqual([
      { version: 1, recoveryAttempt: RECOVERY, source: recoverySource },
    ]);
    expect(value.provider.open).toHaveBeenCalledWith(RECOVERY, 'restore', recoverySource);
    // The backup is read through the restore attempt's route; its manifest still names the split.
    expect(value.provider.readBackup).toHaveBeenCalledWith(RECOVERY, ATTEMPT);
    expect(value.secure.verifyBackup).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: ATTEMPT, fence }),
    );
    expect(value.provider.restore).toHaveBeenCalledOnce();
    const planned = vi.mocked(value.secure.planNext).mock.calls.map(([e]) => e);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      state: 'restore-required',
      recoveryIntent: true,
      backupVerified: true,
      commitAuthorized: false,
    });
    expect(planned[0]!.splitAuthorization).toBeUndefined();
    expect(value.store.handoff).toBeNull();
    expect(value.provider.abort).not.toHaveBeenCalled();
  });

  it('plans through the real den-core: a locked, untouched household gets no restore decision', async () => {
    const value = harness();
    value.setSource(recoverySource);
    await expect(value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource)).rejects.toThrow(
      'invalid_state',
    );
    expect(value.provider.restore).not.toHaveBeenCalled();
    // The authorized attempt, its bound backup and the lock all stay; nothing is lost or guessed.
    expect(value.store.handoff).toMatchObject({
      recoveryAttempt: RECOVERY,
      fence,
      backup: boundBackup,
    });
  });

  it('forgets the handoff on 409 migration_in_progress and learns nothing else', async () => {
    const value = harness({ openRefusal: refused(409, 'migration_in_progress') });
    await expect(
      value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource),
    ).resolves.toEqual({ kind: 'setup-in-progress' });
    expect(value.provider.open).toHaveBeenCalledOnce();
    expect(value.store.handoff).toBeNull();
    expect(value.provider.readBackup).not.toHaveBeenCalled();
    expect(value.provider.restore).not.toHaveBeenCalled();
  });

  it('forgets the handoff when the source changed before the handoff opened', async () => {
    // den-edge's source moved on between the Owner's observation and the handoff.
    const value = harness();
    await expect(
      value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource),
    ).resolves.toEqual({ kind: 'restart-required' });
    expect(value.store.handoff).toBeNull();
  });

  it('settles a restore whose response was lost from lookup, without restoring twice', async () => {
    const value = harness();
    value.store.handoff = {
      version: 1,
      recoveryAttempt: RECOVERY,
      source: recoverySource,
      fence,
      backup: boundBackup,
    };
    value.setRecovery('restored');
    await expect(value.coordinator.resume()).resolves.toEqual({
      kind: 'restored',
      attempt: RECOVERY,
    });
    expect(value.provider.open).not.toHaveBeenCalled();
    expect(value.provider.restore).not.toHaveBeenCalled();
    expect(value.store.handoff).toBeNull();
  });

  it('asks for a fresh authorization when its restore attempt was aborted', async () => {
    const value = harness();
    value.store.handoff = {
      version: 1,
      recoveryAttempt: RECOVERY,
      source: recoverySource,
      fence,
      backup: boundBackup,
    };
    value.setRecovery('aborted');
    await expect(value.coordinator.resume()).resolves.toEqual({ kind: 'restart-required' });
    expect(value.store.handoff).toBeNull();
    expect(value.provider.restore).not.toHaveBeenCalled();
  });

  it('resumes the attempt already durable instead of starting a second restore', async () => {
    const value = harness();
    value.setHousehold(corruptHousehold);
    value.setSource(recoverySource);
    value.store.handoff = { version: 1, recoveryAttempt: RECOVERY, source: recoverySource };
    const other = '5'.repeat(32);
    await expect(
      value.coordinator.recoverWithoutJournal(other, { generation: 8, head: '4'.repeat(64) }),
    ).resolves.toEqual({ kind: 'restored', attempt: RECOVERY });
    expect(vi.mocked(value.provider.open).mock.calls.map((call) => call[0])).toEqual([RECOVERY]);
  });

  it('is not an alternative to a split journal this device holds', async () => {
    const value = harness();
    value.store.journal = idleJournal();
    await expect(value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource)).rejects.toThrow(
      'recover through it',
    );
    expect(value.store.handoff).toBeNull();
    expect(value.provider.open).not.toHaveBeenCalled();
  });

  it('refuses a handed-off backup that does not describe the source it was handed off at', async () => {
    const value = harness({
      restoreManifest: { ...backup, source: { ...fence, head: 'e'.repeat(64) } },
    });
    value.setHousehold(corruptHousehold);
    value.setSource(recoverySource);
    await expect(value.coordinator.recoverWithoutJournal(RECOVERY, recoverySource)).rejects.toThrow(
      'does not describe the recovery attempt source',
    );
    expect(value.secure.verifyBackup).not.toHaveBeenCalled();
    expect(value.provider.restore).not.toHaveBeenCalled();
  });

  it('never starts a split while a journal-less Restore is durable', async () => {
    const value = harness();
    value.store.handoff = { version: 1, recoveryAttempt: RECOVERY, source: recoverySource };
    await expect(value.coordinator.prepare(ATTEMPT, source)).rejects.toThrow(
      'already has a durable',
    );
    expect(value.provider.open).not.toHaveBeenCalled();
  });
});
