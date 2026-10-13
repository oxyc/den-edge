import { describe, expect, it, vi } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { profileMigrationAuthorization, profileMigrationDigest } from './profileMigrationCore';
import {
  DormantOwnerSplitCoordinator,
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
  async clear(attempt: string): Promise<void> {
    if (this.journal?.attempt === attempt) this.journal = null;
    if (this.recovery?.attempt === attempt) this.recovery = null;
  }
}

function harness(
  options: {
    crashCommit?: boolean;
    superseded?: boolean;
    crashOpen?: boolean;
    changeSourceAfterObserve?: boolean;
  } = {},
) {
  const store = new MemoryJournalStore();
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
  };
  const provider: OwnerSplitProvider = {
    observeSource: vi.fn(async () => {
      const observed = currentSource;
      if (options.changeSourceAfterObserve)
        currentSource = { generation: observed.generation, head: '9'.repeat(64) };
      return observed;
    }),
    open: vi.fn(async (attempt, purpose, expectedSource) => {
      openCalls += 1;
      const opened = openedSources.get(attempt);
      if (opened) {
        if (expectedSource.generation !== opened.generation || expectedSource.head !== opened.head)
          throw new Error('migration_attempt_mismatch');
      } else {
        if (
          expectedSource.generation !== currentSource.generation ||
          expectedSource.head !== currentSource.head
        )
          throw new Error('migration_source_changed');
        openedSources.set(attempt, expectedSource);
      }
      if (options.crashOpen && openCalls === 1) throw new Error('simulated open response loss');
      return {
        state: 'open' as const,
        attempt,
        purpose,
        wireMin: purpose === 'restore' ? 5 : 4,
        fence,
      };
    }),
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
    coordinator: new DormantOwnerSplitCoordinator(effects, store, HOUSEHOLD),
    newCoordinator: () => new DormantOwnerSplitCoordinator(effects, store, HOUSEHOLD),
    setHousehold(value: OwnerSplitHouseholdObservation) {
      household = value;
    },
    setSource(value: typeof source) {
      currentSource = value;
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
    await expect(store.load()).resolves.toMatchObject({ state: 'fenced', source, fence });
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
