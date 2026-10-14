import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import { FakeEdge } from './profileKeyResetFakeEdge';
import type { ProfileResetAdoption } from './profileKeyResetBackend';
import type { ProfileAdoptionRequest } from './profileKeyResetExecutor';
import {
  ProfileKeyResetService,
  ProfileResetUnauthorizedError,
  VaultResetAdoption,
} from './profileKeyResetService';
import type { LibraryLog } from './log';
import type { ProfileKidCreateVault } from './profileKidCreateWorker';

const OWNER = '00112233445566778899aabbccddeeff';
const MINA = '11112222333344445555666677778888';
const LEO = '9999aaaabbbbccccddddeeeeffff0000';
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const RECOVERY = 'fedcba9876543210fedcba9876543210';
const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const HOUSEHOLD_KEY = keyOf(4);
const SUCCESSORS = { H2: keyOf(80), OWNER2: keyOf(81), MINA2: keyOf(82), LEO2: keyOf(83) };

const directory = (): ProfileDirectoryDocument =>
  validateStoredProfileDirectory(structuredClone(fixture.migrationBase));

class MemoryVault implements ProfileKidCreateVault {
  readonly values = new Map<string, unknown>();
  readonly bindings = new Map<string, string>();
  constructor(readonly libraryId = '1'.repeat(32)) {}
  async keepRequired(name: string, value: unknown, binding = '') {
    this.values.set(name, structuredClone(value));
    this.bindings.set(name, binding);
  }
  async keptRequired<T>(name: string, binding = '') {
    if (!this.values.has(name)) return { kind: 'absent' as const };
    if (this.bindings.get(name) !== binding) throw new Error('sealed value binding changed');
    return { kind: 'value' as const, value: structuredClone(this.values.get(name)) as T };
  }
  async discardKept(name: string) {
    this.values.delete(name);
    this.bindings.delete(name);
  }
}

class MemoryAdoption implements ProfileResetAdoption {
  adopted: ProfileAdoptionRequest | null = null;
  async adopt(request: ProfileAdoptionRequest) {
    this.adopted = structuredClone(request);
  }
  async isAdopted(request: ProfileAdoptionRequest) {
    return JSON.stringify(this.adopted) === JSON.stringify(request);
  }
}

async function world(withDirectory = true) {
  const edge = new FakeEdge();
  const dir = directory();
  await edge.add('H', HOUSEHOLD_KEY, 5, ['library'], withDirectory ? dir : null);
  for (const [label, id] of [
    ['OWNER', OWNER],
    ['MINA', MINA],
    ['LEO', LEO],
  ] as const)
    await edge.add(label, dir.profiles[id]!.library.value.key, 4, ['watch']);
  for (const [label, key] of Object.entries(SUCCESSORS)) await edge.plan(label, key);
  return edge;
}

function service(
  edge: FakeEdge,
  options: { gate?: boolean; pin?: string; vault?: MemoryVault; adoption?: MemoryAdoption } = {},
) {
  const vault = options.vault ?? new MemoryVault();
  const adoption = options.adoption ?? new MemoryAdoption();
  let next = 80;
  return {
    vault,
    adoption,
    service: new ProfileKeyResetService({
      vault,
      householdKey: HOUSEHOLD_KEY,
      device: 'device',
      open: (key, wire) => edge.open(key, wire),
      adoption,
      gate: async () => options.gate ?? true,
      ownerPin: async (pin) => pin === (options.pin ?? '1234'),
      options: {
        randomKey: () => new Uint8Array(32).fill(next++),
        randomAttempt: () => ATTEMPT,
        now: () => 1_800_000_100_000,
      },
    }),
  };
}

const start = { pin: '1234', destinationLibraryKey: SUCCESSORS.H2 };

describe('profile key reset service', () => {
  it('reads and sends nothing while the profile gate is closed', async () => {
    const edge = await world();
    const { service: closed } = service(edge, { gate: false });
    await expect(closed.start(start)).resolves.toBe('unavailable');
    await expect(closed.resume()).resolves.toBe('unavailable');
    await expect(
      closed.recover({ pin: '1234', recoveryAttempt: RECOVERY, successorKey: null }),
    ).resolves.toBe('unavailable');
    expect(edge.log).toEqual([]);
  });

  it('requires a fresh Owner PIN to start or recover, before any request', async () => {
    const edge = await world();
    const { service: guarded } = service(edge);
    await expect(guarded.start({ ...start, pin: '0000' })).rejects.toBeInstanceOf(
      ProfileResetUnauthorizedError,
    );
    await expect(
      guarded.recover({ pin: '0000', recoveryAttempt: RECOVERY, successorKey: null }),
    ).rejects.toBeInstanceOf(ProfileResetUnauthorizedError);
    expect(edge.log).toEqual([]);
  });

  it('resets the household to the page-prepared key and reports complete', async () => {
    const edge = await world();
    const { service: reset, adoption, vault } = service(edge);

    await expect(reset.start(start)).resolves.toBe('complete');

    expect(adoption.adopted?.householdKey).toBe(SUCCESSORS.H2);
    for (const label of ['H', 'OWNER', 'MINA', 'LEO'])
      expect(edge.lib(label).retired).not.toBeNull();
    expect(vault.values.size).toBe(0);
  });

  it('is unavailable for a household with no directory, without locking anything', async () => {
    const edge = await world(false);
    const { service: reset } = service(edge);
    await expect(reset.start(start)).resolves.toBe('unavailable');
    expect(edge.log.some((entry) => entry.endsWith('POST acquire'))).toBe(false);
  });

  it('waits when den-edge is unreachable, keeps the journal, and resumes without a PIN', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    const adoption = new MemoryAdoption();
    edge.serverErrors.set('H GET lookup', 99);
    const { service: first } = service(edge, { vault, adoption });
    await expect(first.start(start)).resolves.toBe('waiting');
    expect(vault.values.size).toBe(1);
    edge.serverErrors.clear();

    const { service: again } = service(edge, { vault, adoption });
    await expect(again.resume()).resolves.toBe('complete');
    expect(vault.values.size).toBe(0);
    expect(adoption.adopted?.householdKey).toBe(SUCCESSORS.H2);
  });

  it('continues the durable attempt when started again instead of minting new keys', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    edge.faults.push({ on: 'LEO2 takeMoved', when: 'before' });
    const { service: first } = service(edge, { vault });
    await first.start(start).catch(() => undefined);
    edge.revive();
    const { service: second, adoption } = service(edge, { vault });
    await expect(second.start({ ...start, destinationLibraryKey: keyOf(99) })).resolves.toBe(
      'complete',
    );
    expect(adoption.adopted?.householdKey).toBe(SUCCESSORS.H2);
  });

  it('answers none when there is no journal to resume', async () => {
    const edge = await world();
    await expect(service(edge).service.resume()).resolves.toBe('none');
  });

  it('recovers an open reset by aborting it', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    edge.faults.push({ on: 'OWNER2 takeMoved', when: 'before' });
    await service(edge, { vault })
      .service.start(start)
      .catch(() => undefined);
    edge.revive();

    // Another device: no journal of its own.
    const { service: other } = service(edge);
    await expect(
      other.recover({ pin: '1234', recoveryAttempt: RECOVERY, successorKey: null }),
    ).resolves.toBe('aborted');
    expect(edge.write('H', 'free')).toBe(true);
  });

  it('refuses to recover on the device that holds the journal, and surfaces it', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    edge.faults.push({ on: 'OWNER2 takeMoved', when: 'before' });
    await service(edge, { vault })
      .service.start(start)
      .catch(() => undefined);
    edge.revive();
    await expect(
      service(edge, { vault }).service.recover({
        pin: '1234',
        recoveryAttempt: RECOVERY,
        successorKey: null,
      }),
    ).rejects.toThrow('journal');
  });
});

describe('vault reset adoption', () => {
  const request = (head: string): ProfileAdoptionRequest =>
    ({
      attempt: ATTEMPT,
      householdKey: SUCCESSORS.H2,
      committedHead: head,
    }) as ProfileAdoptionRequest;

  it('re-keys unsent work under the successor, then records exactly which committed household it installed', async () => {
    const vault = new MemoryVault();
    const rekeyed: unknown[] = [];
    const destinations: string[] = [];
    const next = { successor: true } as unknown as LibraryLog;
    const log = {
      libraryId: vault.libraryId,
      keepRequired: vault.keepRequired.bind(vault),
      keptRequired: vault.keptRequired.bind(vault),
      rekeyKept: async (to: unknown) => void rekeyed.push(to),
    } as unknown as Pick<LibraryLog, 'libraryId' | 'rekeyKept' | 'keepRequired' | 'keptRequired'>;
    const adoption = new VaultResetAdoption(log, async (key) => {
      destinations.push(key);
      return next;
    });

    await expect(adoption.isAdopted(request('a'.repeat(64)))).resolves.toBe(false);
    await adoption.adopt(request('a'.repeat(64)));

    expect(destinations).toEqual([SUCCESSORS.H2]);
    expect(rekeyed).toEqual([next]);
    await expect(adoption.isAdopted(request('a'.repeat(64)))).resolves.toBe(true);
    await expect(adoption.isAdopted(request('b'.repeat(64)))).resolves.toBe(false);
  });
});
