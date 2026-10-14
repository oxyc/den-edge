import { describe, expect, it } from 'vitest';
import type { OwnerSplitJournal } from './profileOwnerSplitCoordinator';
import { OwnerSplitWorkerStore, type OwnerSplitWorkerVault } from './profileOwnerSplitWorkerStore';

const HOUSEHOLD = '1'.repeat(32);
const OTHER_HOUSEHOLD = '2'.repeat(32);
const ATTEMPT = 'a'.repeat(32);
const OTHER_ATTEMPT = 'b'.repeat(32);
const DIGEST = 'd'.repeat(64);
const SOURCE = { generation: 1, head: DIGEST };
const authorization = (attempt = ATTEMPT) => ({
  intent: {
    version: 1 as const,
    action: 'enable-profiles' as const,
    attempt,
    householdId: HOUSEHOLD,
    source: SOURCE,
  },
  intentDigest: DIGEST,
  commitBinding: null,
});

class MemoryWorkerVault implements OwnerSplitWorkerVault {
  constructor(
    readonly libraryId: string,
    readonly values = new Map<string, unknown>(),
    readonly bindings = new Map<string, string>(),
  ) {}

  async keepRequired(name: string, value: unknown, binding = ''): Promise<void> {
    this.values.set(name, structuredClone(value));
    this.bindings.set(name, binding);
  }

  async keptRequired<T>(
    name: string,
    binding = '',
  ): Promise<{ kind: 'absent' } | { kind: 'value'; value: T }> {
    const value = this.values.get(name);
    if (value === undefined) return { kind: 'absent' };
    if (this.bindings.get(name) !== binding)
      throw new Error('Encrypted migration state is corrupt');
    return { kind: 'value', value: structuredClone(value) as T };
  }

  async discardKept(name: string): Promise<void> {
    this.values.delete(name);
    this.bindings.delete(name);
  }
}

const idle = (): OwnerSplitJournal => ({
  version: 6,
  attempt: ATTEMPT,
  explicitIntent: true,
  householdId: HOUSEHOLD,
  state: 'idle',
  source: SOURCE,
  splitAuthorization: authorization(),
});

const ready = (): OwnerSplitJournal & { readonly state: 'ready-to-commit' } => ({
  version: 6,
  attempt: ATTEMPT,
  explicitIntent: true,
  state: 'ready-to-commit',
  source: SOURCE,
  fence: { generation: 1, base: 4, head: DIGEST, rewrite: 'rewrite-1' },
  backup: { id: 'backup-1', digest: DIGEST },
  householdId: HOUSEHOLD,
  splitAuthorization: { ...authorization(), commitBinding: DIGEST },
  candidate: {
    profileId: '3'.repeat(32),
    libraryId: '4'.repeat(32),
    keyRef: '5'.repeat(64),
    keyFingerprint: DIGEST,
  },
  ownerHead: DIGEST,
  householdWrites: [{ k: '6'.repeat(64), v: 'sealed' }],
  stagedDigest: DIGEST,
  ownerVerified: true,
});

describe('OwnerSplit Worker durable store', () => {
  it('reopens its schema-validated journal with its atomically bound authorization', async () => {
    const vault = new MemoryWorkerVault(HOUSEHOLD);
    const first = new OwnerSplitWorkerStore(vault);
    await first.save(ready());
    const restarted = new OwnerSplitWorkerStore(vault);
    await expect(restarted.load()).resolves.toMatchObject({
      state: 'ready-to-commit',
      splitAuthorization: { commitBinding: DIGEST },
    });
  });

  it('fails closed on a corrupt journal instead of treating it as absent', async () => {
    const vault = new MemoryWorkerVault(HOUSEHOLD);
    await vault.keepRequired(
      'profile-migration/v1/state',
      {
        version: 1,
        householdId: HOUSEHOLD,
        journal: { ...idle(), explicitIntent: false },
      },
      `state:${HOUSEHOLD}:1`,
    );
    await expect(new OwnerSplitWorkerStore(vault).load()).rejects.toThrow(
      /Invalid Owner split journal/,
    );
  });

  it('never carries authorization or recovery evidence into another attempt', async () => {
    const store = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
    await store.save(ready());
    await store.save({
      ...idle(),
      attempt: OTHER_ATTEMPT,
      splitAuthorization: authorization(OTHER_ATTEMPT),
    });

    await expect(store.load()).resolves.toMatchObject({ attempt: OTHER_ATTEMPT, state: 'idle' });
  });

  it('binds candidate credentials to household and attempt across restart', async () => {
    const values = new Map<string, unknown>();
    const bindings = new Map<string, string>();
    const original = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD, values, bindings));
    const handle = await original.allocateCandidate(ATTEMPT);
    expect(JSON.stringify(handle)).not.toContain('libraryKey');

    const restarted = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD, values, bindings));
    await expect(restarted.resolveCandidate(handle.keyRef, ATTEMPT)).resolves.toMatchObject({
      handle,
    });
    await expect(restarted.resolveCandidate(handle.keyRef, OTHER_ATTEMPT)).rejects.toThrow(
      /corrupt/,
    );
    await expect(
      new OwnerSplitWorkerStore(
        new MemoryWorkerVault(OTHER_HOUSEHOLD, values, bindings),
      ).resolveCandidate(handle.keyRef, ATTEMPT),
    ).rejects.toThrow(/corrupt/);
  });

  describe('journal-less recovery handoff', () => {
    const pending = { version: 1 as const, recoveryAttempt: OTHER_ATTEMPT, source: SOURCE };
    const bound = {
      ...pending,
      fence: { generation: 1, base: 4, head: DIGEST, rewrite: 'rewrite-r' },
      backup: { attempt: ATTEMPT, id: 'backup-1', digest: DIGEST },
    };

    it('survives a restart, first without and then with the open answer’s bound values', async () => {
      const vault = new MemoryWorkerVault(HOUSEHOLD);
      const first = new OwnerSplitWorkerStore(vault);
      await first.saveHandoff(pending);
      await expect(first.fenceGeneration()).resolves.toBeNull();
      await first.saveHandoff(bound);
      const restarted = new OwnerSplitWorkerStore(vault);
      await expect(restarted.loadHandoff()).resolves.toEqual(bound);
      await expect(restarted.fenceGeneration()).resolves.toBe(1);
      await expect(restarted.load()).resolves.toBeNull();
      await restarted.clearHandoff(OTHER_ATTEMPT);
      await expect(restarted.loadHandoff()).resolves.toBeNull();
    });

    it('never coexists with a split journal, in either order', async () => {
      const handoff = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
      await handoff.saveHandoff(pending);
      await expect(handoff.save(idle())).rejects.toThrow(/recovery handoff already owns/);

      const journal = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
      await journal.save(idle());
      await expect(journal.saveHandoff(pending)).rejects.toThrow(/split journal already owns/);
    });

    it('refuses a second restore attempt and clearing someone else’s', async () => {
      const store = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
      await store.saveHandoff(pending);
      await expect(store.saveHandoff({ ...pending, recoveryAttempt: ATTEMPT })).rejects.toThrow(
        /Another recovery attempt/,
      );
      await expect(store.clearHandoff(ATTEMPT)).rejects.toThrow(/another recovery attempt/);
      await expect(store.loadHandoff()).resolves.toEqual(pending);
    });

    it('fails closed on a half-bound or corrupt handoff instead of treating it as absent', async () => {
      const store = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
      await expect(store.saveHandoff({ ...pending, fence: bound.fence })).rejects.toThrow(
        /handoff is unavailable or corrupt/,
      );
      await expect(
        store.saveHandoff({ ...bound, backup: { ...bound.backup, attempt: OTHER_ATTEMPT } }),
      ).rejects.toThrow(/handoff is unavailable or corrupt/);
      const vault = new MemoryWorkerVault(HOUSEHOLD);
      await vault.keepRequired(
        'profile-migration/v1/state',
        { version: 1, householdId: HOUSEHOLD, handoff: pending, journal: idle() },
        `state:${HOUSEHOLD}:1`,
      );
      await expect(new OwnerSplitWorkerStore(vault).loadHandoff()).rejects.toThrow(/corrupt/);
    });
  });

  it('drops only a refused recovery authorization and keeps the split journal', async () => {
    const store = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
    await store.save({
      ...idle(),
      state: 'restore-required',
      fence: { generation: 1, base: 4, head: DIGEST, rewrite: 'rewrite-1' },
      backup: { id: 'backup-1', digest: DIGEST },
    });
    await store.authorizeRecovery({
      version: 2,
      attempt: ATTEMPT,
      recoveryAttempt: OTHER_ATTEMPT,
      recoveryIntent: true,
      source: SOURCE,
    });
    await expect(store.loadRecoveryIntent(ATTEMPT)).resolves.not.toBeNull();
    await store.discardRecovery(ATTEMPT);
    await expect(store.loadRecoveryIntent(ATTEMPT)).resolves.toBeNull();
    await expect(store.load()).resolves.toMatchObject({ attempt: ATTEMPT });
    await expect(store.discardRecovery(OTHER_ATTEMPT)).rejects.toThrow(/changed before recovery/);
  });

  it('rejects candidate corruption and removes the credential idempotently', async () => {
    const vault = new MemoryWorkerVault(HOUSEHOLD);
    const store = new OwnerSplitWorkerStore(vault);
    const handle = await store.allocateCandidate(ATTEMPT);
    vault.values.set(`profile-migration/v1/candidate/${handle.keyRef}`, { broken: true });
    await expect(store.resolveCandidate(handle.keyRef, ATTEMPT)).rejects.toThrow(/corrupt/);
    await store.forgetCandidate(handle.keyRef);
    await store.forgetCandidate(handle.keyRef);
    await expect(store.resolveCandidate(handle.keyRef, ATTEMPT)).rejects.toThrow(/corrupt/);
  });
});
