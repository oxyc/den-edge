import { describe, expect, it, vi } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import {
  ProfileKeyResetExecutor,
  ProfileResetError,
  ProfileResetRefusedError,
  ProfileResetRolledBackError,
  VaultProfileResetJournal,
  type ProfileResetAbortRequest,
  type HouseholdObservation,
  type HouseholdObservationRequest,
  type HouseholdPublishRequest,
  type HouseholdRetirementRequest,
  type ProfileAdoptionRequest,
  type ProfileKeyResetBackend,
  type ProfileMoveRequest,
  type ProfileResetJournal,
  type ProfileResetLockRequest,
  type ProfileResetLockSet,
  type ProfileResetStatus,
  type ProfileRetirementRequest,
  type VerifiedProfileMove,
} from './profileKeyResetExecutor';
import type { ProfileKidCreateVault } from './profileKidCreateWorker';
import { profilesMaterialize, profilesMerge } from './profileMigrationCore';
import { compareStamps, deriveKeys } from './wire';

const OWNER = '00112233445566778899aabbccddeeff';
const MINA = '11112222333344445555666677778888';
const LEO = '9999aaaabbbbccccddddeeeeffff0000';
const GONE = 'aaaaaaaabbbbccccddddeeeeffff0000';
const LIVE = [OWNER, MINA, LEO];
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const FENCE = { generation: 14, head: 'd'.repeat(64) };
const HOUSEHOLD_KEY = keyOf(4);
const NOW = 1_800_000_100_000;

function keyOf(byte: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
}

// A library id is a pure function of its key, and the crash-at-every-step loops resume the executor thousands of
// times over the same few keys (about 4,800 HKDF round trips through the WebCrypto thread pool in one test, which
// is idle waiting that stretches several-fold when the whole suite runs at once). The executor's derivation is
// memoised here; `idOf` below still derives each distinct key independently with the real `deriveKeys`, and every
// id the executor produces is compared against it.
vi.mock('./wire', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wire')>();
  const memo = new Map<string, Promise<string>>();
  return {
    ...actual,
    deriveLibraryId: (key: Uint8Array<ArrayBuffer>) => {
      const spelling = String.fromCharCode(...key);
      let id = memo.get(spelling);
      if (!id) memo.set(spelling, (id = actual.deriveLibraryId(key.slice())));
      return id;
    },
  };
});

const ids = new Map<string, Promise<string>>();

function idOf(key: string): Promise<string> {
  let id = ids.get(key);
  if (!id) {
    const raw = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
    id = deriveKeys(raw).then((keys) => keys.id);
    ids.set(key, id);
  }
  return id;
}

/** Owner and two Kids, plus a deleted Kid that must never be moved. */
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

class Killed extends Error {}
class Unavailable extends Error {}

type Operation = 'lock' | 'move' | 'publish' | 'retireProfile' | 'retireHousehold' | 'adopt';

interface FaultPlan {
  /** The effect lands, then the process dies before its response is seen. */
  readonly killAfter?: readonly Operation[];
  /** The process dies before the effect lands. */
  readonly killBefore?: readonly Operation[];
  readonly unavailableProfile?: string;
  /** den-edge refuses this operation for good (a moved source, a held lock, a successor that is not ready). */
  readonly refuse?: Operation;
  /** den-edge says the attempt is over (an abort or a recovery's rollback) when this operation is tried. */
  readonly rolledBack?: Operation;
  readonly observeUnknown?: number;
  readonly ignoreAdoptOnce?: boolean;
  /** Sabotage the backend's answers. */
  readonly lie?: 'successor-id' | 'copy-head' | 'household-id' | 'household-directory';
}

/** An in-memory den-edge plus secure storage, keeping every durable fact a restart could rely on. */
class FakeBackend implements ProfileKeyResetBackend {
  journal: ProfileResetJournal | null = null;
  readonly events: string[] = [];
  readonly moved = new Set<string>();
  readonly retiredProfiles = new Set<string>();
  retiredHousehold = false;
  published: HouseholdPublishRequest | null = null;
  publishAttempts = 0;
  adopted: ProfileAdoptionRequest | null = null;
  adoptCalls = 0;
  journalCleared = false;
  intentWasDurable = true;
  lockRequests: ProfileResetLockRequest[] = [];
  moveRequests: ProfileMoveRequest[] = [];
  persists = 0;
  /** 1-based persist number that stores the journal and then dies. */
  killAfterPersist: number | null = null;
  /** 1-based persist number that dies before anything is stored. */
  losePersist: number | null = null;
  private acquired: ProfileResetLockSet | null = null;
  private fail: Set<Operation>;
  private failBefore: Set<Operation>;
  private unknownObservations: number;
  private ignoreAdopt: boolean;

  constructor(
    private readonly plan: FaultPlan = {},
    private readonly lockOverride?: (locks: ProfileResetLockSet) => ProfileResetLockSet,
    /** When present the vault, not memory, is the durable journal. */
    private readonly store?: VaultProfileResetJournal,
  ) {
    this.fail = new Set(plan.killAfter);
    this.failBefore = new Set(plan.killBefore);
    this.unknownObservations = plan.observeUnknown ?? 0;
    this.ignoreAdopt = plan.ignoreAdoptOnce ?? false;
  }

  async loadJournal() {
    if (this.store) return this.store.load();
    return this.journal === null ? null : structuredClone(this.journal);
  }

  async persistJournal(journal: ProfileResetJournal) {
    this.persists += 1;
    if (this.losePersist === this.persists) {
      this.losePersist = null;
      throw new Killed();
    }
    this.journal = structuredClone(journal);
    await this.store?.persist(journal);
    this.journalCleared = false;
    if (this.killAfterPersist === this.persists) {
      this.killAfterPersist = null;
      throw new Killed();
    }
  }

  /** What `abortReset` answers; `committed` means den-edge refused because the successor is committed. */
  abortAnswer: 'aborted' | 'committed' = 'aborted';
  abortCalls: ProfileResetAbortRequest[] = [];
  /** The journal may be erased without an adoption only after den-edge ended the attempt. */
  private ended = false;

  /** The abort lands, then the process dies before its response is seen. */
  loseAbortResponse = false;

  async abortReset(request: ProfileResetAbortRequest) {
    this.abortCalls.push(structuredClone(request));
    this.events.push('abort');
    if (this.loseAbortResponse) {
      this.loseAbortResponse = false;
      throw new Killed();
    }
    if (this.abortAnswer === 'aborted') this.ended = true;
    return this.abortAnswer;
  }

  async clearJournal(attempt: string) {
    if (this.journal?.attempt !== attempt || (this.adopted === null && !this.ended))
      throw new Unavailable();
    await this.store?.clear(attempt);
    this.journal = null;
    this.journalCleared = true;
    this.events.push('clear-journal');
  }

  async acquireLocks(request: ProfileResetLockRequest) {
    this.intentWasDurable &&= this.journal?.phase === 'prepared';
    this.lockRequests.push(structuredClone(request));
    this.events.push('lock');
    this.dieBefore('lock');
    // The same attempt re-acquires the locks it already holds; nothing else may.
    this.acquired ??= {
      attempt: request.attempt,
      household: { libraryId: request.household.libraryId, value: 'lock-household' },
      profiles: Object.fromEntries(
        Object.entries(request.profiles).map(([id, library]) => [
          id,
          { libraryId: library.libraryId, value: `lock-${id}` },
        ]),
      ),
    };
    const locks = this.lockOverride ? this.lockOverride(this.acquired) : this.acquired;
    this.dieAfter('lock');
    return structuredClone(locks);
  }

  async moveAndVerifyProfile(request: ProfileMoveRequest): Promise<VerifiedProfileMove> {
    this.requireLocks(request.locks);
    this.intentWasDurable &&=
      this.journal?.pending?.kind === 'move-profile' &&
      this.journal.pending.profile === request.profile;
    this.moveRequests.push(structuredClone(request));
    if (request.profile === this.plan.unavailableProfile) throw new Unavailable();
    this.dieBefore('move');
    this.moved.add(request.profile);
    this.events.push(`move:${request.profile}`);
    this.dieAfter('move');
    return {
      profile: request.profile,
      successorLibraryId:
        this.plan.lie === 'successor-id' ? 'f'.repeat(32) : await idOf(request.newKey),
      copiedHead: this.plan.lie === 'copy-head' ? 'not-a-digest' : request.profile[0]!.repeat(64),
    };
  }

  async publishSuccessorHousehold(request: HouseholdPublishRequest) {
    this.requireLocks(request.locks);
    this.intentWasDurable &&= this.journal?.pending?.kind === 'verify-household';
    this.publishAttempts += 1;
    this.dieBefore('publish');
    this.published = structuredClone(request);
    this.events.push('publish');
    this.dieAfter('publish');
  }

  async observeSuccessorHousehold(
    request: HouseholdObservationRequest,
  ): Promise<HouseholdObservation> {
    this.requireLocks(request.locks);
    this.intentWasDurable &&= this.journal?.pending?.kind === 'verify-household';
    if (this.unknownObservations > 0) {
      this.unknownObservations -= 1;
      this.events.push('observe:unknown');
      return { kind: 'unknown' };
    }
    if (this.published === null) {
      this.events.push('observe:absent');
      return { kind: 'absent' };
    }
    this.events.push('observe:committed');
    const directory = structuredClone(this.published.directory);
    if (this.plan.lie === 'household-directory')
      directory.profiles[OWNER] = {
        ...directory.profiles[OWNER]!,
        library: {
          ...directory.profiles[OWNER]!.library,
          value: { keyVersion: 2, key: keyOf(120) },
        },
      };
    return {
      kind: 'committed',
      libraryId:
        this.plan.lie === 'household-id' ? 'f'.repeat(32) : await idOf(request.successorKey),
      head: 'e'.repeat(64),
      directory,
    };
  }

  async retireProfileLibrary(request: ProfileRetirementRequest) {
    this.requireLocks(request.locks);
    this.intentWasDurable &&=
      this.journal?.pending?.kind === 'retire-profile' &&
      this.journal.pending.profile === request.profile &&
      this.journal.householdCommitted;
    this.dieBefore('retireProfile');
    this.retiredProfiles.add(request.profile);
    this.events.push(`retire:${request.profile}`);
    this.dieAfter('retireProfile');
  }

  async retireHouseholdLibrary(request: HouseholdRetirementRequest) {
    this.requireLocks(request.locks);
    this.intentWasDurable &&=
      this.journal?.pending?.kind === 'retire-household' && this.journal.householdCommitted;
    this.dieBefore('retireHousehold');
    this.retiredHousehold = true;
    this.events.push('retire:household');
    this.dieAfter('retireHousehold');
  }

  async adoptSuccessor(request: ProfileAdoptionRequest) {
    this.requireLocks(request.locks);
    this.intentWasDurable &&=
      this.journal?.pending?.kind === 'verify-adoption' && this.journal.oldHouseholdRetired;
    this.adoptCalls += 1;
    this.dieBefore('adopt');
    if (this.ignoreAdopt) this.ignoreAdopt = false;
    else this.adopted = structuredClone(request);
    this.events.push('adopt');
    this.dieAfter('adopt');
  }

  async successorIsAdopted(request: ProfileAdoptionRequest) {
    const matches = JSON.stringify(this.adopted) === JSON.stringify(request);
    this.events.push(matches ? 'observe:adopted' : 'observe:not-adopted');
    return matches;
  }

  /** The exact set it handed out; a stale or substituted set is refused before any library is touched. */
  private requireLocks(locks: ProfileResetLockSet) {
    if (JSON.stringify(locks) !== JSON.stringify(this.acquired)) throw new Unavailable();
  }

  private dieBefore(operation: Operation) {
    if (this.plan.refuse === operation) throw new ProfileResetRefusedError(`refused-${operation}`);
    if (this.plan.rolledBack === operation) {
      this.ended = true;
      throw new ProfileResetRolledBackError();
    }
    if (this.failBefore.delete(operation)) throw new Killed();
  }

  private dieAfter(operation: Operation) {
    if (this.fail.delete(operation)) throw new Killed();
  }
}

class Keys {
  calls = 0;
  private next = 80;
  readonly next32 = (): Uint8Array => {
    this.calls += 1;
    return new Uint8Array(32).fill(this.next++);
  };
}

function executor(backend: FakeBackend, keys: Keys, attempt = ATTEMPT) {
  return new ProfileKeyResetExecutor(backend, {
    randomKey: keys.next32,
    randomAttempt: () => attempt,
    now: () => NOW,
  });
}

/**
 * Restart after every death: a fresh executor over whatever the backend made durable, until the reset completes or
 * there is nothing left to resume.
 */
async function drain(
  backend: FakeBackend,
  keys: Keys,
  first?: () => Promise<ProfileResetStatus | null>,
) {
  let status = null as ProfileResetStatus | null;
  let died = 0;
  const step = async (work: () => Promise<ProfileResetStatus | null>) => {
    try {
      status = await work();
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
      died += 1;
    }
  };
  if (first) await step(first);
  for (let round = 0; round < 300 && status?.phase !== 'complete'; round += 1) {
    if (round > 0 && backend.journal === null) break;
    await step(() => executor(backend, keys).resume());
  }
  return { status: status as ProfileResetStatus | null, died };
}

const start = (backend: FakeBackend, keys: Keys) => () =>
  executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE);

async function advanceTo(
  backend: FakeBackend,
  keys: Keys,
  done: (journal: ProfileResetJournal) => boolean,
) {
  const runner = executor(backend, keys);
  await runner.start(directory(), HOUSEHOLD_KEY, FENCE);
  for (let round = 0; round < 100 && !done(backend.journal!); round += 1) await runner.resume();
  expect(done(backend.journal!)).toBe(true);
}

type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

function tamper(backend: FakeBackend, edit: (journal: DeepMutable<ProfileResetJournal>) => void) {
  const journal = structuredClone(backend.journal!) as DeepMutable<ProfileResetJournal>;
  edit(journal);
  backend.journal = journal as ProfileResetJournal;
}

function noEffects(backend: FakeBackend) {
  expect(backend.published).toBeNull();
  expect(backend.retiredProfiles.size).toBe(0);
  expect(backend.retiredHousehold).toBe(false);
}

describe('compound profile key reset', () => {
  it('moves and verifies Owner and every Kid before publishing, then retires all old credentials', async () => {
    const backend = new FakeBackend();
    const keys = new Keys();
    const { status } = await drain(backend, keys, start(backend, keys));

    expect(status).toEqual({ phase: 'complete', verifiedProfiles: 3, profileCount: 3 });
    const published = backend.published!;
    const successor = validateStoredProfileDirectory(published.directory);
    expect(LIVE.map((id) => successor.profiles[id]!.library.value.keyVersion)).toEqual([2, 2, 2]);
    expect(new Set(LIVE.map((id) => successor.profiles[id]!.library.value.key)).size).toBe(3);
    // The deleted Kid is neither moved nor rotated.
    expect([...backend.moved].sort()).toEqual(LIVE);
    expect(successor.profiles[GONE]).toEqual(directory().profiles[GONE]);
    expect([...backend.retiredProfiles].sort()).toEqual(LIVE);
    expect(backend.retiredHousehold).toBe(true);
    expect(published.newKey).not.toBe(HOUSEHOLD_KEY);
    expect(published.fence).toEqual(FENCE);

    const at = (name: string) => backend.events.findIndex((event) => event === name);
    const lastMove = backend.events.map((e) => e.startsWith('move:')).lastIndexOf(true);
    const retires = backend.events.flatMap((e, i) => (e.startsWith('retire:') ? [i] : []));
    expect(lastMove).toBeLessThan(at('publish'));
    expect(at('publish')).toBeLessThan(at('observe:committed'));
    expect(at('observe:committed')).toBeLessThan(Math.min(...retires));
    expect(backend.events[retires.at(-1)!]).toBe('retire:household');
    expect(Math.max(...retires)).toBeLessThan(at('adopt'));
    expect(at('adopt')).toBeLessThan(at('observe:adopted'));
    expect(at('observe:adopted')).toBeLessThan(at('clear-journal'));
    expect(backend.intentWasDurable).toBe(true);
    expect(backend.journal).toBeNull();
    expect(backend.adopted).toMatchObject({
      householdKey: published.newKey,
      committedHead: 'e'.repeat(64),
    });
  });

  it('asks for the exact live lock set, without deleted profiles, and passes it to every effect', async () => {
    const backend = new FakeBackend();
    const keys = new Keys();
    await drain(backend, keys, start(backend, keys));

    expect(backend.lockRequests).toHaveLength(1);
    const request = backend.lockRequests[0]!;
    expect(Object.keys(request.profiles).sort()).toEqual(LIVE);
    expect(request.household).toEqual({ libraryId: await idOf(HOUSEHOLD_KEY), key: HOUSEHOLD_KEY });
    expect(request.fence).toEqual(FENCE);
    expect(request.profiles[OWNER]).toEqual({
      libraryId: await idOf(directory().profiles[OWNER]!.library.value.key),
      key: directory().profiles[OWNER]!.library.value.key,
    });
    expect(backend.moveRequests).toHaveLength(3);
    for (const move of backend.moveRequests) {
      expect(move.locks.attempt).toBe(ATTEMPT);
      expect(Object.keys(move.locks.profiles).sort()).toEqual(LIVE);
    }
  });

  it('persists one distinct key per library and a fresh monotonic stamp before the first effect', async () => {
    const backend = new FakeBackend();
    const keys = new Keys();
    // Die when the first durable record lands; nothing has been locked or sent yet.
    backend.killAfterPersist = 1;
    await expect(
      executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE),
    ).rejects.toBeInstanceOf(Killed);

    expect(backend.events).toEqual([]);
    const journal = backend.journal!;
    expect(journal.phase).toBe('prepared');
    expect(keys.calls).toBe(4);
    const oldKeys = [
      HOUSEHOLD_KEY,
      ...LIVE.map((id) => directory().profiles[id]!.library.value.key),
    ];
    const newKeys = [journal.newHouseholdKey, ...journal.profiles.map((p) => p.newKey)];
    expect(new Set([...oldKeys, ...newKeys]).size).toBe(8);
    expect(journal.profiles.map((p) => [p.oldVersion, p.newVersion])).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    const latest = Object.values(directory().profiles).flatMap((p) => [
      p.display.at,
      p.library.at,
      p.policy.at,
      p.deleted.at,
    ]);
    for (const stamp of latest) expect(compareStamps(journal.resetStamp, stamp)).toBeGreaterThan(0);
    expect(journal.resetStamp[2]).toBe((await idOf(HOUSEHOLD_KEY)).slice(0, 16));
  });

  it('makes every rotated register win a merge with the old directory under the one reset stamp', async () => {
    const backend = new FakeBackend();
    const keys = new Keys();
    await advanceTo(backend, keys, (j) => j.successorDirectory !== null);
    const journal = backend.journal!;
    const successor = journal.successorDirectory!;

    expect(profilesMaterialize(profilesMerge(journal.directory, successor)).jcs).toBe(
      profilesMaterialize(successor).jcs,
    );
    for (const id of LIVE)
      expect(compareStamps(successor.profiles[id]!.library.at, journal.resetStamp)).toBe(0);
  });

  it('resumes every effect after process death without a second rotation or early retirement', async () => {
    const backend = new FakeBackend({
      killAfter: ['lock', 'move', 'publish', 'retireProfile', 'retireHousehold', 'adopt'],
    });
    const keys = new Keys();
    const { status, died } = await drain(backend, keys, start(backend, keys));

    expect(status?.phase).toBe('complete');
    expect(died).toBe(6);
    expect(keys.calls).toBe(4);
    expect([...backend.retiredProfiles].sort()).toEqual(LIVE);
    expect(backend.retiredHousehold).toBe(true);
    expect(backend.events.filter((event) => event === 'publish')).toHaveLength(1);
    expect(backend.events.filter((event) => event === 'adopt')).toHaveLength(1);
    expect(backend.intentWasDurable).toBe(true);
    expect(backend.journal).toBeNull();
    const firstRetire = backend.events.findIndex((e) => e.startsWith('retire:'));
    expect(backend.events.indexOf('observe:committed')).toBeLessThan(firstRetire);
  });

  // Every durable step is its own full reset with a death injected there, replayed to completion. They are run in
  // slices of persist numbers, so each test keeps its own time budget however many steps a reset has and none of
  // them is long enough for a busy machine to stretch past the default.
  const SLICE = 5;
  const LAST = 49;
  it.each(
    (['killAfterPersist', 'losePersist'] as const).flatMap((mode) =>
      Array.from(
        { length: Math.ceil(LAST / SLICE) },
        (_, slice) => [mode, 1 + slice * SLICE] as const,
      ),
    ),
  )(
    'survives a process that dies (%s), at every durable step from persist %i',
    async (mode, from) => {
      let steps = 0;
      for (let n = from; n < Math.min(from + SLICE, LAST + 1); n += 1) {
        const backend = new FakeBackend();
        const keys = new Keys();
        backend[mode] = n;
        const { status } = await drain(backend, keys, start(backend, keys));
        if (backend[mode] !== null) break; // n is past the last persist: every step has been covered
        steps = n;

        // A death before the very first record leaves nothing to resume; a new reset starts instead.
        if (backend.journal === null && !backend.journalCleared) {
          expect(n).toBe(1);
          expect(backend.events).toEqual([]);
          continue;
        }
        expect(status?.phase, `persist ${n}`).toBe('complete');
        expect(keys.calls, `persist ${n}`).toBe(4);
        expect([...backend.retiredProfiles].sort(), `persist ${n}`).toEqual(LIVE);
        expect(backend.retiredHousehold, `persist ${n}`).toBe(true);
        expect(backend.intentWasDurable, `persist ${n}`).toBe(true);
        expect(backend.journalCleared, `persist ${n}`).toBe(true);
        const first = backend.events.findIndex((e) => e.startsWith('retire:'));
        expect(backend.events.indexOf('observe:committed'), `persist ${n}`).toBeLessThan(first);
        expect(backend.events.lastIndexOf('publish'), `persist ${n}`).toBeLessThan(first);
      }
      // A reset has well over twenty durable steps, so the third slice is never past the end, and the last slice is
      // always past it: were a reset ever to outgrow the slices, that slice would find steps to run and fail, and
      // LAST is what to raise.
      if (from === 21) expect(steps).toBeGreaterThan(20);
      if (from + SLICE > LAST)
        expect(steps, 'a reset has more durable steps than the slices cover').toBe(0);
    },
  );

  it('settles an ambiguous publish by lookup instead of publishing again', async () => {
    const backend = new FakeBackend({ killAfter: ['publish'] });
    const keys = new Keys();
    const { status } = await drain(backend, keys, start(backend, keys));

    expect(status?.phase).toBe('complete');
    expect(backend.publishAttempts).toBe(1);
    expect(backend.events).toContain('observe:committed');
    expect(backend.events).not.toContain('observe:absent');
  });

  it('republishes the identical successor when the lookup proves the publish never landed', async () => {
    const backend = new FakeBackend({ killBefore: ['publish'] });
    const keys = new Keys();
    const { status } = await drain(backend, keys, start(backend, keys));

    expect(status?.phase).toBe('complete');
    expect(backend.publishAttempts).toBe(2);
    expect(backend.events.indexOf('observe:absent')).toBeLessThan(
      backend.events.indexOf('publish'),
    );
    const first = backend.events.findIndex((e) => e.startsWith('retire:'));
    expect(backend.events.indexOf('observe:committed')).toBeLessThan(first);
  });

  it('retires nothing while the lookup cannot tell whether the successor committed', async () => {
    const backend = new FakeBackend({ observeUnknown: 3 });
    const keys = new Keys();
    await advanceTo(backend, keys, (j) => j.phase === 'commit-unknown');
    const runner = executor(backend, keys);
    for (let round = 0; round < 3; round += 1) await runner.resume();

    expect(backend.events.filter((e) => e === 'observe:unknown')).toHaveLength(3);
    expect(backend.retiredProfiles.size).toBe(0);
    expect(backend.retiredHousehold).toBe(false);
    for (let round = 0; round < 80 && backend.journal; round += 1) await runner.resume();
    expect(backend.retiredHousehold).toBe(true);
    expect(backend.publishAttempts).toBe(1);
  });

  it('keeps the journal until the adopted successor reads back, and installs again if it did not take', async () => {
    const backend = new FakeBackend({ ignoreAdoptOnce: true });
    const keys = new Keys();
    const { status } = await drain(backend, keys, start(backend, keys));

    expect(status?.phase).toBe('complete');
    expect(backend.adoptCalls).toBe(2);
    expect(backend.events.indexOf('observe:not-adopted')).toBeLessThan(
      backend.events.lastIndexOf('adopt'),
    );
    expect(backend.events.at(-1)).toBe('clear-journal');
  });

  it('starts a second reset from the adopted topology', async () => {
    const backend = new FakeBackend();
    const keys = new Keys();
    await drain(backend, keys, start(backend, keys));
    const adoption = backend.adopted!;
    expect(backend.journal).toBeNull();

    const second = new FakeBackend();
    const again = executor(second, keys, 'fedcba9876543210fedcba9876543210');
    await again.start(adoption.directory, adoption.householdKey, {
      generation: 15,
      head: 'c'.repeat(64),
    });
    expect(keys.calls).toBe(8);
    expect(second.journal!.profiles.map((p) => [p.oldVersion, p.newVersion])).toEqual([
      [2, 3],
      [2, 3],
      [2, 3],
    ]);
    const { status } = await drain(second, keys);
    expect(status?.phase).toBe('complete');
    const next = validateStoredProfileDirectory(second.adopted!.directory);
    expect(LIVE.map((id) => next.profiles[id]!.library.value.keyVersion)).toEqual([3, 3, 3]);
  });

  describe('fails closed', () => {
    it('leaves every old library live when an unavailable or newer profile cannot move', async () => {
      const backend = new FakeBackend({ unavailableProfile: MINA });
      const keys = new Keys();
      await expect(drain(backend, keys, start(backend, keys))).rejects.toBeInstanceOf(Unavailable);

      noEffects(backend);
      expect(backend.journal!.profiles.filter((p) => p.verified).map((p) => p.profile)).toEqual([
        OWNER,
      ]);
      expect(backend.journal!.successorDirectory).toBeNull();
    });

    it.each([['successor-id'], ['copy-head']] as const)(
      'refuses a move whose readback lies (%s)',
      async (lie) => {
        const backend = new FakeBackend({ lie });
        const keys = new Keys();
        await expect(drain(backend, keys, start(backend, keys))).rejects.toMatchObject({
          code: 'invalid-profile-verification',
        });
        noEffects(backend);
        expect(backend.journal!.profiles.some((p) => p.verified)).toBe(false);
      },
    );

    it.each([['household-id'], ['household-directory']] as const)(
      'refuses a successor household whose lookup lies (%s) and retires nothing',
      async (lie) => {
        const backend = new FakeBackend({ lie });
        const keys = new Keys();
        await expect(drain(backend, keys, start(backend, keys))).rejects.toMatchObject({
          code: 'successor-not-verified',
        });
        expect(backend.retiredProfiles.size).toBe(0);
        expect(backend.retiredHousehold).toBe(false);
        expect(backend.journal!.householdCommitted).toBe(false);
      },
    );

    it.each([
      [
        'a missing profile lock',
        (l: ProfileResetLockSet) => ({ ...l, profiles: { [OWNER]: l.profiles[OWNER]! } }),
      ],
      [
        'a handle shared between libraries',
        (l: ProfileResetLockSet) => ({
          ...l,
          profiles: { ...l.profiles, [MINA]: { ...l.profiles[MINA]!, value: l.household.value } },
        }),
      ],
      [
        'an empty handle',
        (l: ProfileResetLockSet) => ({ ...l, household: { ...l.household, value: '' } }),
      ],
      ['another attempt', (l: ProfileResetLockSet) => ({ ...l, attempt: 'f'.repeat(32) })],
      [
        'a lock on the wrong library',
        (l: ProfileResetLockSet) => ({
          ...l,
          profiles: { ...l.profiles, [LEO]: { ...l.profiles[LEO]!, libraryId: 'f'.repeat(32) } },
        }),
      ],
    ])('refuses %s before any library is touched', async (_name, override) => {
      const backend = new FakeBackend({}, override);
      const keys = new Keys();
      await expect(drain(backend, keys, start(backend, keys))).rejects.toMatchObject({
        code: 'invalid-locks',
      });
      expect(backend.moved.size).toBe(0);
      noEffects(backend);
      expect(backend.journal!.locks).toBeNull();
    });

    it('refuses effects under a lock set the backend did not hand out', async () => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.locks !== null);
      tamper(backend, (j) => {
        j.locks = { ...j.locks!, household: { ...j.locks!.household, value: 'someone-elses' } };
      });
      await expect(drain(backend, keys)).rejects.toBeInstanceOf(Unavailable);
      expect(backend.moved.size).toBe(0);
    });

    const corrupt: Array<[string, (j: DeepMutable<ProfileResetJournal>) => void]> = [
      ['an omitted live profile', (j) => void j.profiles.pop()],
      ['a duplicated profile', (j) => void j.profiles.push(structuredClone(j.profiles[0]!))],
      ['a reused successor key', (j) => void (j.profiles[1]!.newKey = j.profiles[0]!.newKey)],
      [
        'a successor equal to an old key',
        (j) => void (j.profiles[1]!.newKey = j.profiles[0]!.oldKey),
      ],
      [
        'a successor household equal to the old one',
        (j) => void (j.newHouseholdKey = j.oldHouseholdKey),
      ],
      ['a version that is not old plus one', (j) => void (j.profiles[0]!.newVersion = 5)],
      ['a stale reset stamp', (j) => void (j.resetStamp = [1, 0, j.resetStamp[2]])],
      ['a reset stamp from another device', (j) => void (j.resetStamp = [NOW, 0, 'f'.repeat(16)])],
      ['a verified move without a head', (j) => void (j.profiles[0]!.verified = true)],
      ['a head without verification', (j) => void (j.profiles[0]!.copiedHead = 'a'.repeat(64))],
      ['an old key that is not the directory key', (j) => void (j.profiles[0]!.oldKey = keyOf(99))],
      [
        'an old library retired before the successor committed',
        (j) => void (j.profiles[0]!.oldRetired = true),
      ],
      ['a retired household before the commit', (j) => void (j.oldHouseholdRetired = true)],
      [
        'a committed household that never verified its profiles',
        (j) => void (j.householdCommitted = true),
      ],
      ['an unknown phase', (j) => void ((j as { phase: string }).phase = 'done')],
      [
        'a pending effect for the wrong phase',
        (j) => void (j.pending = { kind: 'retire-household' }),
      ],
      ['a malformed fence', (j) => void ((j.fence as { head: string }).head = 'xyz')],
    ];
    it.each(corrupt)('refuses a journal with %s, performing nothing', async (_name, edit) => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.phase === 'locked');
      const events = backend.events.length;
      tamper(backend, edit);

      await expect(executor(backend, keys).resume()).rejects.toMatchObject({
        code: 'corrupt-journal',
      });
      await expect(executor(backend, keys).status()).rejects.toBeInstanceOf(ProfileResetError);
      expect(backend.events).toHaveLength(events);
      noEffects(backend);
    });

    it('refuses a successor directory substituted after verification', async () => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.phase === 'publishing-household');
      tamper(backend, (j) => {
        const owner = j.successorDirectory!.profiles[OWNER]!;
        j.successorDirectory!.profiles[OWNER] = {
          ...owner,
          library: { ...owner.library, value: { keyVersion: 2, key: keyOf(120) } },
        };
      });

      await expect(executor(backend, keys).resume()).rejects.toMatchObject({
        code: 'corrupt-journal',
      });
      expect(backend.published).toBeNull();
    });

    it('refuses a successor directory that keeps an old profile key', async () => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.phase === 'publishing-household');
      tamper(backend, (j) => void (j.successorDirectory = structuredClone(j.directory)));

      await expect(executor(backend, keys).resume()).rejects.toMatchObject({
        code: 'corrupt-journal',
      });
      expect(backend.published).toBeNull();
    });

    it('refuses to retire from a journal that claims a commit it never verified', async () => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.phase === 'publishing-household');
      tamper(backend, (j) => {
        j.householdCommitted = true;
        j.phase = 'retiring-old';
        j.pending = { kind: 'retire-household' };
      });

      await expect(executor(backend, keys).resume()).rejects.toMatchObject({
        code: 'corrupt-journal',
      });
      noEffects(backend);
    });

    it('does not start over a pending reset', async () => {
      const backend = new FakeBackend();
      const keys = new Keys();
      await advanceTo(backend, keys, (j) => j.phase === 'locked');
      await expect(
        executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE),
      ).rejects.toMatchObject({
        code: 'reset-already-pending',
      });
      expect(keys.calls).toBe(4);
    });

    it('rejects bad randomness, keys, fences, attempts and directories before any durable or network effect', async () => {
      const cases: Array<[string, () => Promise<unknown>, string]> = [
        [
          'a repeated key',
          () =>
            new ProfileKeyResetExecutor(new FakeBackend(), {
              randomKey: () => new Uint8Array(32).fill(4),
              randomAttempt: () => ATTEMPT,
              now: () => NOW,
            }).start(directory(), HOUSEHOLD_KEY, FENCE),
          'random-key-failure',
        ],
        [
          'a short key',
          () =>
            new ProfileKeyResetExecutor(new FakeBackend(), {
              randomKey: () => new Uint8Array(31),
              randomAttempt: () => ATTEMPT,
              now: () => NOW,
            }).start(directory(), HOUSEHOLD_KEY, FENCE),
          'random-key-failure',
        ],
        [
          'a household key that is not canonical',
          () => executor(new FakeBackend(), new Keys()).start(directory(), 'AAAA', FENCE),
          'invalid-household-key',
        ],
        [
          'a household key already used by a profile',
          () =>
            executor(new FakeBackend(), new Keys()).start(
              directory(),
              directory().profiles[OWNER]!.library.value.key,
              FENCE,
            ),
          'invalid-directory',
        ],
        [
          'a negative fence generation',
          () =>
            executor(new FakeBackend(), new Keys()).start(directory(), HOUSEHOLD_KEY, {
              ...FENCE,
              generation: -1,
            }),
          'invalid-fence',
        ],
        [
          'a malformed fence head',
          () =>
            executor(new FakeBackend(), new Keys()).start(directory(), HOUSEHOLD_KEY, {
              ...FENCE,
              head: 'abc',
            }),
          'invalid-fence',
        ],
        [
          'a malformed attempt',
          () =>
            executor(new FakeBackend(), new Keys(), 'ATTEMPT').start(
              directory(),
              HOUSEHOLD_KEY,
              FENCE,
            ),
          'invalid-attempt',
        ],
        [
          'a directory den-core rejects',
          () => {
            const bad = directory();
            bad.profiles[OWNER] = {
              ...bad.profiles[OWNER]!,
              deleted: { ...bad.profiles[OWNER]!.deleted, value: true },
            };
            return executor(new FakeBackend(), new Keys()).start(bad, HOUSEHOLD_KEY, FENCE);
          },
          'invalid-directory',
        ],
      ];
      for (const [name, run, code] of cases) {
        await expect(run(), name).rejects.toMatchObject({ code });
      }
      const backend = new FakeBackend();
      await expect(
        new ProfileKeyResetExecutor(backend, {
          randomKey: () => new Uint8Array(32).fill(4),
          randomAttempt: () => ATTEMPT,
          now: () => NOW,
        }).start(directory(), HOUSEHOLD_KEY, FENCE),
      ).rejects.toBeInstanceOf(ProfileResetError);
      expect(backend.journal).toBeNull();
      expect(backend.persists).toBe(0);
      expect(backend.events).toEqual([]);
    });
  });

  describe('aborts before the successor commit', () => {
    const household = async () => ({
      libraryId: await idOf(HOUSEHOLD_KEY),
      key: HOUSEHOLD_KEY,
    });

    it.each([['lock'], ['move'], ['publish']] as const)(
      'releases the locks and discards the journal when %s is refused for good',
      async (refuse) => {
        const backend = new FakeBackend({ refuse });
        const keys = new Keys();
        const first = await executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE);
        const { status } =
          first.phase === 'aborted' ? { status: first } : await drain(backend, keys);

        expect(status?.phase).toBe('aborted');
        expect(backend.abortCalls).toEqual([{ attempt: ATTEMPT, household: await household() }]);
        expect(backend.journal).toBeNull();
        expect(backend.events.at(-1)).toBe('clear-journal');
        expect(backend.retiredProfiles.size).toBe(0);
        expect(backend.retiredHousehold).toBe(false);
        expect(backend.adopted).toBeNull();
      },
    );

    it('does not abort a reset den-edge already committed, and keeps the journal', async () => {
      const backend = new FakeBackend({ refuse: 'publish' });
      backend.abortAnswer = 'committed';
      const keys = new Keys();
      await executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE);
      await expect(drain(backend, keys)).rejects.toBeInstanceOf(ProfileResetRefusedError);

      expect(backend.abortCalls.length).toBeGreaterThan(0);
      expect(backend.journal).not.toBeNull();
      expect(backend.events).not.toContain('clear-journal');
    });

    it('never aborts once the successor is committed: a refusal then is only surfaced', async () => {
      const backend = new FakeBackend({ refuse: 'retireProfile' });
      const keys = new Keys();
      await executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE);
      await expect(drain(backend, keys)).rejects.toBeInstanceOf(ProfileResetRefusedError);

      expect(backend.journal!.householdCommitted).toBe(true);
      expect(backend.abortCalls).toEqual([]);
    });

    it('repeats a lost abort on the next resume, which is idempotent', async () => {
      const backend = new FakeBackend({ refuse: 'lock' });
      backend.loseAbortResponse = true;
      const keys = new Keys();
      await expect(
        executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE),
      ).rejects.toBeInstanceOf(Killed);
      expect(backend.journal).not.toBeNull();

      const status = await executor(backend, keys).resume();
      expect(status?.phase).toBe('aborted');
      expect(backend.abortCalls).toHaveLength(2);
      expect(backend.journal).toBeNull();
    });

    it('discards the journal without an abort when den-edge says a recovery rolled the attempt back', async () => {
      const backend = new FakeBackend({ rolledBack: 'move' });
      const keys = new Keys();
      await executor(backend, keys).start(directory(), HOUSEHOLD_KEY, FENCE);
      const { status } = await drain(backend, keys);

      expect(status?.phase).toBe('aborted');
      expect(backend.abortCalls).toEqual([]);
      expect(backend.journal).toBeNull();
    });

    it('reuses the page prepared successor household key', async () => {
      const backend = new FakeBackend();
      const prepared = keyOf(7);
      await executor(backend, new Keys()).start(directory(), HOUSEHOLD_KEY, FENCE, prepared);
      expect(backend.journal!.newHouseholdKey).toBe(prepared);
      await expect(
        executor(new FakeBackend(), new Keys()).start(
          directory(),
          HOUSEHOLD_KEY,
          FENCE,
          HOUSEHOLD_KEY,
        ),
      ).rejects.toMatchObject({ code: 'invalid-household-key' });
    });
  });

  describe('durable journal in the household vault', () => {
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

    it('round-trips the journal, binds it to its household, and erases it only for its own attempt', async () => {
      const backend = new FakeBackend();
      await advanceTo(backend, new Keys(), (j) => j.phase === 'locked');
      const vault = new MemoryVault();
      const store = new VaultProfileResetJournal(vault);

      await expect(store.load()).resolves.toBeNull();
      await store.persist(backend.journal!);
      await expect(store.load()).resolves.toEqual(backend.journal);
      vault.bindings.set('profile-reset/v1/journal', 'profile-reset:other:1');
      await expect(store.load()).rejects.toThrow('binding');
      vault.bindings.set('profile-reset/v1/journal', `profile-reset:${vault.libraryId}:1`);

      await expect(store.clear('f'.repeat(32))).rejects.toThrow('another attempt');
      await store.clear(ATTEMPT);
      await store.clear(ATTEMPT);
      await expect(store.load()).resolves.toBeNull();
    });

    it('drives a complete reset with the vault as its only durable record', async () => {
      const vault = new MemoryVault();
      const store = new VaultProfileResetJournal(vault);
      const backend = new FakeBackend(
        { killAfter: ['move', 'publish', 'adopt'] },
        undefined,
        store,
      );
      const keys = new Keys();
      const { status } = await drain(backend, keys, start(backend, keys));

      expect(status?.phase).toBe('complete');
      await expect(store.load()).resolves.toBeNull();
      expect(vault.values.size).toBe(0);
      expect(backend.retiredHousehold).toBe(true);
    });
  });
});
