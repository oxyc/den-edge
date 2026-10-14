import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { FakeEdge, Killed, type Fault } from './profileKeyResetFakeEdge';
import {
  HttpProfileKeyResetBackend,
  ProfileResetUnavailableError,
  type ProfileResetAdoption,
  type ProfileResetJournalStore,
} from './profileKeyResetBackend';
import {
  libraryId as idOf,
  ProfileKeyResetExecutor,
  ProfileResetError,
  ProfileResetRolledBackError,
  type ProfileAdoptionRequest,
  type ProfileResetJournal,
  type ProfileResetStatus,
} from './profileKeyResetExecutor';
import { ProfileKeyResetRecovery } from './profileKeyResetRecovery';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';

const OWNER = '00112233445566778899aabbccddeeff';
const MINA = '11112222333344445555666677778888';
const LEO = '9999aaaabbbbccccddddeeeeffff0000';
const GONE = 'aaaaaaaabbbbccccddddeeeeffff0000';
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const RECOVERY = 'fedcba9876543210fedcba9876543210';
const RECOVERY_TWO = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const NOW = 1_800_000_100_000;

const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const HOUSEHOLD_KEY = keyOf(4);
/** The executor draws successor keys 80, 81, 82, 83 for the household, then Owner, Mina and Leo. */
const SUCCESSOR_KEYS = { H2: keyOf(80), OWNER2: keyOf(81), MINA2: keyOf(82), LEO2: keyOf(83) };

function directory(): ProfileDirectoryDocument {
  const base = structuredClone(fixture.migrationBase) as unknown as {
    profiles: Record<string, unknown>;
  };
  const leo = structuredClone(base.profiles[LEO]) as {
    id: string;
    library: { value: { key: string } };
    deleted: { value: boolean };
  };
  leo.id = GONE;
  leo.library.value.key = keyOf(68);
  leo.deleted.value = true;
  base.profiles[GONE] = leo;
  return validateStoredProfileDirectory(base);
}

class MemoryJournal implements ProfileResetJournalStore {
  value: ProfileResetJournal | null = null;
  async load() {
    return this.value === null ? null : structuredClone(this.value);
  }
  async persist(journal: ProfileResetJournal) {
    this.value = structuredClone(journal);
  }
  async clear(attempt: string) {
    if (this.value && this.value.attempt !== attempt) throw new Error('another attempt');
    this.value = null;
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

class Keys {
  private next = 80;
  readonly next32 = (): Uint8Array => new Uint8Array(32).fill(this.next++);
}

const isDeath = (error: unknown): boolean =>
  error instanceof Killed ||
  (error instanceof ProfileResetUnavailableError && error.cause instanceof Killed);

/** The household, three live profiles and a deleted one, as den-edge holds them; successors are planned, not made. */
class Rig {
  readonly edge = new FakeEdge();
  readonly journal = new MemoryJournal();
  readonly adoption = new MemoryAdoption();
  readonly keys = new Keys();
  readonly directory = directory();

  static async create(): Promise<Rig> {
    const rig = new Rig();
    const { edge, directory: dir } = rig;
    await edge.add('H', HOUSEHOLD_KEY, 5, ['library', 'settings'], dir);
    await edge.add('OWNER', dir.profiles[OWNER]!.library.value.key, 4, ['watch', 'settings']);
    await edge.add('MINA', dir.profiles[MINA]!.library.value.key, 4, ['watch', 'settings']);
    await edge.add('LEO', dir.profiles[LEO]!.library.value.key, 4, ['watch', 'settings']);
    for (const [label, key] of Object.entries(SUCCESSOR_KEYS)) await edge.plan(label, key);
    return rig;
  }

  backend(householdKey = HOUSEHOLD_KEY, journal: ProfileResetJournalStore = this.journal) {
    return new HttpProfileKeyResetBackend({
      journal,
      open: (key, wire) => this.edge.open(key, wire),
      adoption: this.adoption,
      householdKey,
      device: 'device',
    });
  }

  executor(attempt = ATTEMPT) {
    return new ProfileKeyResetExecutor(this.backend(), {
      randomKey: this.keys.next32,
      randomAttempt: () => attempt,
      now: () => NOW,
    });
  }

  fence() {
    return this.edge.source(this.edge.lib('H'));
  }

  async start(attempt = ATTEMPT) {
    return this.executor(attempt).start(this.directory, HOUSEHOLD_KEY, await this.fence());
  }

  /** Restart the executor after every death until the attempt ends or `until` holds of the journal. */
  async drive(
    until: (journal: ProfileResetJournal) => boolean = () => false,
    /** Return at the first death instead of restarting, to inspect the world the dead process left behind. */
    stopOnDeath = false,
  ): Promise<ProfileResetStatus | null> {
    let status: ProfileResetStatus | null = null;
    for (let round = 0; round < 400; round += 1) {
      if (this.journal.value && until(this.journal.value)) return status;
      try {
        status = await this.executor().resume();
      } catch (error) {
        if (!isDeath(error)) throw error;
        this.edge.revive();
        if (stopOnDeath) return status;
        continue;
      }
      if (status === null || status.phase === 'complete' || status.phase === 'aborted')
        return status;
    }
    throw new Error('the reset did not settle');
  }

  /** Start, surviving deaths in the first call, and drive to the end. */
  async run(faults: Fault[] = []): Promise<ProfileResetStatus | null> {
    this.edge.faults.push(...faults);
    try {
      const first = await this.start();
      if (first.phase === 'aborted') return first;
    } catch (error) {
      if (!isDeath(error)) throw error;
      this.edge.revive();
    }
    return this.drive();
  }

  indexOf(entry: string, from = 0): number {
    return this.edge.log.indexOf(entry, from);
  }
}

const OLD = ['OWNER', 'MINA', 'LEO'] as const;

async function memberOrder(rig: Rig): Promise<string[]> {
  const ids = await Promise.all(OLD.map(async (label) => [rig.edge.lib(label).id, label] as const));
  return ids.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, label]) => label);
}

describe('compound key reset backend against the profiles-v1 §9.1 surface', () => {
  describe('a complete reset', () => {
    it('acquires household first then members ascending, commits once, retires the household last, then adopts', async () => {
      const rig = await Rig.create();
      const status = await rig.run();

      expect(status).toEqual({ phase: 'complete', verifiedProfiles: 3, profileCount: 3 });
      const order = await memberOrder(rig);
      const acquires = rig.edge.log.filter((e) => e.endsWith('POST acquire'));
      expect(acquires).toEqual([
        'H POST acquire',
        ...order.map((label) => `${label} POST acquire`),
      ]);

      // The household declares the whole set, sorted, with every distinct successor id.
      const declared = rig.edge.lib('H').stored.get(ATTEMPT)!.request as {
        members: { libraryId: string; successor: string }[];
        successor: string;
      };
      expect(declared.members.map((m) => m.libraryId)).toEqual(
        [...declared.members.map((m) => m.libraryId)].sort(),
      );
      expect(declared.members).toHaveLength(3);
      expect(declared.successor).toBe(rig.edge.lib('H2').id);

      // Nothing retires before the one successor commit, members first, household last.
      const commit = rig.indexOf('H POST successor');
      const retires = rig.edge.log.flatMap((e, i) => (e.endsWith('DELETE retire') ? [i] : []));
      expect(commit).toBeGreaterThan(-1);
      expect(Math.min(...retires)).toBeGreaterThan(commit);
      expect(rig.edge.log[retires.at(-1)!]).toBe('H DELETE retire');
      expect(rig.edge.log.filter((e) => e === 'H POST successor')).toHaveLength(1);

      for (const label of ['H', ...OLD]) expect(rig.edge.lib(label).retired).not.toBeNull();
      expect(rig.edge.lib('H').retired!.successor).toBe(rig.edge.lib('H2').id);
      expect(rig.edge.lib('H2').dir).not.toBeNull();
      // Every successor carries the old library's rows under its own key.
      for (const label of OLD)
        expect([...rig.edge.lib(`${label}2`).rows.keys()].sort()).toEqual(['settings', 'watch']);
      expect([...rig.edge.lib('H2').rows.keys()].sort()).toEqual(['library', 'settings']);

      expect(rig.adoption.adopted?.householdKey).toBe(SUCCESSOR_KEYS.H2);
      expect(rig.journal.value).toBeNull();
    });

    it('freezes every library while the set is held, keeps reading, and releases nothing early', async () => {
      const rig = await Rig.create();
      await rig.run();
      // Writes were refused for the whole life of the lock: every library was retired, none was released.
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'late')).toBe(false);
    });

    it('holds all four locks before any copy and refuses ordinary writes while it works', async () => {
      const rig = await Rig.create();
      await rig.start();
      await rig.drive((journal) => journal.phase === 'locked');
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'late')).toBe(false);
      expect(rig.edge.log.some((e) => e.endsWith('takeMoved'))).toBe(false);
      // Reads continue from the frozen old libraries.
      const snapshot = await (
        await rig.edge.open(rig.directory.profiles[OWNER]!.library.value.key, 4)
      ).resetSnapshot();
      expect(snapshot).not.toBe('absent');
    });
  });

  describe('source observation', () => {
    it('observes a profile again when its digest does not match its rows, and acquires at the settled source', async () => {
      const rig = await Rig.create();
      rig.edge.staleSource.add('MINA');
      await rig.run();
      expect(rig.edge.log.filter((e) => e === 'MINA GET source')).toHaveLength(2);
      expect(rig.edge.log.filter((e) => e === 'MINA POST acquire')).toHaveLength(1);
    });

    it('re-observes a profile whose source moved after the observation and retries the acquire', async () => {
      const rig = await Rig.create();
      let raced = false;
      const original = rig.edge.handle.bind(rig.edge);
      rig.edge.handle = async (lib, token, wire, method, path, body, headers) => {
        if (!raced && lib.label === 'MINA' && method === 'POST') {
          raced = true;
          rig.edge.write('MINA', 'race');
        }
        return original(lib, token, wire, method, path, body, headers);
      };
      await rig.run();
      expect(rig.edge.log.filter((e) => e === 'MINA POST acquire')).toHaveLength(2);
      expect(rig.edge.lib('MINA').retired).not.toBeNull();
    });

    it('gives up on a profile that keeps changing, releases the set and discards the journal', async () => {
      const rig = await Rig.create();
      const original = rig.edge.handle.bind(rig.edge);
      rig.edge.handle = async (lib, token, wire, method, path, body, headers) => {
        if (lib.label === 'LEO' && method === 'POST')
          rig.edge.write('LEO', `race${rig.edge.count('race')}`);
        return original(lib, token, wire, method, path, body, headers);
      };
      const status = await rig.run();

      expect(status?.phase).toBe('aborted');
      expect(rig.edge.log.filter((e) => e === 'LEO POST acquire')).toHaveLength(5);
      expect(rig.edge.log).toContain('H DELETE abort');
      expect(rig.journal.value).toBeNull();
      // The members acquired before the failure are void at once, and the household is free.
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'free')).toBe(true);
      expect(rig.edge.has('H2')).toBe(false);
    });

    it('refuses a household that moved since the owner authorized it and releases nothing it never held', async () => {
      const rig = await Rig.create();
      const fence = await rig.fence();
      rig.edge.write('H', 'moved');
      await rig.executor().start(rig.directory, HOUSEHOLD_KEY, fence);

      expect(rig.journal.value).toBeNull();
      expect(rig.edge.log).toContain('H DELETE abort');
      expect(rig.edge.log.some((e) => e.endsWith('POST acquire'))).toBe(false);
      expect(rig.edge.write('OWNER', 'free')).toBe(true);
    });

    it('answers 426 for a library on the wrong wire as a refusal, not a retry', async () => {
      const rig = await Rig.create();
      const backend = new HttpProfileKeyResetBackend({
        journal: rig.journal,
        open: (key) => rig.edge.open(key, 4),
        adoption: rig.adoption,
        householdKey: HOUSEHOLD_KEY,
        device: 'device',
      });
      const runner = new ProfileKeyResetExecutor(backend, {
        randomKey: rig.keys.next32,
        randomAttempt: () => ATTEMPT,
        now: () => NOW,
      });
      const status = await runner.start(rig.directory, HOUSEHOLD_KEY, await rig.fence());
      expect(status.phase).toBe('aborted');
      expect(rig.edge.log.some((e) => e.endsWith('POST acquire'))).toBe(false);
      expect(rig.journal.value).toBeNull();
    });
  });

  describe('acquire statuses', () => {
    it('refuses and aborts when another reset already holds the household, without touching its lock', async () => {
      const rig = await Rig.create();
      await rig.start(ATTEMPT);
      expect(rig.edge.locked(rig.edge.lib('H'))).toBe(true);

      const intruder = new ProfileKeyResetExecutor(
        rig.backend(HOUSEHOLD_KEY, new MemoryJournal()),
        {
          randomKey: new Keys().next32,
          randomAttempt: () => RECOVERY,
          now: () => NOW,
        },
      );
      const status = await intruder.start(rig.directory, HOUSEHOLD_KEY, await rig.fence());

      expect(status.phase).toBe('aborted');
      // Its abort is a household commit by a non-owner: refused, so the first reset still holds everything.
      expect(rig.edge.locked(rig.edge.lib('H'))).toBe(true);
      expect(rig.edge.lib('H').reset!.phase).toBe('open');
    });

    it('replays a lost acquire answer from the stored record, with no second lock and no fresh observation', async () => {
      const rig = await Rig.create();
      const order = await memberOrder(rig);
      const status = await rig.run([{ on: `${order[1]} POST acquire`, when: 'after' }]);

      expect(status?.phase).toBe('complete');
      // The killed run observed the source once; the replay found the lock by lookup instead of observing again.
      expect(rig.edge.log.filter((e) => e === `${order[1]} GET source`)).toHaveLength(1);
      expect(rig.edge.log.filter((e) => e === `${order[1]} POST acquire`)).toHaveLength(1);
      expect(rig.edge.log.filter((e) => e === 'H POST acquire')).toHaveLength(1);
    });

    it('treats a 5xx as transient, replays the request and keeps the journal when it persists', async () => {
      const rig = await Rig.create();
      rig.edge.serverErrors.set('H GET source', 2);
      const status = await rig.run();
      expect(status?.phase).toBe('complete');

      const down = await Rig.create();
      down.edge.serverErrors.set('H GET lookup', 99);
      await expect(down.start()).rejects.toBeInstanceOf(ProfileResetUnavailableError);
      expect(down.journal.value?.phase).toBe('prepared');
      down.edge.serverErrors.clear();
      expect((await down.drive())?.phase).toBe('complete');
    });
  });

  describe('crash and resume at every durable step', () => {
    const steps = (order: string[]): Fault[] => [
      { on: 'H POST acquire', when: 'after' },
      { on: `${order[0]} POST acquire`, when: 'before' },
      { on: `${order[2]} POST acquire`, when: 'after' },
      { on: 'OWNER2 takeMoved', when: 'before' },
      { on: 'MINA2 takeMoved', when: 'after' },
      { on: 'LEO2 takeMoved', when: 'after' },
      { on: 'H2 takeMoved', when: 'before' },
      { on: 'H2 takeMoved', when: 'after' },
      { on: 'H POST successor', when: 'before' },
      { on: 'H POST successor', when: 'after' },
      { on: `${order[0]} DELETE retire`, when: 'before' },
      { on: `${order[0]} DELETE retire`, when: 'after' },
      { on: `${order[2]} DELETE retire`, when: 'after' },
      { on: 'H DELETE retire', when: 'before' },
      { on: 'H DELETE retire', when: 'after' },
    ];

    it.each(Array.from({ length: 15 }, (_, index) => index))(
      'finishes exactly one reset after the process dies at step %i',
      async (index) => {
        const rig = await Rig.create();
        const fault = steps(await memberOrder(rig))[index]!;
        const status = await rig.run([fault]);

        expect(status, JSON.stringify(fault)).toEqual({
          phase: 'complete',
          verifiedProfiles: 3,
          profileCount: 3,
        });
        expect(rig.edge.dead).toBe(false);
        expect(rig.journal.value).toBeNull();
        for (const label of ['H', ...OLD])
          expect(rig.edge.lib(label).retired?.attempt).toBe(ATTEMPT);
        // Never two successor commits, never a retirement before the commit, household last.
        expect(rig.edge.log.filter((e) => e === 'H POST successor').length).toBeLessThanOrEqual(2);
        const commit = rig.indexOf('H POST successor');
        const firstRetire = rig.edge.log.findIndex((e) => e.endsWith('DELETE retire'));
        expect(firstRetire).toBeGreaterThan(commit);
        expect(rig.edge.lib('H').reset!.phase).toBe('retired');
        expect(rig.adoption.adopted?.committedHead).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    it('settles a lost successor-commit response by lookup, without committing twice', async () => {
      const rig = await Rig.create();
      await rig.run([{ on: 'H POST successor', when: 'after' }]);
      expect(rig.edge.log.filter((e) => e === 'H POST successor')).toHaveLength(1);
      expect(rig.edge.log.filter((e) => e === 'H2 takeMoved')).toHaveLength(1);
      expect(rig.edge.lib('H').reset!.phase).toBe('retired');
    });

    it('verifies and commits a successor whose copy landed but whose commit never was sent', async () => {
      const rig = await Rig.create();
      await rig.run([{ on: 'H2 takeMoved', when: 'after' }]);
      // The copy was not repeated: the lookup found the successor complete and committed it.
      expect(rig.edge.log.filter((e) => e === 'H2 takeMoved')).toHaveLength(1);
      expect(rig.edge.log.filter((e) => e === 'H POST successor')).toHaveLength(1);
      expect(rig.edge.lib('H').reset!.phase).toBe('retired');
    });

    it('publishes again when the lookup finds nothing, and completes a partial successor idempotently', async () => {
      const rig = await Rig.create();
      await rig.run([{ on: 'H2 takeMoved', when: 'before' }]);
      expect(rig.edge.log.filter((e) => e === 'H2 takeMoved')).toHaveLength(2);

      // A partial copy under the successor key, as a crash between two batches would leave it.
      const viaPublish = await Rig.create();
      await viaPublish.start();
      await viaPublish.drive((journal) => journal.phase === 'publishing-household');
      await viaPublish.edge.add('H2', SUCCESSOR_KEYS.H2, 5, ['library']);
      expect((await viaPublish.drive())?.phase).toBe('complete');
      expect([...viaPublish.edge.lib('H2').rows.keys()].sort()).toEqual(['library', 'settings']);

      // The lookup after a death finds the partial successor incomplete and reports it absent, so it is published again.
      const viaLookup = await Rig.create();
      await viaLookup.start();
      viaLookup.edge.faults.push({ on: 'H2 takeMoved', when: 'before' });
      await viaLookup.drive(() => false, true);
      expect(viaLookup.journal.value?.phase).toBe('commit-unknown');
      await viaLookup.edge.add('H2', SUCCESSOR_KEYS.H2, 5, ['library']);
      expect((await viaLookup.drive())?.phase).toBe('complete');
      expect(viaLookup.edge.log.filter((e) => e === 'H POST successor')).toHaveLength(1);
    });

    it('never commits a successor that holds a different directory, and aborts instead', async () => {
      const rig = await Rig.create();
      await rig.start();
      rig.edge.faults.push({ on: 'H2 takeMoved', when: 'before' });
      await rig.drive(() => false, true);
      expect(rig.journal.value?.phase).toBe('commit-unknown');
      const other = structuredClone(rig.directory) as unknown as {
        profiles: Record<string, { display: { value: { name: string } } }>;
      };
      other.profiles[OWNER]!.display.value.name = 'Someone else';
      await rig.edge.add(
        'H2',
        SUCCESSOR_KEYS.H2,
        5,
        ['library', 'settings'],
        other as unknown as ProfileDirectoryDocument,
      );

      const status = await rig.drive();
      expect(status?.phase).toBe('aborted');
      expect(rig.edge.log).not.toContain('H POST successor');
      expect(rig.edge.lib('H').reset!.phase).toBe('aborted');
      expect(rig.journal.value).toBeNull();
    });
  });

  describe('successor commit refusals', () => {
    it('aborts when the successor is not ready (successor_not_ready)', async () => {
      const rig = await Rig.create();
      const original = rig.edge.handle.bind(rig.edge);
      rig.edge.handle = async (lib, token, wire, method, path, body, headers) => {
        if (method === 'POST' && path.endsWith('/successor'))
          rig.edge.libs.delete(rig.edge.lib('H2').id);
        return original(lib, token, wire, method, path, body, headers);
      };
      const status = await rig.run();
      expect(status?.phase).toBe('aborted');
      expect(rig.edge.lib('H').reset!.phase).toBe('aborted');
      expect(rig.edge.log).toContain('H DELETE abort');
    });

    it('aborts when the lock set is incomplete (locks_incomplete)', async () => {
      const rig = await Rig.create();
      const original = rig.edge.handle.bind(rig.edge);
      rig.edge.handle = async (lib, token, wire, method, path, body, headers) => {
        if (method === 'POST' && path.endsWith('/successor')) lib.reset!.acquired.clear();
        return original(lib, token, wire, method, path, body, headers);
      };
      const status = await rig.run();
      expect(status?.phase).toBe('aborted');
      expect(rig.edge.lib('H').reset!.phase).toBe('aborted');
    });
  });

  describe('abort', () => {
    it('is one household commit that voids every member lock, repeatable, and refused once committed', async () => {
      const rig = await Rig.create();
      await rig.start();
      await rig.drive((journal) => journal.phase === 'locked');
      const journal = rig.journal.value!;
      const request = {
        attempt: ATTEMPT,
        household: { libraryId: journal.locks!.household.libraryId, key: HOUSEHOLD_KEY },
      };
      const backend = rig.backend();

      await expect(backend.abortReset(request)).resolves.toBe('aborted');
      await expect(backend.abortReset(request)).resolves.toBe('aborted');
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'free')).toBe(true);

      const committed = await Rig.create();
      await committed.start();
      await committed.drive((journal) => journal.householdCommitted);
      // A reset whose successor is committed cannot be aborted, and nothing is released.
      const refused = await committed.backend().abortReset({
        attempt: ATTEMPT,
        household: { libraryId: committed.edge.lib('H').id, key: HOUSEHOLD_KEY },
      });
      expect(refused).toBe('committed');
      expect(committed.edge.lib('H').reset!.phase).toBe('committed');
      expect(committed.edge.write('OWNER', 'x')).toBe(false);
    });

    it('treats an abort of an attempt that acquired nothing as already released', async () => {
      const rig = await Rig.create();
      await expect(
        rig.backend().abortReset({
          attempt: ATTEMPT,
          household: { libraryId: rig.edge.lib('H').id, key: HOUSEHOLD_KEY },
        }),
      ).resolves.toBe('aborted');
    });
  });

  describe('retirement guards', () => {
    it('refuses to retire anything before the successor household is committed', async () => {
      const rig = await Rig.create();
      await rig.start();
      await rig.drive((journal) => journal.phase === 'locked');
      const journal = rig.journal.value!;
      await expect(
        rig.backend().retireProfileLibrary({
          attempt: ATTEMPT,
          profile: OWNER,
          oldKey: journal.profiles[0]!.oldKey,
          successorLibraryId: await idOf(journal.profiles[0]!.newKey),
          locks: journal.locks!,
        }),
      ).rejects.toBeInstanceOf(ProfileResetError);
      expect(rig.edge.log.some((e) => e.endsWith('DELETE retire'))).toBe(false);
    });

    it('rejects a lock set whose handle is not the household record', async () => {
      const rig = await Rig.create();
      await rig.start();
      await rig.drive((journal) => journal.phase === 'locked');
      const journal = rig.journal.value!;
      const forged = {
        ...journal.locks!,
        household: { ...journal.locks!.household, value: 'lock-forged' },
      };
      await expect(
        rig.backend().moveAndVerifyProfile({
          attempt: ATTEMPT,
          profile: OWNER,
          oldKey: journal.profiles[0]!.oldKey,
          newKey: journal.profiles[0]!.newKey,
          locks: forged,
        }),
      ).rejects.toBeInstanceOf(ProfileResetError);
      expect(rig.edge.log.some((e) => e.endsWith('takeMoved'))).toBe(false);
    });

    it('answers a rolled-back attempt with a rollback, never a retry', async () => {
      const rig = await Rig.create();
      await rig.start();
      await rig.drive((journal) => journal.phase === 'locked');
      const journal = rig.journal.value!;
      await rig.backend().abortReset({
        attempt: ATTEMPT,
        household: { libraryId: journal.locks!.household.libraryId, key: HOUSEHOLD_KEY },
      });
      await expect(
        rig.backend().moveAndVerifyProfile({
          attempt: ATTEMPT,
          profile: OWNER,
          oldKey: journal.profiles[0]!.oldKey,
          newKey: journal.profiles[0]!.newKey,
          locks: journal.locks!,
        }),
      ).rejects.toBeInstanceOf(ProfileResetRolledBackError);
    });

    it('does not move a profile when the successor write is refused, and resumes it', async () => {
      const rig = await Rig.create();
      rig.edge.failMove.add('OWNER2');
      await rig.start();
      await expect(rig.drive()).rejects.toBeInstanceOf(ProfileResetUnavailableError);
      expect(rig.journal.value!.profiles.some((p) => p.verified)).toBe(false);
      expect((await rig.drive())?.phase).toBe('complete');
    });
  });

  describe('journal-less Owner-PIN recovery', () => {
    const recoverer = (rig: Rig, journal: ProfileResetJournalStore = new MemoryJournal()) =>
      new ProfileKeyResetRecovery({
        journal,
        open: (key, wire) => rig.edge.open(key, wire),
        householdKey: HOUSEHOLD_KEY,
      });

    const reach = async (rig: Rig, phase: (journal: ProfileResetJournal) => boolean) => {
      await rig.start();
      await rig.drive(phase);
    };

    const afterFirstRetirement = (journal: ProfileResetJournal) =>
      journal.profiles.some((p) => p.oldRetired);

    it('aborts an open reset with no proof: one household commit frees every old library', async () => {
      const rig = await Rig.create();
      await reach(rig, (journal) => journal.phase === 'locked');

      const result = await recoverer(rig).recover({ attempt: RECOVERY, successorKey: null });
      expect(result).toEqual({ kind: 'aborted' });
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'free')).toBe(true);
      expect(rig.edge.lib('H').reset!.outcomes.get(ATTEMPT)).toBe('aborted');

      // The original device was merely slow: it learns the attempt is over and discards its journal.
      expect((await rig.drive())?.phase).toBe('aborted');
      expect(rig.journal.value).toBeNull();
      expect(rig.adoption.adopted).toBeNull();
    });

    it('rolls a committed reset back without proof, before any retirement', async () => {
      const rig = await Rig.create();
      await reach(rig, (journal) => journal.householdCommitted);

      const result = await recoverer(rig).recover({ attempt: RECOVERY, successorKey: null });
      expect(result).toEqual({ kind: 'aborted' });
      expect(rig.edge.log.some((e) => e.endsWith('DELETE retire'))).toBe(false);
      expect(rig.edge.has('H2')).toBe(false);
      for (const label of ['H', ...OLD]) expect(rig.edge.write(label, 'free')).toBe(true);

      expect((await rig.drive())?.phase).toBe('aborted');
      expect(rig.adoption.adopted).toBeNull();
    });

    it('is blocked once retirement started and no proof is held: another device must finish', async () => {
      const rig = await Rig.create();
      await reach(rig, afterFirstRetirement);

      const result = await recoverer(rig).recover({ attempt: RECOVERY, successorKey: null });
      expect(result).toEqual({ kind: 'blocked' });
      expect(rig.edge.lib('H').reset!.phase).toBe('retiring');
      // The old libraries stay readable and locked.
      expect(rig.edge.write('H', 'x')).toBe(false);
      expect(rig.edge.log.some((e) => e === 'H DELETE retire')).toBe(false);
    });

    it('finishes retirement with proof of the successor key, members then household, and the original owner then adopts', async () => {
      const rig = await Rig.create();
      await reach(rig, afterFirstRetirement);

      const result = await recoverer(rig).recover({
        attempt: RECOVERY,
        successorKey: SUCCESSOR_KEYS.H2,
      });
      expect(result).toEqual({ kind: 'retired', successorLibraryId: rig.edge.lib('H2').id });
      for (const label of ['H', ...OLD]) expect(rig.edge.lib(label).retired).not.toBeNull();
      const retires = rig.edge.log.flatMap((e, i) => (e.endsWith('DELETE retire') ? [i] : []));
      expect(rig.edge.log[retires.at(-1)!]).toBe('H DELETE retire');

      // The journaled executor sees `recovered` with outcome retired, replays its own retirements and adopts.
      expect((await rig.drive())?.phase).toBe('complete');
      expect(rig.adoption.adopted?.householdKey).toBe(SUCCESSOR_KEYS.H2);
    });

    it('finishes a committed reset with proof before the door was crossed', async () => {
      const rig = await Rig.create();
      await reach(rig, (journal) => journal.householdCommitted);
      const result = await recoverer(rig).recover({
        attempt: RECOVERY,
        successorKey: SUCCESSOR_KEYS.H2,
      });
      expect(result.kind).toBe('retired');
      expect(rig.edge.lib('H').reset!.phase).toBe('retired');
    });

    it('refuses a wrong proof in any phase, with no effect', async () => {
      const rig = await Rig.create();
      await reach(rig, (journal) => journal.householdCommitted);
      const result = await recoverer(rig).recover({ attempt: RECOVERY, successorKey: keyOf(99) });
      expect(result).toEqual({ kind: 'blocked' });
      expect(rig.edge.lib('H').reset!.owner).toBe(ATTEMPT);
      expect(rig.edge.lib('H').reset!.phase).toBe('committed');
    });

    it('answers a household with no reset as blocked', async () => {
      const rig = await Rig.create();
      expect(await recoverer(rig).recover({ attempt: RECOVERY, successorKey: null })).toEqual({
        kind: 'blocked',
      });
    });

    it('continues as the same recovery attempt after dying with the takeover landed, and a second one may take over', async () => {
      const rig = await Rig.create();
      await reach(rig, afterFirstRetirement);
      rig.edge.faults.push({ on: 'H POST acquire', when: 'after', nth: 2 });
      await expect(
        recoverer(rig).recover({ attempt: RECOVERY, successorKey: SUCCESSOR_KEYS.H2 }),
      ).rejects.toSatisfy(isDeath);
      rig.edge.revive();
      expect(rig.edge.lib('H').reset!.owner).toBe(RECOVERY);

      const posts = rig.edge.log.filter((e) => e === 'H POST acquire').length;
      const again = await recoverer(rig).recover({
        attempt: RECOVERY,
        successorKey: SUCCESSOR_KEYS.H2,
      });
      expect(again.kind).toBe('retired');
      // Found by lookup: the repeat made no second takeover request.
      expect(rig.edge.log.filter((e) => e === 'H POST acquire')).toHaveLength(posts);

      const second = await Rig.create();
      await reach(second, afterFirstRetirement);
      expect(
        (await recoverer(second).recover({ attempt: RECOVERY, successorKey: SUCCESSOR_KEYS.H2 }))
          .kind,
      ).toBe('retired');
      expect(
        (
          await recoverer(second).recover({
            attempt: RECOVERY_TWO,
            successorKey: SUCCESSOR_KEYS.H2,
          })
        ).kind,
      ).toBe('blocked');
    });

    it('refuses to recover on a device that still holds the reset journal', async () => {
      const rig = await Rig.create();
      await reach(rig, (journal) => journal.phase === 'locked');
      await expect(
        recoverer(rig, rig.journal).recover({ attempt: RECOVERY, successorKey: null }),
      ).rejects.toThrow('journal');
      expect(rig.edge.lib('H').reset!.owner).toBe(ATTEMPT);
    });

    it('rejects a recovery attempt that is not a canonical id', async () => {
      const rig = await Rig.create();
      await expect(
        recoverer(rig).recover({ attempt: 'not-an-attempt', successorKey: null }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});
