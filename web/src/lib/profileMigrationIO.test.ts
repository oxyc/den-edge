import { describe, expect, it, vi } from 'vitest';
import type {
  HouseholdMigrationObservation,
  OwnerMigrationCandidate,
  ProfileMigrationFence,
  ProfilesDirectory,
} from './profileMigration';
import {
  DormantOwnerSplitExecutor,
  OWNER_SPLIT_COPY_DOMAINS,
  OwnerSplitDisabledError,
  type ConditionalRetirementEvidence,
  type OwnerPreferencePartition,
  type OwnerSplitStorage,
} from './profileMigrationIO';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const OWNER = '00112233445566778899aabbccddeeff';
const HOUSEHOLD_ID = 'ffeeddccbbaa00998877665544332211';
const CANDIDATE_ID = '11223344556677889900aabbccddeeff';
const KID_ID = '11111111111111111111111111111111';
const HOUSEHOLD_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const CANDIDATE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const KID_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const DIGEST = 'a'.repeat(64);
const HEAD = 'b'.repeat(64);
const SOURCE_HEAD = 'c'.repeat(64);
const fence: ProfileMigrationFence = {
  generation: 7,
  head: SOURCE_HEAD,
  base: 41,
  rewrite: 'rewrite-a',
};
const backup = { id: 'backup-a', digest: DIGEST };
const preferenceValues = {
  'den.watchRegion': { v: 'FI' },
  'den.preferredAudioLanguage': { v: 'fi' },
  'den.maturityCeiling': { v: 'pg13' },
  future: { v: true },
};
const partition: OwnerPreferencePartition = {
  household: { 'den.watchRegion': { v: 'FI' }, future: { v: true } },
  owner: { 'den.preferredAudioLanguage': { v: 'fi' } },
  ownerMaturity: { v: 'pg13' },
};
const candidate: OwnerMigrationCandidate = {
  profileId: OWNER,
  libraryId: CANDIDATE_ID,
  libraryKey: CANDIDATE_KEY,
};
const context = {
  attempt: ATTEMPT,
  household: { libraryId: HOUSEHOLD_ID, libraryKey: HOUSEHOLD_KEY },
};

function directory(ownerKey = CANDIDATE_KEY): ProfilesDirectory {
  return {
    format: 4,
    kind: 'profiles',
    schema: 1,
    owner: OWNER,
    migration: {
      version: 1,
      attempt: ATTEMPT,
      source: { generation: 7, head: HEAD },
      backup: { id: 'backup-a', digest: DIGEST },
      ownerProfile: OWNER,
      ownerHead: HEAD,
    },
    profiles: {
      [OWNER]: { library: { value: { key: ownerKey } }, deleted: { value: false } },
      [KID_ID]: { library: { value: { key: KID_KEY } }, deleted: { value: false } },
    },
  };
}

function safeRetirement(
  result: ConditionalRetirementEvidence['result'] = 'retired',
): ConditionalRetirementEvidence {
  return {
    context,
    source: fence,
    result,
    candidate: { libraryId: CANDIDATE_ID, libraryKey: CANDIDATE_KEY },
    authority: { generation: 8, head: 'd'.repeat(64), kind: 'committed' },
    directoryValidated: true,
    protectedLibraryIds: [HOUSEHOLD_ID, KID_ID],
    protectedLibraryKeys: [HOUSEHOLD_KEY, KID_KEY],
  };
}

function fixture(options: { enabled?: boolean } = {}) {
  const calls: string[] = [];
  const partitionPreferences = vi.fn(() => partition);
  const validateDirectory = vi.fn((document: unknown) => document as ProfilesDirectory);
  let retirement = safeRetirement();
  const storage: OwnerSplitStorage = {
    observe: vi.fn(async (): Promise<HouseholdMigrationObservation> => ({
      kind: 'legacy',
      observedFence: { generation: 7, head: SOURCE_HEAD },
    })),
    acquireFence: vi.fn(async () => fence),
    createBackup: vi.fn(async () => {
      calls.push('backup');
      return backup;
    }),
    verifyBackup: vi.fn(async ({ context: sourceContext, fence: source, backup: value }) => ({
      ...value,
      context: sourceContext,
      readable: true as const,
      source,
      preferenceValues,
    })),
    allocateOwner: vi.fn(async () => {
      calls.push('candidate');
      return candidate;
    }),
    copyOwner: vi.fn(async ({ plan }) => {
      calls.push('copy');
      expect(plan).toEqual({ domains: OWNER_SPLIT_COPY_DOMAINS, preferences: partition });
    }),
    authenticateOwner: vi.fn(
      async ({
        context: sourceContext,
        fence: source,
        backup: sourceBackup,
        candidate: owner,
        plan,
      }) => {
        calls.push('verify');
        return {
          head: HEAD,
          authenticated: true as const,
          partitionComplete: true as const,
          context: sourceContext,
          source,
          backup: { id: sourceBackup.id, digest: sourceBackup.digest },
          candidate: owner,
          plan,
        };
      },
    ),
    prepareHousehold: vi.fn(async ({ context: sourceContext, fence: source, owner }) => {
      calls.push('prepare');
      return {
        digest: DIGEST,
        householdId: sourceContext.household.libraryId,
        householdLibraryKey: sourceContext.household.libraryKey,
        source,
        ownerHead: owner.head,
        projection: 'configuration-and-directory-only' as const,
        wireMinimum: 5 as const,
      };
    }),
    verifyWinner: vi.fn(async () => true),
    conditionallyRetireUnreferenced: vi.fn(async ({ validateDirectory: validate }) => {
      calls.push('conditional-retire');
      validate(directory());
      return retirement;
    }),
  };
  const makeExecutor = () =>
    new DormantOwnerSplitExecutor(storage, {
      householdId: HOUSEHOLD_ID,
      householdLibraryKey: HOUSEHOLD_KEY,
      partitionPreferences,
      validateDirectory,
      enabled: options.enabled,
    });
  return {
    calls,
    storage,
    partitionPreferences,
    validateDirectory,
    executor: makeExecutor(),
    makeExecutor,
    setRetirement(value: ConditionalRetirementEvidence) {
      retirement = value;
    },
  };
}

describe('DormantOwnerSplitExecutor', () => {
  it('defaults off and its dry run performs no storage or den-core work', async () => {
    const { executor, storage, partitionPreferences } = fixture();
    expect(executor.dryRun()).toEqual({
      enabled: false,
      copyDomains: OWNER_SPLIT_COPY_DOMAINS,
      canCommit: false,
      canActivate: false,
    });
    await expect(executor.acquireFence(ATTEMPT)).rejects.toBeInstanceOf(OwnerSplitDisabledError);
    expect(storage.acquireFence).not.toHaveBeenCalled();
    expect(partitionPreferences).not.toHaveBeenCalled();
  });

  it('requires canonical household identity even while dormant', () => {
    const { storage, partitionPreferences, validateDirectory } = fixture();
    expect(
      () =>
        new DormantOwnerSplitExecutor(storage, {
          householdId: 'not-an-id',
          householdLibraryKey: HOUSEHOLD_KEY,
          partitionPreferences,
          validateDirectory,
        }),
    ).toThrow('Household identity is not canonical');
  });

  it('binds a readable backup to attempt and every authenticated source-fence field', async () => {
    const { executor, storage } = fixture({ enabled: true });
    vi.mocked(storage.verifyBackup).mockResolvedValueOnce({
      ...backup,
      context: { ...context, attempt: 'f'.repeat(32) },
      readable: true,
      source: fence,
      preferenceValues,
    });
    await expect(executor.createAndVerifyBackup(ATTEMPT, fence)).rejects.toThrow(
      'not verified at the migration fence',
    );

    vi.mocked(storage.verifyBackup).mockResolvedValueOnce({
      ...backup,
      context,
      readable: true,
      source: { ...fence, head: 'e'.repeat(64) },
      preferenceValues,
    });
    await expect(executor.createAndVerifyBackup(ATTEMPT, fence)).rejects.toThrow(
      'not verified at the migration fence',
    );
    expect(storage.copyOwner).not.toHaveBeenCalled();
  });

  it('rejects malformed or incomplete fences before backup I/O', async () => {
    const { executor, storage } = fixture({ enabled: true });
    await expect(
      executor.createAndVerifyBackup(ATTEMPT, { ...fence, generation: -1 }),
    ).rejects.toThrow('fence is invalid');
    await expect(executor.createAndVerifyBackup(ATTEMPT, { ...fence, head: '' })).rejects.toThrow(
      'fence is invalid',
    );
    await expect(
      executor.createAndVerifyBackup(ATTEMPT, { ...fence, rewrite: ' ' }),
    ).rejects.toThrow('fence is invalid');
    expect(storage.createBackup).not.toHaveBeenCalled();
  });

  it('uses den-core preference output and every exact activity/tracker/delivery domain', async () => {
    const { executor, partitionPreferences, storage } = fixture({ enabled: true });
    const verified = await executor.createAndVerifyBackup(ATTEMPT, fence);
    await executor.copyOwnerPartition(ATTEMPT, fence, verified, candidate);

    expect(partitionPreferences).toHaveBeenCalledWith(preferenceValues);
    expect(vi.mocked(storage.copyOwner).mock.calls[0]![0].plan.domains).toEqual([
      'title-and-season-documents',
      'personal-preferences',
      'tracker-credentials',
      'tracker-commands',
      'tracker-receipts',
      'tracker-pending-work',
      'tracker-held-work',
      'tracker-epochs',
      'tracker-delivery-settings',
      'tracker-delivery-documents',
    ]);
  });

  it('revalidates candidate id and key at every resumed consumer', async () => {
    const { executor, storage } = fixture({ enabled: true });
    const aliasesHouseholdId = { ...candidate, libraryId: HOUSEHOLD_ID };
    await expect(
      executor.copyOwnerPartition(ATTEMPT, fence, backup, aliasesHouseholdId),
    ).rejects.toThrow('candidate is invalid');
    await expect(
      executor.verifyOwnerLibrary(ATTEMPT, fence, backup, {
        ...candidate,
        libraryKey: HOUSEHOLD_KEY,
      }),
    ).rejects.toThrow('candidate is invalid');
    await expect(
      executor.retireLosingCandidate(ATTEMPT, fence, aliasesHouseholdId),
    ).rejects.toThrow('candidate is invalid');
    await expect(
      executor.prepareHouseholdRewrite({
        attempt: ATTEMPT,
        fence,
        backup,
        candidate: aliasesHouseholdId,
        ownerVerification: { head: HEAD },
      }),
    ).rejects.toThrow('candidate is invalid');
    expect(storage.copyOwner).not.toHaveBeenCalled();
    expect(storage.authenticateOwner).not.toHaveBeenCalled();
    expect(storage.conditionallyRetireUnreferenced).not.toHaveBeenCalled();
  });

  it('rejects a persisted candidate before the mandatory household observation', async () => {
    const { executor, storage } = fixture({ enabled: true });
    await expect(
      executor.observe({
        version: 2,
        attempt: ATTEMPT,
        explicitIntent: true,
        state: 'owner-copied',
        fence,
        backup,
        candidate: { ...candidate, libraryKey: HOUSEHOLD_KEY },
      }),
    ).rejects.toThrow('candidate is invalid');
    expect(storage.observe).not.toHaveBeenCalled();
  });

  it('binds every storage operation to the same canonical attempt and household context', async () => {
    const { executor, storage } = fixture({ enabled: true });
    await executor.observe({ version: 2, attempt: ATTEMPT, explicitIntent: true, state: 'idle' });
    await executor.acquireFence(ATTEMPT);
    const verified = await executor.createAndVerifyBackup(ATTEMPT, fence);
    await executor.createOwnerCandidate(ATTEMPT);
    await executor.copyOwnerPartition(ATTEMPT, fence, verified, candidate);
    const ownerVerification = await executor.verifyOwnerLibrary(
      ATTEMPT,
      fence,
      verified,
      candidate,
    );
    await executor.prepareHouseholdRewrite({
      attempt: ATTEMPT,
      fence,
      backup: verified,
      candidate,
      ownerVerification,
    });
    await executor.verifyWinner(directory(), CANDIDATE_KEY);
    await executor.retireLosingCandidate(ATTEMPT, fence, candidate);

    expect(vi.mocked(storage.observe).mock.calls[0]![0].context).toEqual(context);
    expect(vi.mocked(storage.acquireFence).mock.calls[0]![0]).toEqual(context);
    expect(vi.mocked(storage.createBackup).mock.calls[0]![0].context).toEqual(context);
    expect(
      vi
        .mocked(storage.verifyBackup)
        .mock.calls.every(([input]) => JSON.stringify(input.context) === JSON.stringify(context)),
    ).toBe(true);
    expect(vi.mocked(storage.copyOwner).mock.calls[0]![0].context).toEqual(context);
    expect(
      vi
        .mocked(storage.authenticateOwner)
        .mock.calls.every(([input]) => JSON.stringify(input.context) === JSON.stringify(context)),
    ).toBe(true);
    expect(vi.mocked(storage.prepareHousehold).mock.calls[0]![0].context).toEqual(context);
    expect(vi.mocked(storage.verifyWinner).mock.calls[0]![0].context).toEqual(context);
    expect(vi.mocked(storage.conditionallyRetireUnreferenced).mock.calls[0]![0]).toMatchObject({
      context,
      source: fence,
    });
  });

  it('re-authenticates complete copy evidence after restart before preparing the household', async () => {
    const { executor, makeExecutor, storage, calls } = fixture({ enabled: true });
    const verified = await executor.createAndVerifyBackup(ATTEMPT, fence);
    await executor.copyOwnerPartition(ATTEMPT, fence, verified, candidate);
    const ownerVerification = await executor.verifyOwnerLibrary(
      ATTEMPT,
      fence,
      verified,
      candidate,
    );

    await expect(
      makeExecutor().prepareHouseholdRewrite({
        attempt: ATTEMPT,
        fence,
        backup: verified,
        candidate,
        ownerVerification,
      }),
    ).resolves.toEqual({ digest: DIGEST });
    expect(storage.verifyBackup).toHaveBeenCalledTimes(4);
    expect(storage.authenticateOwner).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['backup', 'copy', 'verify', 'verify', 'prepare']);
  });

  it('rejects copy evidence with changed candidate, backup, fence, partition, or completeness', async () => {
    const { executor, storage } = fixture({ enabled: true });
    const original = vi.mocked(storage.authenticateOwner).getMockImplementation()!;
    const mutations = [
      { candidate: { ...candidate, libraryId: KID_ID } },
      { backup: { id: 'another', digest: DIGEST } },
      { source: { ...fence, rewrite: 'another' } },
      { plan: { domains: OWNER_SPLIT_COPY_DOMAINS, preferences: { ...partition, owner: {} } } },
      { partitionComplete: false as true },
    ];
    for (const mutation of mutations) {
      vi.mocked(storage.authenticateOwner).mockImplementationOnce(async (input) => ({
        ...(await original(input)),
        ...mutation,
      }));
      await expect(executor.verifyOwnerLibrary(ATTEMPT, fence, backup, candidate)).rejects.toThrow(
        'not authenticated, bound, and complete',
      );
    }
  });

  it('uses one atomic conditional retirement and rejects TOCTOU or incomplete exclusion proof', async () => {
    const { executor, storage, validateDirectory, setRetirement } = fixture({ enabled: true });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).resolves.toBe(
      'retired',
    );
    expect(storage.conditionallyRetireUnreferenced).toHaveBeenCalledOnce();
    expect(validateDirectory).toHaveBeenCalledOnce();

    setRetirement({
      ...safeRetirement(),
      authority: { generation: 9, head: 'e'.repeat(64), kind: 'committed' },
      protectedLibraryKeys: [HOUSEHOLD_KEY, KID_KEY, CANDIDATE_KEY],
    });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).rejects.toThrow(
      'proof is invalid',
    );

    setRetirement({
      ...safeRetirement(),
      context: { ...context, household: { libraryId: KID_ID, libraryKey: KID_KEY } },
    });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).rejects.toThrow(
      'proof is invalid',
    );
  });

  it('fails closed for blocked retirement and keeps activation unavailable', async () => {
    const { executor, setRetirement } = fixture({ enabled: true });
    setRetirement({
      ...safeRetirement('blocked'),
      reason: 'same-legacy-fence',
      authority: { generation: 7, head: SOURCE_HEAD, kind: 'changed-legacy' },
      directoryValidated: false,
    });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).rejects.toThrow(
      'cleanup refused',
    );
    await expect(executor.adoptWinner(directory(), CANDIDATE_KEY)).rejects.toThrow(
      'activation is unavailable',
    );
  });

  it('rejects changed-legacy retirement proof when current authority still matches source', async () => {
    const { executor, setRetirement } = fixture({ enabled: true });
    setRetirement({
      ...safeRetirement(),
      authority: { generation: fence.generation, head: fence.head, kind: 'changed-legacy' },
      directoryValidated: false,
    });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).rejects.toThrow(
      'proof is invalid',
    );

    setRetirement({
      ...safeRetirement('absent'),
      authority: { generation: fence.generation + 1, head: fence.head, kind: 'changed-legacy' },
      directoryValidated: false,
    });
    await expect(executor.retireLosingCandidate(ATTEMPT, fence, candidate)).resolves.toBe('absent');
  });
});
