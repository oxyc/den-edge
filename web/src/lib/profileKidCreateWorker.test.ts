import { describe, expect, it, vi } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import {
  ProfileKidCreateCoordinator,
  ProfileKidCreateStore,
  type ProfileKidCreateIO,
  type ProfileKidCreateVault,
} from './profileKidCreateWorker';
import type { Stamp } from './wire';

const HOUSEHOLD = '1'.repeat(32);
const stamps = [
  [1_800_000_005_000, 0, 'a1b2c3d4e5f60718'],
  [1_800_000_005_000, 1, 'a1b2c3d4e5f60718'],
  [1_800_000_005_000, 2, 'a1b2c3d4e5f60718'],
  [1_800_000_005_000, 3, 'a1b2c3d4e5f60718'],
] as const satisfies readonly [Stamp, Stamp, Stamp, Stamp];

class MemoryVault implements ProfileKidCreateVault {
  readonly values = new Map<string, unknown>();
  readonly bindings = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly failedWrites = new Map<string, number>();
  failReceiptWrites = 0;

  constructor(readonly libraryId = HOUSEHOLD) {}

  async keepRequired(name: string, value: unknown, binding = ''): Promise<void> {
    this.writes.push(name);
    if (name.startsWith('profile-create/v2/receipt/') && this.failReceiptWrites > 0) {
      this.failReceiptWrites -= 1;
      throw new Error('receipt storage unavailable');
    }
    const failures = this.failedWrites.get(name) ?? 0;
    if (failures > 0) {
      this.failedWrites.set(name, failures - 1);
      throw new Error('storage unavailable');
    }
    this.values.set(name, structuredClone(value));
    this.bindings.set(name, binding);
  }

  async keptRequired<T>(
    name: string,
    binding = '',
  ): Promise<{ kind: 'absent' } | { kind: 'value'; value: T }> {
    this.reads.push(name);
    if (!this.values.has(name)) return { kind: 'absent' };
    if (this.bindings.get(name) !== binding) throw new Error('sealed value binding changed');
    return { kind: 'value', value: structuredClone(this.values.get(name)) as T };
  }

  async discardKept(name: string): Promise<void> {
    this.values.delete(name);
    this.bindings.delete(name);
  }
}

function ownerDirectory(): ProfileDirectoryDocument {
  const cases = fixture.initialDirectoryConstructorCases as Array<{
    expect?: { directory: unknown };
  }>;
  return validateStoredProfileDirectory(structuredClone(cases[0]!.expect!.directory));
}

async function receiptName(operationId: string): Promise<[string, string]> {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  return [`profile-create/v2/receipt/${digest}`, `profile-create:${HOUSEHOLD}:2:receipt:${digest}`];
}

function harness(
  outcomes: Array<'committed' | 'conflict' | 'unknown'> = ['committed'],
  conflict: 'unchanged' | 'rekeyed-winner' = 'unchanged',
) {
  const vault = new MemoryVault();
  let directory = ownerDirectory();
  let base = 41;
  const io: ProfileKidCreateIO = {
    hasActiveOwner: vi.fn(() => true),
    readDirectory: vi.fn(async () => ({
      directory: structuredClone(directory),
      authority: { base, generation: 'store-a.library-9' },
    })),
    createAndVerifyProfileLibrary: vi.fn(async () => undefined),
    casDirectory: vi.fn(async (_authority, candidate) => {
      const outcome = outcomes.shift() ?? 'committed';
      // `unknown` models a response lost after the server committed it.
      if (outcome === 'committed' || outcome === 'unknown') {
        directory = structuredClone(candidate);
        base += 1;
      } else if (conflict === 'rekeyed-winner') {
        const winner = structuredClone(candidate);
        const profile = Object.keys(winner.profiles).find((id) => id !== winner.owner)!;
        const entry = winner.profiles[profile]!;
        winner.profiles[profile] = {
          ...entry,
          library: {
            value: { keyVersion: 2, key: 'ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY=' },
            at: [1_800_000_006_000, 0, '0f1e2d3c4b5a6978'],
          },
        };
        directory = validateStoredProfileDirectory(winner);
        base += 1;
      }
      return outcome;
    }),
    retireProfileLibrary: vi.fn(async () => true),
    adoptDirectory: vi.fn(async (candidate) => {
      directory = structuredClone(candidate);
    }),
    proveProfileResult: vi.fn(async (result) => {
      const profile = directory.profiles[result.profile];
      if (
        !profile ||
        profile.role !== 'kid' ||
        profile.deleted.value ||
        profile.display.value.name !== result.name ||
        profile.policy.value.maximumAge !== result.maximumAge ||
        profile.policy.value.unknownRatings !== 'block'
      )
        throw new Error('receipt is not directory-bound');
    }),
  };
  const store = new ProfileKidCreateStore(vault);
  return {
    vault,
    store,
    io,
    coordinator: new ProfileKidCreateCoordinator(HOUSEHOLD, store, io),
    directory: () => directory,
  };
}

describe('persistent Kid profile Worker lifecycle', () => {
  it('creates and verifies the activity library before publishing a fail-closed Kid', async () => {
    const h = harness();
    const result = await h.coordinator.begin('create-sam', 'Sam', 8, stamps);

    expect(result).toEqual({
      profile: expect.stringMatching(/^[0-9a-f]{32}$/),
      name: 'Sam',
      maximumAge: 8,
      receipt: 'create-sam',
    });
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
    expect(h.io.casDirectory).toHaveBeenCalledOnce();
    expect(h.directory().profiles[result.profile]?.policy.value).toEqual({
      maximumAge: 8,
      unknownRatings: 'block',
    });
    await expect(h.store.load()).resolves.toBeNull();
    expect(JSON.stringify(result)).not.toContain('key');
  });

  it('adopts an exact committed candidate after a lost CAS response without creating twice', async () => {
    const h = harness(['unknown']);
    const result = await h.coordinator.begin('create-mina', 'Mina', 12, stamps);

    expect(result.name).toBe('Mina');
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
    expect(h.io.casDirectory).toHaveBeenCalledOnce();
    // Apply authority, ambiguity reconciliation, and final adoption proof are all fresh reads.
    expect(h.io.readDirectory).toHaveBeenCalledTimes(3);
    expect(h.io.adoptDirectory).toHaveBeenCalledOnce();
  });

  it('keeps the sealed journal for a later restart when candidate verification fails', async () => {
    const h = harness();
    vi.mocked(h.io.createAndVerifyProfileLibrary).mockRejectedValueOnce(new Error('offline'));
    await expect(h.coordinator.begin('create-restart', 'Sam', 7, stamps)).rejects.toThrow(
      'offline',
    );
    await expect(h.store.load()).resolves.toMatchObject({ state: 'journaled' });

    const restarted = new ProfileKidCreateCoordinator(HOUSEHOLD, h.store, h.io);
    await expect(restarted.resume()).resolves.toMatchObject({ name: 'Sam', maximumAge: 7 });
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledTimes(2);
  });

  it('merges a concurrent unrelated directory change and retries the exact CAS', async () => {
    const h = harness(['conflict', 'committed']);

    await expect(h.coordinator.begin('create-merge', 'Sam', 10, stamps)).resolves.toMatchObject({
      name: 'Sam',
    });

    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
    expect(h.io.casDirectory).toHaveBeenCalledTimes(2);
    expect(h.io.retireProfileLibrary).not.toHaveBeenCalled();
  });

  it('retires its losing activity library when a concurrent winner rekeys the same profile', async () => {
    const h = harness(['conflict'], 'rekeyed-winner');

    await expect(h.coordinator.begin('create-rekey', 'Sam', 10, stamps)).resolves.toMatchObject({
      name: 'Sam',
    });

    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
    expect(h.io.casDirectory).toHaveBeenCalledOnce();
    expect(h.io.retireProfileLibrary).toHaveBeenCalledOnce();
    expect(h.io.adoptDirectory).toHaveBeenCalledOnce();
  });

  it('rejects invalid age before persisting random material', async () => {
    const h = harness();
    await expect(h.coordinator.begin('create-invalid', 'Sam', 19, stamps)).rejects.toThrow(
      /invalid/,
    );
    expect(h.vault.values.size).toBe(0);
    expect(h.io.createAndVerifyProfileLibrary).not.toHaveBeenCalled();
  });

  it('does no storage or network I/O without an active profile directory', async () => {
    const h = harness();
    vi.mocked(h.io.hasActiveOwner).mockReturnValue(false);

    await expect(h.coordinator.begin('create-no-owner', 'Sam', 8, stamps)).rejects.toThrow(
      /active profile directory/,
    );

    expect(h.vault.values.size).toBe(0);
    expect(h.io.readDirectory).not.toHaveBeenCalled();
    expect(h.io.createAndVerifyProfileLibrary).not.toHaveBeenCalled();
  });

  it('returns the same directory-proved receipt when an identical operation is replayed after cleanup', async () => {
    const h = harness();
    const first = await h.coordinator.begin('stable-operation', 'Sam', 8, stamps);
    const calls = vi.mocked(h.io.createAndVerifyProfileLibrary).mock.calls.length;

    const replayed = await new ProfileKidCreateCoordinator(HOUSEHOLD, h.store, h.io).begin(
      'stable-operation',
      'Sam',
      8,
      stamps,
    );

    expect(replayed).toEqual(first);
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledTimes(calls);
    expect(h.io.adoptDirectory).toHaveBeenCalledOnce();
    expect(h.io.proveProfileResult).toHaveBeenCalledOnce();
    await expect(h.coordinator.begin('stable-operation', 'Sam changed', 8, stamps)).rejects.toThrow(
      /payload changed/,
    );
  });

  it('rejects changed payload and a second operation while the first is pending', async () => {
    const h = harness();
    vi.mocked(h.io.createAndVerifyProfileLibrary).mockRejectedValue(new Error('offline'));
    await expect(h.coordinator.begin('stable-operation', 'Sam', 8, stamps)).rejects.toThrow(
      'offline',
    );

    await expect(h.coordinator.begin('stable-operation', 'Sam', 9, stamps)).rejects.toThrow();
    await expect(h.coordinator.begin('another-operation', 'Sam', 8, stamps)).rejects.toThrow();
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it('keeps one terminal receipt until a separate idempotent acknowledgement', async () => {
    const h = harness();
    const first = await h.coordinator.begin('terminal-operation', 'Sam', 8, stamps);

    await expect(h.coordinator.begin('different-operation', 'Mina', 8, stamps)).rejects.toThrow(
      /awaiting acknowledgement/,
    );
    await expect(h.coordinator.resume()).resolves.toEqual(first);
    await expect(h.coordinator.acknowledge(first.receipt)).resolves.toBeUndefined();
    await expect(h.coordinator.acknowledge(first.receipt)).resolves.toBeUndefined();

    await expect(h.coordinator.begin('terminal-operation', 'Sam', 8, stamps)).resolves.toEqual(
      first,
    );
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it('recovers when the indexed receipt lands before terminal cleanup', async () => {
    const h = harness();
    const first = await h.coordinator.begin('receipt-before-clear', 'Sam', 8, stamps);
    h.vault.failReceiptWrites = 1;

    await expect(h.coordinator.acknowledge(first.receipt)).rejects.toThrow(
      'receipt storage unavailable',
    );
    expect(
      [...h.vault.values.keys()].filter((name) => name.startsWith('profile-create/v2/receipt/')),
    ).toHaveLength(0);
    h.vault.failedWrites.set('profile-create/v1/state', 1);

    await expect(h.coordinator.acknowledge(first.receipt)).rejects.toThrow('storage unavailable');
    expect(
      [...h.vault.values.keys()].filter((name) => name.startsWith('profile-create/v2/receipt/')),
    ).toHaveLength(1);
    await expect(h.coordinator.acknowledge(first.receipt)).resolves.toBeUndefined();
    await expect(
      h.coordinator.begin('after-recovered-ack', 'Mina', 9, stamps),
    ).resolves.toMatchObject({
      name: 'Mina',
    });
  });

  it('migrates v1 settled history idempotently after an interrupted state write', async () => {
    const h = harness();
    const first = await h.coordinator.begin('legacy-operation', 'Sam', 8, stamps);
    await h.coordinator.acknowledge(first.receipt);
    const indexed = [...h.vault.values.entries()].find(([name]) =>
      name.startsWith('profile-create/v2/receipt/'),
    )![1];
    h.vault.values.clear();
    h.vault.bindings.clear();
    h.vault.values.set('profile-create/v1/state', {
      version: 1,
      householdId: HOUSEHOLD,
      settled: [indexed],
    });
    h.vault.bindings.set('profile-create/v1/state', `profile-create:${HOUSEHOLD}:1`);
    h.vault.failedWrites.set('profile-create/v1/state', 1);
    const restarted = () =>
      new ProfileKidCreateCoordinator(HOUSEHOLD, new ProfileKidCreateStore(h.vault), h.io);

    await expect(restarted().begin('legacy-operation', 'Sam', 8, stamps)).rejects.toThrow(
      'storage unavailable',
    );
    await expect(restarted().begin('legacy-operation', 'Sam', 8, stamps)).resolves.toEqual(first);
    expect(h.vault.values.get('profile-create/v1/state')).toEqual({
      version: 2,
      householdId: HOUSEHOLD,
    });
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it.each([1, 8, 32, 256, 1024])(
    'migrates %i receipts once and keeps steady replay to two indexed reads',
    async (count) => {
      const vault = new MemoryVault();
      vault.values.set('profile-create/v1/state', {
        version: 1,
        householdId: HOUSEHOLD,
        settled: Array.from({ length: count }, (_, index) => ({
          request: { operationId: `operation-${index}`, name: 'Sam', maximumAge: 8 },
          result: {
            profile: index.toString(16).padStart(32, '0'),
            name: 'Sam',
            maximumAge: 8,
          },
          directoryDigest: 'a'.repeat(64),
        })),
      });
      vault.bindings.set('profile-create/v1/state', `profile-create:${HOUSEHOLD}:1`);
      const store = new ProfileKidCreateStore(vault);

      await expect(store.load()).resolves.toBeNull();
      expect(
        [...vault.values.keys()].filter((name) => name.startsWith('profile-create/v2/receipt/')),
      ).toHaveLength(count);
      expect(vault.writes).toHaveLength(count + 1);
      vault.reads.length = 0;
      await expect(store.create(`operation-${count - 1}`, 'Sam', 8, stamps)).resolves.toMatchObject(
        {
          kind: 'receipt',
        },
      );
      expect(vault.reads).toEqual([
        'profile-create/v1/state',
        expect.stringMatching(/^profile-create\/v2\/receipt\/[0-9a-f]{64}$/),
      ]);
    },
  );

  it('retains the terminal receipt when its pre-ack directory proof fails', async () => {
    const h = harness();
    const created = await h.coordinator.begin('terminal-proof', 'Sam', 8, stamps);
    delete h.directory().profiles[created.profile];

    await expect(h.coordinator.acknowledge(created.receipt)).rejects.toThrow(/not directory-bound/);
    await expect(h.coordinator.begin('another-create', 'Mina', 8, stamps)).rejects.toThrow(
      /awaiting acknowledgement/,
    );
  });

  it('indexes replay protection one-for-one without rereading settled history', async () => {
    const h = harness();
    let first: Awaited<ReturnType<typeof h.coordinator.begin>> | undefined;
    for (let index = 0; index < 36; index += 1) {
      const receipt = await h.coordinator.begin(
        `${'😀'.repeat(120)}-${index}`,
        '😀'.repeat(64),
        8,
        stamps,
      );
      first ??= receipt;
      await h.coordinator.acknowledge(receipt.receipt);
    }

    const envelope = h.vault.values.get('profile-create/v1/state');
    expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThan(256);
    const receipts = [...h.vault.values.entries()].filter(([name]) =>
      name.startsWith('profile-create/v2/receipt/'),
    );
    expect(receipts).toHaveLength(36);
    expect(
      Math.max(
        ...receipts.map(
          ([, receipt]) => new TextEncoder().encode(JSON.stringify(receipt)).byteLength,
        ),
      ),
    ).toBeLessThan(2_048);
    expect(JSON.stringify([...h.vault.values.values()])).not.toContain('"key"');
    const next = await h.coordinator.begin('no-arbitrary-cap', 'Another Kid', 8, stamps);
    await h.coordinator.acknowledge(next.receipt);
    h.vault.reads.length = 0;
    await expect(
      h.coordinator.begin(`${'😀'.repeat(120)}-0`, '😀'.repeat(64), 8, stamps),
    ).resolves.toEqual(first);
    expect(h.vault.reads).toEqual([
      'profile-create/v1/state',
      expect.stringMatching(/^profile-create\/v2\/receipt\/[0-9a-f]{64}$/),
    ]);
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledTimes(37);
  });

  it('fails closed when a settled replay no longer has an authoritative directory mapping', async () => {
    const h = harness();
    const created = await h.coordinator.begin('missing-mapping', 'Sam', 8, stamps);
    await h.coordinator.acknowledge(created.receipt);
    delete h.directory().profiles[created.profile];

    await expect(h.coordinator.begin('missing-mapping', 'Sam', 8, stamps)).rejects.toThrow(
      /not directory-bound/,
    );
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it('fails closed when a settled receipt profile mapping is tampered', async () => {
    const h = harness();
    const created = await h.coordinator.begin('tampered-mapping', 'Sam', 8, stamps);
    await h.coordinator.acknowledge(created.receipt);
    const name = [...h.vault.values.keys()].find((candidate) =>
      candidate.startsWith('profile-create/v2/receipt/'),
    )!;
    const envelope = structuredClone(h.vault.values.get(name)) as {
      result: { profile: string };
    };
    envelope.result.profile = 'f'.repeat(32);
    h.vault.values.set(name, envelope);

    await expect(h.coordinator.begin('tampered-mapping', 'Sam', 8, stamps)).rejects.toThrow(
      /not directory-bound/,
    );
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it('fails closed if an indexed record contains a different full operation id', async () => {
    const h = harness();
    const created = await h.coordinator.begin('indexed-source', 'Sam', 8, stamps);
    await h.coordinator.acknowledge(created.receipt);
    const sourceName = [...h.vault.values.keys()].find((candidate) =>
      candidate.startsWith('profile-create/v2/receipt/'),
    )!;
    const source = structuredClone(h.vault.values.get(sourceName));
    const [collisionName, collisionBinding] = await receiptName('indexed-target');
    h.vault.values.set(collisionName, source);
    h.vault.bindings.set(collisionName, collisionBinding);

    await expect(h.store.create('indexed-target', 'Sam', 8, stamps)).rejects.toThrow(/collided/);
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledOnce();
  });

  it('accepts exactly 64 Unicode scalars, including astral characters', async () => {
    const h = harness();
    await expect(
      h.coordinator.begin('unicode-boundary', '😀'.repeat(64), 8, stamps),
    ).resolves.toMatchObject({ name: '😀'.repeat(64) });

    await expect(
      h.coordinator.begin('unicode-too-long', '😀'.repeat(65), 8, stamps),
    ).rejects.toThrow(/invalid/);
  });
});
