import type { LibraryLog } from './log';
import {
  libraryId as libraryIdOfKey,
  ProfileResetError,
  ProfileResetRefusedError,
  ProfileResetRolledBackError,
  sameDirectory,
  type HouseholdObservation,
  type HouseholdObservationRequest,
  type HouseholdPublishRequest,
  type HouseholdRetirementRequest,
  type ProfileAdoptionRequest,
  type ProfileKeyResetBackend,
  type ProfileMoveRequest,
  type ProfileResetAbortRequest,
  type ProfileResetJournal,
  type ProfileResetLockRequest,
  type ProfileResetLockSet,
  type ProfileRetirementRequest,
  type VerifiedProfileMove,
} from './profileKeyResetExecutor';
import type { ProfileDirectoryDocument } from './profileDirectory';
import { profileMigrationDigest, profilesMaterialize } from './profileMigrationCore';
import { ensureSyncPolicy } from './syncLoader';
import { fromBase64url, rowName } from './wire';

/*
 * The concrete backend of the compound key reset executor over the profiles-v1 §9.1 routes. It holds no policy: which
 * effect runs next is the executor's and den-core's. What it owns is the wire contract: every library speaks only with
 * its own token and wire, acquisition is household first then members ascending, an ambiguous answer is settled by
 * lookup-first replay, nothing is retired before the successor commit, and den-edge's household record is the single
 * authority over whether the reset is still alive.
 */

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Source races a profile acquisition survives; the failed attempt had no effect and the household keeps the rest stable. */
const SOURCE_ROUNDS = 5;
/** Replays of one idempotent request that ends in a transport failure or a 5xx before the reset gives up for now. */
const REPLAYS = 3;
export const HOUSEHOLD_WIRE = 5;
export const PROFILE_WIRE = 4;

export type ResetWire = 4 | 5;

/** The part of a library the reset uses: its own-token routes, its authenticated rows, and the §12 move primitives. */
export type ProfileResetLibrary = Pick<
  LibraryLog,
  'libraryId' | 'memberProof' | 'resetRequest' | 'resetSnapshot' | 'moving' | 'takeMoved'
>;

export type ProfileResetSnapshot = Exclude<
  Awaited<ReturnType<ProfileResetLibrary['resetSnapshot']>>,
  'absent' | 'moved' | null
>;

export type ProfileResetLibraryOpener = (
  key: string,
  wire: ResetWire,
) => Promise<ProfileResetLibrary>;

/** Installs the successor household credential on this device, and reads back that it is installed. */
export interface ProfileResetAdoption {
  adopt(request: ProfileAdoptionRequest): Promise<void>;
  isAdopted(request: ProfileAdoptionRequest): Promise<boolean>;
}

export interface ProfileResetJournalStore {
  load(): Promise<ProfileResetJournal | null>;
  persist(journal: ProfileResetJournal): Promise<void>;
  clear(attempt: string): Promise<void>;
}

/** den-edge could not be reached, or the reset is waiting on another device. The journal stays; resume later. */
export class ProfileResetUnavailableError extends Error {
  constructor(what: string, options?: { cause?: unknown }) {
    super(`Profile key reset is waiting: ${what}`, options);
    this.name = 'ProfileResetUnavailableError';
  }
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function errorCode(reply: Reply): string | null {
  return record(reply.body) && typeof reply.body.error === 'string' ? reply.body.error : null;
}

/** One reset request, replayed on a transport failure or 5xx; every §9.1 request is idempotent or lookup-first. */
export async function resetSend(
  library: ProfileResetLibrary,
  input: Parameters<ProfileResetLibrary['resetRequest']>[0],
): Promise<Reply> {
  let last: unknown;
  for (let round = 0; round < REPLAYS; round += 1) {
    try {
      const reply = await library.resetRequest(input);
      if (reply.status < 500) return reply;
      last = new Error(`den-edge answered ${reply.status}`);
    } catch (error) {
      last = error;
    }
    console.warn(`den: profile key reset ${input.method} request failed; replaying`, last);
  }
  throw new ProfileResetUnavailableError(`den-edge did not answer ${input.method}`, {
    cause: last,
  });
}

export function attemptPath(libraryId: string, attempt?: string, suffix = ''): string {
  return attempt === undefined
    ? `/lib/${libraryId}/exclusive-operation`
    : `/lib/${libraryId}/exclusive-operation/${attempt}${suffix}`;
}

export interface AuthenticatedSource {
  readonly source: { readonly generation: number; readonly head: string };
  readonly snapshot: ProfileResetSnapshot;
}

/**
 * profiles-v1 §9.1 *Source observation*: read every row, open each, recompute the source digest with the library's own
 * id, stored minimum and the generation den-edge reports, and accept only a match. A write that lands between the two
 * reads makes them disagree, so the pair is read again; null means the library kept changing.
 */
export async function observeResetSource(
  library: ProfileResetLibrary,
  wire: ResetWire,
): Promise<AuthenticatedSource | null> {
  await ensureSyncPolicy();
  for (let round = 0; round < SOURCE_ROUNDS; round += 1) {
    const snapshot = await library.resetSnapshot();
    if (snapshot === 'absent') throw new ProfileResetRefusedError('library-unavailable');
    if (snapshot === 'moved') throw new ProfileResetRefusedError('library-moved');
    if (snapshot === null) throw new ProfileResetUnavailableError('the library could not be read');
    const reply = await resetSend(library, {
      method: 'GET',
      path: `${attemptPath(library.libraryId)}/source`,
    });
    if (reply.status === 426) throw new ProfileResetRefusedError('update-required');
    if (reply.status === 404) throw new ProfileResetRefusedError('library-unavailable');
    const source = reply.status === 200 ? parsedSourceAnswer(reply.body) : null;
    if (source === null)
      throw new ProfileResetUnavailableError(`unexpected source answer ${reply.status}`);
    const digest = profileMigrationDigest('source', {
      libraryId: library.libraryId,
      generation: source.generation,
      base: snapshot.base,
      wireMin: wire,
      rows: snapshot.rows,
    });
    if (digest === source.head) return { source, snapshot };
  }
  return null;
}

function parsedSourceAnswer(body: unknown): { generation: number; head: string } | null {
  if (!record(body) || !record(body.source)) return null;
  const { generation, head } = body.source;
  if (!Number.isSafeInteger(generation) || Number(generation) < 0) return null;
  if (typeof head !== 'string' || !DIGEST.test(head)) return null;
  return { generation: Number(generation), head };
}

export type Lookup =
  | {
      readonly state: 'open' | 'committed';
      readonly lock: string;
      readonly body: Record<string, unknown>;
    }
  | { readonly state: 'aborted' }
  | { readonly state: 'completed'; readonly outcome: 'aborted' | 'retired' }
  | {
      readonly state: 'recovered';
      readonly recovery: string;
      readonly outcome: 'aborted' | 'retired' | null;
    }
  | { readonly state: 'retired'; readonly successor: string }
  | { readonly state: 'unknown' };

export async function lookupAttempt(
  library: ProfileResetLibrary,
  attempt: string,
): Promise<Lookup> {
  const reply = await resetSend(library, {
    method: 'GET',
    path: attemptPath(library.libraryId, attempt),
  });
  if (reply.status === 404) return { state: 'unknown' };
  if (reply.status === 426) throw new ProfileResetRefusedError('update-required');
  const body = reply.status === 200 && record(reply.body) ? reply.body : null;
  if (body === null)
    throw new ProfileResetUnavailableError(`unexpected lookup answer ${reply.status}`);
  switch (body.state) {
    case 'open':
    case 'committed':
      if (body.attempt !== attempt || typeof body.lock !== 'string' || body.lock === '') break;
      return { state: body.state, lock: body.lock, body };
    case 'aborted':
      return { state: 'aborted' };
    case 'completed':
      if (body.outcome !== 'aborted' && body.outcome !== 'retired') break;
      return { state: 'completed', outcome: body.outcome };
    case 'recovered': {
      const outcome = body.outcome;
      if (typeof body.recovery !== 'string' || !ID.test(body.recovery)) break;
      if (outcome !== undefined && outcome !== 'aborted' && outcome !== 'retired') break;
      return { state: 'recovered', recovery: body.recovery, outcome: outcome ?? null };
    }
    case 'retired':
      if (typeof body.successor !== 'string' || !ID.test(body.successor)) break;
      return { state: 'retired', successor: body.successor };
  }
  throw new ProfileResetUnavailableError('lookup answer is not recognised');
}

/** The authenticated digest of the complete library after readback: what the executor keeps as a verified head. */
export function resetHead(
  libraryId: string,
  snapshot: ProfileResetSnapshot,
  wire: ResetWire,
): string {
  return profileMigrationDigest('owner', {
    libraryId,
    base: snapshot.base,
    wireMin: wire,
    rows: snapshot.rows,
  });
}

type AcquireShape =
  | {
      role: 'household';
      successor: string;
      members: readonly { libraryId: string; successor: string }[];
    }
  | { role: 'profile'; successor: string; household: string };

export class HttpProfileKeyResetBackend implements ProfileKeyResetBackend {
  constructor(
    private readonly deps: {
      readonly journal: ProfileResetJournalStore;
      readonly open: ProfileResetLibraryOpener;
      readonly adoption: ProfileResetAdoption;
      /** The household key being reset; every household request is made with this library's own token. */
      readonly householdKey: string;
      /** The device whose `set:devices` entry survives the move (library-v4 §12). */
      readonly device: string;
    },
  ) {}

  loadJournal(): Promise<ProfileResetJournal | null> {
    return this.deps.journal.load();
  }

  persistJournal(journal: ProfileResetJournal): Promise<void> {
    return this.deps.journal.persist(journal);
  }

  clearJournal(attempt: string): Promise<void> {
    return this.deps.journal.clear(attempt);
  }

  adoptSuccessor(request: ProfileAdoptionRequest): Promise<void> {
    return this.deps.adoption.adopt(request);
  }

  successorIsAdopted(request: ProfileAdoptionRequest): Promise<boolean> {
    return this.deps.adoption.isAdopted(request);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Acquire

  async acquireLocks(request: ProfileResetLockRequest): Promise<ProfileResetLockSet> {
    if (request.household.key !== this.deps.householdKey)
      throw new ProfileResetError('invalid-locks');
    const members = Object.entries(request.profiles)
      .map(([profile, library]) => ({
        profile,
        libraryId: library.libraryId,
        key: library.key,
        successor: request.successors.profiles[profile],
      }))
      .sort((left, right) =>
        left.libraryId < right.libraryId ? -1 : left.libraryId > right.libraryId ? 1 : 0,
      );
    if (members.length === 0 || members.some((member) => member.successor === undefined))
      throw new ProfileResetError('invalid-locks');
    const declared = members.map((member) => ({
      libraryId: member.libraryId,
      successor: member.successor!,
    }));
    const distinct = new Set([
      request.household.libraryId,
      request.successors.household,
      ...declared.flatMap((member) => [member.libraryId, member.successor]),
    ]);
    if (distinct.size !== 2 + declared.length * 2) throw new ProfileResetError('invalid-locks');

    const household = await this.household();
    const householdLock = await this.acquireOne(
      household,
      HOUSEHOLD_WIRE,
      request.attempt,
      { role: 'household', successor: request.successors.household, members: declared },
      // The household's source is the one the owner authorized: a different one is a different reset.
      request.fence,
    );
    const profiles: Record<string, { libraryId: string; value: string }> = {};
    for (const member of members) {
      const library = await this.deps.open(member.key, PROFILE_WIRE);
      const lock = await this.acquireOne(library, PROFILE_WIRE, request.attempt, {
        role: 'profile',
        successor: member.successor!,
        household: request.household.libraryId,
      });
      profiles[member.profile] = { libraryId: member.libraryId, value: lock };
    }
    return {
      attempt: request.attempt,
      household: { libraryId: request.household.libraryId, value: householdLock },
      profiles,
    };
  }

  /** Lookup-first, so a repeated acquisition after a lost answer needs no fresh observation. */
  private async acquireOne(
    library: ProfileResetLibrary,
    wire: ResetWire,
    attempt: string,
    shape: AcquireShape,
    fixedSource?: { generation: number; head: string },
  ): Promise<string> {
    const found = await lookupAttempt(library, attempt);
    if (found.state === 'open' || found.state === 'committed') {
      const lock = parsedOpen(found.body, library.libraryId, attempt, shape);
      if (lock === null) throw new ProfileResetRefusedError('lock-mismatch');
      return lock;
    }
    if (found.state === 'aborted') throw new ProfileResetRolledBackError();
    if (found.state !== 'unknown') throw new ProfileResetRefusedError('attempt-unavailable');

    for (let round = 0; round < SOURCE_ROUNDS; round += 1) {
      const observed = await observeResetSource(library, wire);
      if (observed === null) break;
      let expectedSource = observed.source;
      if (fixedSource !== undefined) {
        if (
          observed.source.generation !== fixedSource.generation ||
          observed.source.head !== fixedSource.head
        )
          throw new ProfileResetRefusedError('source-changed');
        expectedSource = fixedSource;
      }
      const reply = await resetSend(library, {
        method: 'POST',
        path: attemptPath(library.libraryId),
        body: {
          attempt,
          purpose: 'key-reset',
          role: shape.role,
          expectedSource,
          successor: shape.successor,
          ...(shape.role === 'household'
            ? { members: shape.members }
            : { household: shape.household }),
        },
      });
      if (reply.status === 200) {
        const lock = parsedOpen(reply.body, library.libraryId, attempt, shape, expectedSource);
        if (lock === null)
          throw new ProfileResetUnavailableError('acquire answer does not match the request');
        return lock;
      }
      const code = errorCode(reply);
      // A profile that changed since it was observed is observed again; the household's source is fixed by the fence.
      if (code === 'migration_source_changed' && fixedSource === undefined) continue;
      throw new ProfileResetRefusedError(code ?? `acquire-${reply.status}`);
    }
    throw new ProfileResetRefusedError('source-changed');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Abort

  async abortReset(request: ProfileResetAbortRequest): Promise<'aborted' | 'committed'> {
    const household = await this.household();
    if (household.libraryId !== request.household.libraryId)
      throw new ProfileResetError('invalid-locks');
    const reply = await resetSend(household, {
      method: 'DELETE',
      path: attemptPath(household.libraryId, request.attempt),
    });
    if (reply.status === 200 && record(reply.body)) {
      if (reply.body.state === 'aborted') return 'aborted';
      if (reply.body.state === 'completed' && reply.body.outcome === 'aborted') return 'aborted';
    }
    // A household that demands a newer wire than ours cannot have been locked by us.
    if (reply.status === 426) return 'aborted';
    // 409 says only that this attempt cannot abort now; the household's own record says why.
    const found = await lookupAttempt(household, request.attempt);
    if (found.state === 'committed' || found.state === 'retired') return 'committed';
    if (found.state === 'recovered' && found.outcome === 'retired') return 'committed';
    // Nothing was ever acquired under this attempt, or it already ended without a client commit.
    if (found.state === 'unknown' || found.state === 'aborted') return 'aborted';
    if (found.state === 'recovered' && found.outcome === 'aborted') return 'aborted';
    if (found.state === 'completed' && found.outcome === 'aborted') return 'aborted';
    throw new ProfileResetUnavailableError(`the reset cannot be aborted yet (${found.state})`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Move and publish

  async moveAndVerifyProfile(request: ProfileMoveRequest): Promise<VerifiedProfileMove> {
    const oldId = await libraryIdOfKey(request.oldKey);
    const newId = await libraryIdOfKey(request.newKey);
    const lock = request.locks.profiles[request.profile];
    if (!lock || lock.libraryId !== oldId) throw new ProfileResetError('invalid-locks');
    const live = await this.requireLive(request.locks);
    if (live.state !== 'open') throw new ProfileResetUnavailableError(`household is ${live.state}`);
    const old = await this.deps.open(request.oldKey, PROFILE_WIRE);
    const held = await lookupAttempt(old, request.attempt);
    if (held.state === 'aborted') throw new ProfileResetRolledBackError();
    if (held.state !== 'open' || held.lock !== lock.value)
      throw new ProfileResetError('invalid-locks');

    const successor = await this.deps.open(request.newKey, PROFILE_WIRE);
    const moving = await old.moving(this.deps.device);
    if ('refused' in moving) throw new ProfileResetRefusedError(`move-${moving.refused}`);
    if (!(await successor.takeMoved(moving, old.memberProof)))
      throw new ProfileResetUnavailableError('the successor library could not be written');
    const snapshot = await readBack(successor, [
      ...moving.rows.map((row) => rowName(row)),
      ...moving.kept.map(({ name }) => name),
    ]);
    await ensureSyncPolicy();
    return {
      profile: request.profile,
      successorLibraryId: newId,
      copiedHead: resetHead(newId, snapshot, PROFILE_WIRE),
    };
  }

  /** Create the successor household under the new key, verify it, then make the one successor commit. */
  async publishSuccessorHousehold(request: HouseholdPublishRequest): Promise<void> {
    const live = await this.requireLive(request.locks);
    // A repeated publish of a committed household is complete; nothing is written under a committed record.
    if (live.state === 'committed') return;
    if (live.state !== 'open') throw new ProfileResetUnavailableError(`household is ${live.state}`);
    const state = await this.copyHousehold(request.newKey, request.directory, true);
    if (state !== 'complete') throw new ProfileResetRefusedError('successor-household-incomplete');
    await this.commitSuccessor(request.attempt, await libraryIdOfKey(request.newKey));
  }

  /**
   * The only way an ambiguous publish is settled (§9.1 *Lookup and lost responses*): the household record says
   * `committed`, or the successor exists and verifies and is committed now, or nothing is there to commit.
   */
  async observeSuccessorHousehold(
    request: HouseholdObservationRequest,
  ): Promise<HouseholdObservation> {
    const live = await this.requireLive(request.locks);
    const newId = await libraryIdOfKey(request.successorKey);
    const successor = await this.deps.open(request.successorKey, HOUSEHOLD_WIRE);
    if (live.state === 'recovered') {
      // A recovery owner took the lock over. Only one that finished retirement (and so proved the successor) leaves a
      // committed household to adopt; before that the answer is not ours to give.
      if (live.outcome !== 'retired') return { kind: 'unknown' };
      return committedHousehold(successor, newId);
    }
    if (live.state === 'committed' || live.state === 'retired')
      return committedHousehold(successor, newId);

    const snapshot = await successor.resetSnapshot();
    if (snapshot === 'absent') return { kind: 'absent' };
    if (snapshot === 'moved') throw new ProfileResetRefusedError('successor-retired');
    if (snapshot === null) return { kind: 'unknown' };
    // A successor that exists is verified against the exact intended directory and the old household's rows before
    // the one irreversible commit; a partial copy is written again, which is idempotent.
    const state = await this.copyHousehold(request.successorKey, request.directory, false);
    if (state === 'incomplete') return { kind: 'absent' };
    await this.commitSuccessor(request.attempt, newId);
    return committedHousehold(successor, newId);
  }

  /**
   * Copy the old household's rows under the successor key, with the successor directory in place of the old one, and
   * read the result back. Without `write` it only compares, which is what a lookup after a crash needs.
   */
  private async copyHousehold(
    newKey: string,
    directory: ProfileDirectoryDocument,
    write: boolean,
  ): Promise<'complete' | 'incomplete'> {
    const old = await this.household();
    const successor = await this.deps.open(newKey, HOUSEHOLD_WIRE);
    const moving = await old.moving(this.deps.device, { replaceProfileDirectory: true });
    if ('refused' in moving) throw new ProfileResetRefusedError(`move-${moving.refused}`);
    if (write) {
      moving.kept.push({
        name: 'profiles',
        plaintext: fromBase64url(profilesMaterialize(directory).plaintext),
      });
      if (!(await successor.takeMoved(moving, old.memberProof)))
        throw new ProfileResetUnavailableError('the successor household could not be written');
    }
    const snapshot = await successor.resetSnapshot();
    if (snapshot === 'absent') return 'incomplete';
    if (snapshot === 'moved') throw new ProfileResetRefusedError('successor-retired');
    if (snapshot === null)
      throw new ProfileResetUnavailableError('the successor could not be read');
    const names = new Set(snapshot.names);
    const wanted = [
      ...moving.rows.map((row) => rowName(row)),
      ...moving.kept.filter(({ name }) => name !== 'profiles').map(({ name }) => name),
    ];
    if (snapshot.directory === null || !wanted.every((name) => names.has(name)))
      return 'incomplete';
    // A different directory under the successor key is not something this attempt wrote.
    if (!sameDirectory(snapshot.directory, directory))
      throw new ProfileResetRefusedError('successor-not-verified');
    return 'complete';
  }

  /** `POST …/successor`, the one definition of "the successor household committed". */
  private async commitSuccessor(attempt: string, successorId: string): Promise<void> {
    const household = await this.household();
    const reply = await resetSend(household, {
      method: 'POST',
      path: attemptPath(household.libraryId, attempt, '/successor'),
      body: { successor: successorId },
    });
    if (reply.status === 200 && record(reply.body) && reply.body.state === 'committed') return;
    const code = errorCode(reply);
    if (reply.status === 409 && code === 'migration_in_progress') {
      // Not the owner any more, or the reset ended: the household's own record says which.
      const found = await lookupAttempt(household, attempt);
      if (found.state === 'committed') return;
      if (found.state === 'aborted' || (found.state === 'recovered' && found.outcome === 'aborted'))
        throw new ProfileResetRolledBackError();
      throw new ProfileResetUnavailableError(`another device holds the reset (${found.state})`);
    }
    throw new ProfileResetRefusedError(code ?? `successor-${reply.status}`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Retire

  retireProfileLibrary(request: ProfileRetirementRequest): Promise<void> {
    return this.retire(
      request.attempt,
      request.oldKey,
      PROFILE_WIRE,
      request.successorLibraryId,
      request.locks,
    );
  }

  retireHouseholdLibrary(request: HouseholdRetirementRequest): Promise<void> {
    return this.retire(
      request.attempt,
      request.oldKey,
      HOUSEHOLD_WIRE,
      request.successorLibraryId,
      request.locks,
    );
  }

  private async retire(
    attempt: string,
    key: string,
    wire: ResetWire,
    successor: string,
    locks: ProfileResetLockSet,
  ): Promise<void> {
    const live = await this.requireLive(locks);
    if (live.state === 'open') throw new ProfileResetError('successor-not-verified');
    if (live.state === 'recovered' && live.outcome === null)
      throw new ProfileResetUnavailableError('another device is finishing the reset');
    const library = await this.deps.open(key, wire);
    const reply = await resetSend(library, {
      method: 'DELETE',
      path: `/lib/${library.libraryId}`,
      headers: { 'x-den-exclusive-attempt': attempt, 'x-den-successor': successor },
    });
    if (reply.status === 200) return;
    const code = errorCode(reply);
    if (reply.status === 410) {
      // Retired by a lock this attempt cannot replay: its own tombstone says whether the retirement was ours.
      const mine = await lookupAttempt(library, attempt);
      if (mine.state === 'retired' && mine.successor === successor) return;
      throw new Error('The library was retired by another reset');
    }
    if (reply.status === 409 && code === 'migration_in_progress') {
      const now = await lookupAttempt(await this.household(), attempt);
      if (now.state === 'aborted' || (now.state === 'recovered' && now.outcome === 'aborted'))
        throw new ProfileResetRolledBackError();
      throw new ProfileResetUnavailableError('another device is finishing the reset');
    }
    throw new Error(`den-edge refused the retirement: ${code ?? reply.status}`);
  }

  // ---------------------------------------------------------------------------------------------------------------

  private household(): Promise<ProfileResetLibrary> {
    return this.deps.open(this.deps.householdKey, HOUSEHOLD_WIRE);
  }

  /** The household record, which alone says whether the set is still held and by whom (§9.1 *Authority*). */
  private async requireLive(locks: ProfileResetLockSet): Promise<Lookup> {
    const household = await this.household();
    if (locks.household.libraryId !== household.libraryId)
      throw new ProfileResetError('invalid-locks');
    const found = await lookupAttempt(household, locks.attempt);
    switch (found.state) {
      case 'open':
      case 'committed':
        if (found.lock !== locks.household.value) throw new ProfileResetError('invalid-locks');
        return found;
      case 'aborted':
        throw new ProfileResetRolledBackError();
      case 'recovered':
        if (found.outcome === 'aborted') throw new ProfileResetRolledBackError();
        return found;
      case 'retired':
        return found;
      case 'completed':
      case 'unknown':
        throw new ProfileResetError('invalid-locks');
    }
  }
}

function parsedOpen(
  body: unknown,
  libraryId: string,
  attempt: string,
  shape: AcquireShape,
  source?: { generation: number; head: string },
): string | null {
  if (
    !record(body) ||
    body.attempt !== attempt ||
    (body.state !== 'open' && body.state !== 'committed') ||
    body.purpose !== 'key-reset' ||
    body.role !== shape.role ||
    body.library !== libraryId ||
    body.successor !== shape.successor ||
    typeof body.lock !== 'string' ||
    body.lock === '' ||
    !record(body.fence) ||
    (source !== undefined &&
      (body.fence.generation !== source.generation || body.fence.head !== source.head))
  )
    return null;
  if (shape.role === 'profile') return body.household === shape.household ? body.lock : null;
  const members = body.members;
  if (
    !Array.isArray(members) ||
    members.length !== shape.members.length ||
    !shape.members.every((expected, index) => {
      const entry: unknown = members[index];
      return (
        record(entry) &&
        entry.libraryId === expected.libraryId &&
        entry.successor === expected.successor
      );
    })
  )
    return null;
  return body.lock;
}

/** Every name the move carried is in the successor, read back after the write. */
async function readBack(
  library: ProfileResetLibrary,
  wanted: readonly string[],
): Promise<ProfileResetSnapshot> {
  const snapshot = await library.resetSnapshot();
  if (snapshot === 'absent' || snapshot === 'moved')
    throw new ProfileResetRefusedError('readback-absent');
  if (snapshot === null) throw new ProfileResetUnavailableError('the successor could not be read');
  const names = new Set(snapshot.names);
  if (!wanted.every((name) => names.has(name)))
    throw new ProfileResetRefusedError('readback-incomplete');
  return snapshot;
}

async function committedHousehold(
  successor: ProfileResetLibrary,
  successorId: string,
): Promise<HouseholdObservation> {
  const snapshot = await successor.resetSnapshot();
  if (
    snapshot === 'absent' ||
    snapshot === 'moved' ||
    snapshot === null ||
    snapshot.directory === null
  )
    throw new ProfileResetUnavailableError('the committed successor household cannot be read');
  return {
    kind: 'committed',
    libraryId: successorId,
    head: resetHead(successorId, snapshot, HOUSEHOLD_WIRE),
    directory: snapshot.directory,
  };
}
