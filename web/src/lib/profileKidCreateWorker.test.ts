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

  constructor(readonly libraryId = HOUSEHOLD) {}

  async keepRequired(name: string, value: unknown, binding = ''): Promise<void> {
    this.values.set(name, structuredClone(value));
    this.bindings.set(name, binding);
  }

  async keptRequired<T>(
    name: string,
    binding = '',
  ): Promise<{ kind: 'absent' } | { kind: 'value'; value: T }> {
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

  it('retains the terminal receipt when its pre-ack directory proof fails', async () => {
    const h = harness();
    const created = await h.coordinator.begin('terminal-proof', 'Sam', 8, stamps);
    delete h.directory().profiles[created.profile];

    await expect(h.coordinator.acknowledge(created.receipt)).rejects.toThrow(/not directory-bound/);
    await expect(h.coordinator.begin('another-create', 'Mina', 8, stamps)).rejects.toThrow(
      /awaiting acknowledgement/,
    );
  });

  it('keeps compact replay protection one-for-one with more than 32 created profiles', async () => {
    const h = harness();
    let first: Awaited<ReturnType<typeof h.coordinator.begin>> | undefined;
    let halfwayBytes = 0;
    // Each create re-reads and re-validates every settled receipt, so the work grows with the square of the count;
    // 36 is the smallest even count past the old 32-receipt cap, and the halfway reading is at its midpoint.
    for (let index = 0; index < 36; index += 1) {
      const receipt = await h.coordinator.begin(
        `${'😀'.repeat(120)}-${index}`,
        '😀'.repeat(64),
        8,
        stamps,
      );
      first ??= receipt;
      await h.coordinator.acknowledge(receipt.receipt);
      if (index === 17)
        halfwayBytes = new TextEncoder().encode(
          JSON.stringify(h.vault.values.get('profile-create/v1/state')),
        ).byteLength;
    }

    const envelope = h.vault.values.get('profile-create/v1/state');
    const fullBytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    expect(fullBytes).toBeLessThan(65_536);
    expect(fullBytes).toBeLessThan(halfwayBytes * 2.1);
    expect(JSON.stringify(envelope)).not.toContain('"key"');
    const next = await h.coordinator.begin('no-arbitrary-cap', 'Another Kid', 8, stamps);
    await h.coordinator.acknowledge(next.receipt);
    await expect(
      h.coordinator.begin(`${'😀'.repeat(120)}-0`, '😀'.repeat(64), 8, stamps),
    ).resolves.toEqual(first);
    expect(h.io.createAndVerifyProfileLibrary).toHaveBeenCalledTimes(37);
    // ~0.55 s of CPU on an idle machine, nearly all of it den-core's WASM validating the growing envelope and
    // directory on every create; the default 5 s is then under 10x headroom, which a busy runner removes.
  }, 20_000);

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
    const envelope = structuredClone(h.vault.values.get('profile-create/v1/state')) as {
      settled: Array<{ result: { profile: string } }>;
    };
    envelope.settled[0]!.result.profile = 'f'.repeat(32);
    h.vault.values.set('profile-create/v1/state', envelope);

    await expect(h.coordinator.begin('tampered-mapping', 'Sam', 8, stamps)).rejects.toThrow(
      /not directory-bound/,
    );
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
