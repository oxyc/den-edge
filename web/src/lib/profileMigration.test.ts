import { describe, expect, it, vi } from 'vitest';
import type {
  HouseholdMigrationObservation,
  ProfileMigrationExecutor,
  ProfileMigrationDecision,
  ProfileMigrationJournal,
  ProfilesDirectory,
} from './profileMigration';
import { ProfileMigrationParticipant } from './profileMigration';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const OWNER = '00112233445566778899aabbccddeeff';
const KID = '11112222333344445555666677778888';
const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const HOUSEHOLD_KEY = key(1);
const CANDIDATE_KEY = key(2);
const WINNER_KEY = key(3);
const KID_KEY = key(4);
const CANDIDATE_ID = '11223344556677889900aabbccddeeff';
const SOURCE_HEAD = 'a'.repeat(64);
const OWNER_HEAD = 'c'.repeat(64);
const BACKUP_DIGEST = 'b'.repeat(64);
const PREPARED_DIGEST = 'd'.repeat(64);

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function directory(ownerKey = WINNER_KEY, kidKey = KID_KEY): ProfilesDirectory {
  return {
    format: 4,
    kind: 'profiles',
    schema: 1,
    owner: OWNER,
    migration: {
      version: 1,
      attempt: ATTEMPT,
      source: { generation: 7, head: SOURCE_HEAD },
      backup: { id: 'backup-a', digest: BACKUP_DIGEST },
      ownerProfile: OWNER,
      ownerHead: OWNER_HEAD,
    },
    profiles: {
      [OWNER]: {
        library: { value: { key: ownerKey } },
        deleted: { value: false },
      },
      [KID]: {
        library: { value: { key: kidKey } },
        deleted: { value: false },
      },
    },
  } as ProfilesDirectory;
}

const effects: Record<string, ProfileMigrationDecision> = {
  idle: 'acquire-fence',
  fenced: 'create-backup',
  'backed-up': 'create-owner-library',
  'owner-copied': 'verify-owner-library',
  'ready-to-commit': 'commit-fenced-household',
  'commit-unknown': 'read-household',
};

function fixture(
  options: {
    storage?: Storage;
    observe?: (journal: ProfileMigrationJournal) => Promise<HouseholdMigrationObservation>;
    planner?: (input: Record<string, unknown>) => ProfileMigrationDecision;
  } = {},
) {
  const calls: string[] = [];
  const executor: ProfileMigrationExecutor = {
    observe: vi.fn(
      options.observe ??
        (async (): Promise<HouseholdMigrationObservation> => ({
          kind: 'legacy',
          observedFence: { generation: 7, head: SOURCE_HEAD },
        })),
    ),
    acquireFence: vi.fn(async () => {
      calls.push('fence');
      return { generation: 7, head: SOURCE_HEAD, base: 7, rewrite: 'rewrite-a' };
    }),
    createAndVerifyBackup: vi.fn(async () => {
      calls.push('backup');
      return { id: 'backup-a', digest: BACKUP_DIGEST };
    }),
    createOwnerCandidate: vi.fn(async () => {
      calls.push('candidate');
      return { profileId: OWNER, libraryId: CANDIDATE_ID, libraryKey: CANDIDATE_KEY };
    }),
    copyOwnerPartition: vi.fn(async () => void calls.push('copy')),
    verifyOwnerLibrary: vi.fn(async () => {
      calls.push('verify-owner');
      return { head: OWNER_HEAD };
    }),
    prepareHouseholdRewrite: vi.fn(async () => {
      calls.push('prepare');
      return { digest: PREPARED_DIGEST };
    }),
    verifyWinner: vi.fn(async () => {
      calls.push('verify-winner');
      return true;
    }),
    adoptWinner: vi.fn(async () => void calls.push('adopt')),
    retireLosingCandidate: vi.fn(async () => {
      calls.push('retire');
      return 'retired' as const;
    }),
  };
  const planner =
    options.planner ??
    ((input: Record<string, unknown>) => {
      if (input.observed === 'committed') {
        if (
          input.candidateKey &&
          input.candidateKey !==
            (input.directory as ProfilesDirectory).profiles[
              (input.directory as ProfilesDirectory).owner
            ]?.library.value.key &&
          !input.candidateRetired
        )
          return 'retire-losing-candidate';
        if (!input.winnerVerified) return 'verify-winner';
        return 'activate';
      }
      const decision = effects[input.state as string];
      if (!decision) throw new Error('unexpected fixture state');
      return decision;
    });
  const participant = new ProfileMigrationParticipant({
    householdId: 'household-id',
    householdLibraryKey: HOUSEHOLD_KEY,
    storage: options.storage ?? memoryStorage(),
    executor,
    planner,
    validateDirectory: (value) => value,
    randomAttempt: () => ATTEMPT,
  });
  return { participant, executor, calls };
}

describe('ProfileMigrationParticipant', () => {
  it('blocks an otherwise executable version-1 journal instead of interpreting stale evidence', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 1,
        attempt: ATTEMPT,
        state: 'fenced',
        fence: { generation: 7, head: SOURCE_HEAD, base: 7, rewrite: 'rewrite-a' },
      }),
    });
    const { participant, executor } = fixture({ storage });

    await expect(participant.resume()).resolves.toEqual({
      kind: 'blocked',
      reason: 'invalid-journal',
    });
    expect(executor.observe).not.toHaveBeenCalled();
  });

  it('blocks a damaged durable journal instead of discarding possible cleanup evidence', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'cleaning-loser',
        candidate: { libraryKey: WINNER_KEY },
      }),
    });
    const { participant, executor } = fixture({ storage });

    await expect(participant.resume()).resolves.toEqual({
      kind: 'blocked',
      reason: 'invalid-journal',
    });
    expect(executor.observe).not.toHaveBeenCalled();
    expect(() => participant.beginExplicitOwnerAction(true)).toThrow('requires recovery');
  });

  it('never sends a non-canonical persisted candidate to the mandatory observation', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'owner-copied',
        fence: { generation: 7, head: SOURCE_HEAD, base: 7, rewrite: 'rewrite-a' },
        backup: { id: 'backup-a', digest: BACKUP_DIGEST },
        candidate: { profileId: OWNER, libraryId: 'not-an-id', libraryKey: 'arbitrary-key' },
      }),
    });
    const { participant, executor } = fixture({ storage });

    await expect(participant.resume()).resolves.toEqual({
      kind: 'blocked',
      reason: 'invalid-journal',
    });
    expect(executor.observe).not.toHaveBeenCalled();
  });

  it('blocks a prepared rewrite attached to an idle journal', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'idle',
        prepared: { digest: PREPARED_DIGEST },
      }),
    });
    const { participant, executor } = fixture({ storage });

    await expect(participant.resume()).resolves.toEqual({
      kind: 'blocked',
      reason: 'invalid-journal',
    });
    expect(executor.observe).not.toHaveBeenCalled();
  });

  it('blocks an active journal without proof for its winner key', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'active',
        winnerLibraryKey: WINNER_KEY,
      }),
    });
    const { participant, executor } = fixture({ storage });

    await expect(participant.resume()).resolves.toEqual({
      kind: 'blocked',
      reason: 'invalid-journal',
    });
    expect(executor.observe).not.toHaveBeenCalled();
    expect(participant.journal).toBeNull();
  });

  it('is inert until an explicit verified Owner action and stops before the commit', async () => {
    const { participant, calls } = fixture();
    await expect(participant.resume()).resolves.toEqual({ kind: 'inactive' });
    expect(calls).toEqual([]);

    participant.beginExplicitOwnerAction(true);
    for (let step = 0; step < 4; step++) await participant.resume();

    expect(calls).toEqual(['fence', 'backup', 'candidate', 'copy', 'verify-owner']);
    await expect(participant.resume()).resolves.toEqual({
      kind: 'ready-to-commit',
      prepared: { digest: PREPARED_DIGEST },
    });
    expect(calls).toEqual(['fence', 'backup', 'candidate', 'copy', 'verify-owner', 'prepare']);
    await participant.resume();
    expect(calls.at(-1)).toBe('prepare');
  });

  it('passes only the profiles-v1 planner evidence shape at each legacy step', async () => {
    const inputs: Record<string, unknown>[] = [];
    const { participant } = fixture({
      planner: (input) => {
        inputs.push(structuredClone(input));
        return input.state === 'idle' ? 'acquire-fence' : 'create-backup';
      },
    });
    participant.beginExplicitOwnerAction(true);

    await participant.resume();
    await participant.resume();

    expect(inputs).toEqual([
      { state: 'idle', observed: 'legacy', explicitIntent: true },
      {
        state: 'fenced',
        observed: 'legacy',
        fence: { generation: 7, head: SOURCE_HEAD },
        observedFence: { generation: 7, head: SOURCE_HEAD },
      },
    ]);
  });

  it('executes the real vendored den-core planner through a prepared legacy retry', async () => {
    const seeded = fixture();
    const participant = new ProfileMigrationParticipant({
      householdId: 'household-id',
      householdLibraryKey: HOUSEHOLD_KEY,
      storage: memoryStorage(),
      executor: seeded.executor,
      randomAttempt: () => ATTEMPT,
    });
    participant.beginExplicitOwnerAction(true);

    for (let step = 0; step < 5; step++) await participant.resume();
    await expect(participant.resume()).resolves.toEqual({
      kind: 'ready-to-commit',
      prepared: { digest: PREPARED_DIGEST },
    });
    await expect(participant.resume()).resolves.toEqual({
      kind: 'ready-to-commit',
      prepared: { digest: PREPARED_DIGEST },
    });
  });

  it('persists the candidate before its first write and retries that same candidate', async () => {
    const storage = memoryStorage();
    const first = fixture({ storage });
    first.participant.beginExplicitOwnerAction(true);
    await first.participant.resume();
    await first.participant.resume();
    vi.mocked(first.executor.copyOwnerPartition).mockRejectedValueOnce(new Error('process ended'));
    await expect(first.participant.resume()).rejects.toThrow('process ended');
    expect(first.participant.journal?.candidate?.libraryKey).toBe(CANDIDATE_KEY);
    expect(first.participant.journal?.state).toBe('backed-up');

    const recovered = fixture({ storage });
    await recovered.participant.resume();
    expect(recovered.calls).toEqual(['copy']);
    expect(recovered.participant.journal?.state).toBe('owner-copied');
  });

  it('observes a competing commit after prepared reload, cleans its loser, and adopts the winner', async () => {
    const storage = memoryStorage();
    const seeded = fixture({ storage });
    seeded.participant.beginExplicitOwnerAction(true);
    for (let step = 0; step < 5; step++) await seeded.participant.resume();
    expect(seeded.participant.journal).toMatchObject({
      state: 'commit-unknown',
      prepared: { digest: PREPARED_DIGEST },
    });

    const recovered = fixture({
      storage,
      observe: async () => ({ kind: 'committed', directory: directory() }),
      planner: (input) => {
        if (input.candidateKey && !input.candidateRetired) return 'retire-losing-candidate';
        if (!input.winnerVerified) return 'verify-winner';
        return 'activate';
      },
    });
    await recovered.participant.resume();
    expect(recovered.calls).toEqual(['retire']);
    expect(recovered.participant.journal).toMatchObject({
      state: 'adopting',
      candidateRetired: true,
      winnerLibraryKey: WINNER_KEY,
    });
    await recovered.participant.resume();
    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'active',
      ownerLibraryKey: WINNER_KEY,
    });
    expect(recovered.calls).toEqual(['retire', 'verify-winner', 'adopt']);
  });

  it('adopts its own committed candidate without retiring the winner', async () => {
    const storage = memoryStorage();
    const seeded = fixture({ storage });
    seeded.participant.beginExplicitOwnerAction(true);
    for (let step = 0; step < 5; step++) await seeded.participant.resume();

    const recovered = fixture({
      storage,
      observe: async () => ({
        kind: 'committed',
        directory: directory(CANDIDATE_KEY),
      }),
    });
    await recovered.participant.resume();
    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'active',
      ownerLibraryKey: CANDIDATE_KEY,
    });
    expect(recovered.calls).toEqual(['verify-winner', 'adopt']);
    expect(recovered.executor.retireLosingCandidate).not.toHaveBeenCalled();
  });

  it('re-verifies when the observed winner key changes after an earlier verification', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'adopting',
        winnerLibraryKey: key(5),
        winnerAttempt: ATTEMPT,
        winnerHead: 'd'.repeat(64),
        winnerVerified: true,
      }),
    });
    const recovered = fixture({
      storage,
      observe: async () => ({ kind: 'committed', directory: directory(WINNER_KEY) }),
    });

    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'progress',
      state: 'adopting',
    });
    expect(recovered.calls).toEqual(['verify-winner']);
    expect(recovered.participant.journal).toMatchObject({
      winnerLibraryKey: WINNER_KEY,
      winnerVerified: true,
    });
    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'active',
      ownerLibraryKey: WINNER_KEY,
    });
    expect(recovered.calls).toEqual(['verify-winner', 'adopt']);
  });

  it('persists commit uncertainty while retaining the prepared rewrite across reload', async () => {
    const storage = memoryStorage();
    const seeded = fixture({ storage });
    seeded.participant.beginExplicitOwnerAction(true);
    for (let step = 0; step < 5; step++) await seeded.participant.resume();
    expect(seeded.participant.journal).toMatchObject({
      state: 'commit-unknown',
      prepared: { digest: PREPARED_DIGEST },
      ownerVerification: { head: OWNER_HEAD },
    });

    const recovered = fixture({ storage });
    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'ready-to-commit',
      prepared: { digest: PREPARED_DIGEST },
    });
    expect(recovered.executor.observe).toHaveBeenCalledOnce();
    expect(recovered.calls).toEqual([]);
    expect(recovered.participant.journal?.state).toBe('commit-unknown');
  });

  it('retires a candidate after a changed legacy fence, then discards the completed attempt', async () => {
    const storage = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'owner-copied',
        fence: { generation: 7, head: SOURCE_HEAD, base: 7, rewrite: 'rewrite-a' },
        backup: { id: 'backup-a', digest: BACKUP_DIGEST },
        candidate: {
          profileId: OWNER,
          libraryId: CANDIDATE_ID,
          libraryKey: CANDIDATE_KEY,
        },
      }),
    });
    const recovered = fixture({
      storage,
      observe: async () => ({
        kind: 'legacy',
        observedFence: { generation: 8, head: 'b'.repeat(64) },
      }),
      planner: (input) =>
        input.candidateKey && !input.candidateRetired ? 'retire-losing-candidate' : 'restart',
    });

    await expect(recovered.participant.resume()).resolves.toEqual({
      kind: 'inactive',
    });
    expect(recovered.calls).toEqual(['retire']);
    expect(recovered.participant.journal).toBeNull();
  });

  it('retries deletion of a seeded active journal before returning active', async () => {
    const backing = memoryStorage({
      'den.profile.migration.v1:household-id': JSON.stringify({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'active',
        winnerLibraryKey: WINNER_KEY,
        winnerAttempt: ATTEMPT,
        winnerHead: OWNER_HEAD,
        winnerVerified: true,
      }),
    });
    let failRemoval = true;
    const storage: Storage = {
      get length() {
        return backing.length;
      },
      clear: () => backing.clear(),
      getItem: (key) => backing.getItem(key),
      key: (index) => backing.key(index),
      removeItem: (key) => {
        if (failRemoval) {
          failRemoval = false;
          throw new Error('remove failed');
        }
        backing.removeItem(key);
      },
      setItem: (key, value) => backing.setItem(key, value),
    };
    const first = fixture({ storage });
    await expect(first.participant.resume()).rejects.toThrow('remove failed');
    expect(first.participant.journal?.state).toBe('active');

    const relaunched = fixture({ storage });
    await expect(relaunched.participant.resume()).resolves.toEqual({
      kind: 'active',
      ownerLibraryKey: WINNER_KEY,
    });
    expect(relaunched.participant.journal).toBeNull();
    expect(relaunched.executor.observe).not.toHaveBeenCalled();
  });

  it('proves cleanup cannot target the Owner, another live profile, or the household', async () => {
    for (const protectedKey of [WINNER_KEY, KID_KEY, HOUSEHOLD_KEY]) {
      const storage = memoryStorage();
      const seeded = fixture({ storage });
      seeded.participant.beginExplicitOwnerAction(true);
      await seeded.participant.resume();
      await seeded.participant.resume();
      const journal = seeded.participant.journal!;
      storage.setItem(
        'den.profile.migration.v1:household-id',
        JSON.stringify({
          ...journal,
          candidate: { profileId: OWNER, libraryId: CANDIDATE_ID, libraryKey: protectedKey },
          state: 'owner-copied',
        }),
      );
      const recovered = fixture({
        storage,
        observe: async () => ({ kind: 'committed', directory: directory() }),
        planner: () => 'retire-losing-candidate',
      });
      await expect(recovered.participant.resume()).resolves.toEqual({
        kind: 'blocked',
        reason: 'cleanup-targets-live-library',
      });
      expect(recovered.executor.retireLosingCandidate).not.toHaveBeenCalled();
    }
  });
});
