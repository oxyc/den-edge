import { describe, expect, it } from 'vitest';
import type { OwnerSplitJournal } from './profileOwnerSplitCoordinator';
import { OwnerSplitWorkerStore, type OwnerSplitWorkerVault } from './profileOwnerSplitWorkerStore';

const HOUSEHOLD = '1'.repeat(32);
const OTHER_HOUSEHOLD = '2'.repeat(32);
const ATTEMPT = 'a'.repeat(32);
const OTHER_ATTEMPT = 'b'.repeat(32);
const DIGEST = 'd'.repeat(64);

class MemoryWorkerVault implements OwnerSplitWorkerVault {
  constructor(
    readonly libraryId: string,
    readonly values = new Map<string, unknown>(),
  ) {}

  async keepRequired(name: string, value: unknown): Promise<void> {
    this.values.set(name, structuredClone(value));
  }

  async kept<T>(name: string): Promise<T | undefined> {
    const value = this.values.get(name);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async discardKept(name: string): Promise<void> {
    this.values.delete(name);
  }
}

const idle = (): OwnerSplitJournal => ({
  version: 4,
  attempt: ATTEMPT,
  explicitIntent: true,
  state: 'idle',
});

const ready = (): OwnerSplitJournal & { readonly state: 'ready-to-commit' } => ({
  version: 4,
  attempt: ATTEMPT,
  explicitIntent: true,
  state: 'ready-to-commit',
  fence: { generation: 1, base: 4, head: DIGEST, rewrite: 'rewrite-1' },
  backup: { id: 'backup-1', digest: DIGEST },
  householdId: HOUSEHOLD,
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
  it('reopens its schema-validated journal and atomically bound commit authorization', async () => {
    const vault = new MemoryWorkerVault(HOUSEHOLD);
    const first = new OwnerSplitWorkerStore(vault);
    await first.save(ready());
    await first.authorizeCommit(ready(), {
      version: 1,
      attempt: ATTEMPT,
      ownerHead: DIGEST,
      stagedDigest: DIGEST,
      commitAuthorized: true,
    });

    const restarted = new OwnerSplitWorkerStore(vault);
    await expect(restarted.load()).resolves.toMatchObject({ state: 'ready-to-commit' });
    await expect(restarted.loadCommitAuthorization(ATTEMPT)).resolves.toMatchObject({
      commitAuthorized: true,
      attempt: ATTEMPT,
    });
  });

  it('fails closed on a corrupt journal instead of treating it as absent', async () => {
    const vault = new MemoryWorkerVault(HOUSEHOLD);
    vault.values.set('profile-migration/v1/state', {
      version: 1,
      householdId: HOUSEHOLD,
      journal: { ...idle(), explicitIntent: false },
    });
    await expect(new OwnerSplitWorkerStore(vault).load()).rejects.toThrow(
      /Invalid Owner split journal/,
    );
  });

  it('never carries authorization or recovery evidence into another attempt', async () => {
    const store = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD));
    await store.save(ready());
    await store.authorizeCommit(ready(), {
      version: 1,
      attempt: ATTEMPT,
      ownerHead: DIGEST,
      stagedDigest: DIGEST,
      commitAuthorized: true,
    });
    await store.save({ ...idle(), attempt: OTHER_ATTEMPT });

    await expect(store.load()).resolves.toMatchObject({ attempt: OTHER_ATTEMPT, state: 'idle' });
    await expect(store.loadCommitAuthorization(OTHER_ATTEMPT)).resolves.toBeNull();
  });

  it('binds candidate credentials to household and attempt across restart', async () => {
    const values = new Map<string, unknown>();
    const original = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD, values));
    const handle = await original.allocateCandidate(ATTEMPT);
    expect(JSON.stringify(handle)).not.toContain('libraryKey');

    const restarted = new OwnerSplitWorkerStore(new MemoryWorkerVault(HOUSEHOLD, values));
    await expect(restarted.resolveCandidate(handle.keyRef, ATTEMPT)).resolves.toMatchObject({
      handle,
    });
    await expect(restarted.resolveCandidate(handle.keyRef, OTHER_ATTEMPT)).rejects.toThrow(
      /not bound/,
    );
    await expect(
      new OwnerSplitWorkerStore(new MemoryWorkerVault(OTHER_HOUSEHOLD, values)).resolveCandidate(
        handle.keyRef,
        ATTEMPT,
      ),
    ).rejects.toThrow(/not bound/);
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
