import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import { FakeEdge, Killed } from './profileKeyResetFakeEdge';
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
const JOURNAL = 'profile-reset/v1/journal';
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

/** The real adoption over an in-memory vault, recording what was prepared and which keys were sealed again. */
class RecordingAdoption extends VaultResetAdoption {
  readonly prepared: ProfileAdoptionRequest[] = [];
  readonly rekeyed: string[];
  constructor(vault: MemoryVault) {
    const rekeyed: string[] = [];
    super(
      {
        libraryId: vault.libraryId,
        keepRequired: vault.keepRequired.bind(vault),
        keptRequired: vault.keptRequired.bind(vault),
        rekeyKept: async () => void rekeyed.push('rekeyed'),
      } as unknown as Pick<LibraryLog, 'libraryId' | 'rekeyKept' | 'keepRequired' | 'keptRequired'>,
      async (key) => ({ key }) as unknown as LibraryLog,
    );
    this.rekeyed = rekeyed;
  }
  override async adopt(request: ProfileAdoptionRequest) {
    this.prepared.push(structuredClone(request));
    return super.adopt(request);
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
  options: { gate?: boolean; pin?: string; vault?: MemoryVault; adoption?: RecordingAdoption } = {},
) {
  const vault = options.vault ?? new MemoryVault();
  const adoption = options.adoption ?? new RecordingAdoption(vault);
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
const confirm = { destinationLibraryKey: SUCCESSORS.H2 };

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

  it('retires every old library, then waits for the page to install the successor key', async () => {
    const edge = await world();
    const { service: reset, adoption, vault } = service(edge);

    await expect(reset.start(start)).resolves.toBe('install');

    for (const label of ['H', 'OWNER', 'MINA', 'LEO'])
      expect(edge.lib(label).retired).not.toBeNull();
    expect(adoption.prepared.map((request) => request.householdKey)).toEqual([SUCCESSORS.H2]);
    expect(adoption.rekeyed).toHaveLength(1);
    // The journal holds the last copy of the old and provisional keys: it stays until the page confirms.
    expect(vault.values.has(JOURNAL)).toBe(true);
    await expect(reset.resume()).resolves.toBe('install');
    expect(vault.values.has(JOURNAL)).toBe(true);
  });

  it('erases the journal only once the page confirms the successor it installed', async () => {
    const edge = await world();
    const { service: reset, vault } = service(edge);
    await reset.start(start);

    await expect(reset.confirm(confirm)).resolves.toBe('complete');

    expect(vault.values.has(JOURNAL)).toBe(false);
    // Repeating it after the journal is gone is nothing, not an error and not a second install.
    await expect(reset.confirm(confirm)).resolves.toBe('none');
    await expect(reset.resume()).resolves.toBe('none');
  });

  it('refuses to confirm a successor it cannot read back, or a different one', async () => {
    const edge = await world();
    const { service: reset, vault } = service(edge);
    await reset.start(start);

    await expect(reset.confirm({ destinationLibraryKey: keyOf(99) })).resolves.toBe('waiting');
    // The successor household the page would install is gone or holds another directory: not confirmed.
    const successor = edge.lib('H2');
    const real = successor.dir;
    successor.dir = null;
    await expect(reset.confirm(confirm)).resolves.toBe('waiting');
    successor.dir = real;
    edge.libs.delete(successor.id);
    await expect(reset.confirm(confirm)).resolves.toBe('waiting');
    expect(vault.values.has(JOURNAL)).toBe(true);
  });

  it('does not confirm before the worker has prepared the install', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    edge.faults.push({ on: 'H DELETE retire', when: 'after' });
    await service(edge, { vault })
      .service.start(start)
      .catch(() => undefined);
    edge.revive();
    // Died with the household retired but adoption not yet reached.
    await expect(service(edge, { vault }).service.confirm(confirm)).resolves.toBe('waiting');
    expect(vault.values.has(JOURNAL)).toBe(true);
  });

  it('survives a death between the page install and the confirm: the next confirm converges', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    await service(edge, { vault }).service.start(start);

    // The page installed the key, then its tab died before it told the worker. A fresh service, same vault.
    const after = service(edge, { vault });
    await expect(after.service.resume()).resolves.toBe('install');
    await expect(after.service.confirm(confirm)).resolves.toBe('complete');
    expect(vault.values.has(JOURNAL)).toBe(false);
  });

  it('survives a death between the confirm and the journal being erased', async () => {
    const edge = await world();
    const vault = new MemoryVault();
    await service(edge, { vault }).service.start(start);
    const original = vault.discardKept.bind(vault);
    vault.discardKept = async () => {
      throw new Killed();
    };
    await expect(service(edge, { vault }).service.confirm(confirm)).rejects.toBeInstanceOf(Killed);
    // The install was recorded; the journal is still there. Resuming finishes the erase and nothing else.
    vault.discardKept = original;
    const resumed = service(edge, { vault });
    await expect(resumed.service.resume()).resolves.toBe('complete');
    expect(vault.values.has(JOURNAL)).toBe(false);
    expect(resumed.adoption.prepared).toEqual([]);
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
    edge.serverErrors.set('H GET lookup', 99);
    const { service: first } = service(edge, { vault });
    await expect(first.start(start)).resolves.toBe('waiting');
    expect(vault.values.has(JOURNAL)).toBe(true);
    edge.serverErrors.clear();

    const { service: again } = service(edge, { vault });
    await expect(again.resume()).resolves.toBe('install');
    await expect(again.confirm(confirm)).resolves.toBe('complete');
    expect(vault.values.has(JOURNAL)).toBe(false);
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
      'install',
    );
    expect(adoption.prepared.map((request) => request.householdKey)).toEqual([SUCCESSORS.H2]);
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

  function adoptionOver(vault: MemoryVault) {
    const rekeyed: unknown[] = [];
    const destinations: string[] = [];
    const next = { successor: true } as unknown as LibraryLog;
    const log = {
      libraryId: vault.libraryId,
      keepRequired: vault.keepRequired.bind(vault),
      keptRequired: vault.keptRequired.bind(vault),
      rekeyKept: async (to: unknown) => void rekeyed.push(to),
    } as unknown as Pick<LibraryLog, 'libraryId' | 'rekeyKept' | 'keepRequired' | 'keptRequired'>;
    return {
      rekeyed,
      destinations,
      next,
      adoption: new VaultResetAdoption(log, async (key) => {
        destinations.push(key);
        return next;
      }),
    };
  }

  it('re-keys unsent work, prepares the install, and is adopted only once confirmed', async () => {
    const { adoption, rekeyed, destinations, next } = adoptionOver(new MemoryVault());
    const head = 'a'.repeat(64);

    await expect(adoption.isAdopted(request(head))).resolves.toBe(false);
    await expect(adoption.awaitsInstall(request(head))).resolves.toBe(false);
    await expect(adoption.confirm(request(head))).resolves.toBe(false);

    await adoption.adopt(request(head));
    expect(destinations).toEqual([SUCCESSORS.H2]);
    expect(rekeyed).toEqual([next]);
    await expect(adoption.awaitsInstall(request(head))).resolves.toBe(true);
    await expect(adoption.isAdopted(request(head))).resolves.toBe(false);

    await expect(adoption.confirm(request(head))).resolves.toBe(true);
    await expect(adoption.isAdopted(request(head))).resolves.toBe(true);
    await expect(adoption.awaitsInstall(request(head))).resolves.toBe(false);
    await expect(adoption.isAdopted(request('b'.repeat(64)))).resolves.toBe(false);
  });

  it('never un-installs a confirmed successor when it is prepared again', async () => {
    const { adoption } = adoptionOver(new MemoryVault());
    const head = 'a'.repeat(64);
    await adoption.adopt(request(head));
    await adoption.confirm(request(head));
    await adoption.adopt(request(head));
    await expect(adoption.isAdopted(request(head))).resolves.toBe(true);
  });
});
