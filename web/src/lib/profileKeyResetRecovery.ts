import {
  attemptPath,
  errorCode,
  HOUSEHOLD_WIRE,
  lookupAttempt,
  observeResetSource,
  PROFILE_WIRE,
  record,
  resetSend,
  ProfileResetUnavailableError,
  type ProfileResetJournalStore,
  type ProfileResetLibrary,
  type ProfileResetLibraryOpener,
} from './profileKeyResetBackend';
import { libraryId as libraryIdOfKey, ProfileResetRefusedError } from './profileKeyResetExecutor';
import type { ProfileDirectoryDocument } from './profileDirectory';
import { deriveKeys } from './wire';

/*
 * Journal-less recovery of a compound key reset (profiles-v1 §9.1 *Journal-less Owner-PIN recovery*). A reset takes a
 * lock that has no expiry, so a device that lost its journal, or a different one, needs a way to end it. The caller
 * has already required a fresh Owner PIN bound to the recovery attempt; this class is the wire protocol after that.
 */

const ID = /^[0-9a-f]{32}$/;

export type ProfileResetRecoveryResult =
  /** The reset was rolled back or aborted: every old library is unlocked and intact, and den-edge deletes the successors. */
  | { readonly kind: 'aborted' }
  /** Retirement was finished with proof of the successor key; the caller holds that key and adopts it. */
  | { readonly kind: 'retired'; readonly successorLibraryId: string }
  /** Nothing this device can do: another device must finish the reset (or no reset lock is held). */
  | { readonly kind: 'blocked' };

interface Recovers {
  readonly phase: 'open' | 'committed' | 'retiring';
  readonly successor: string;
  readonly members: readonly { readonly libraryId: string; readonly successor: string }[];
}

export class ProfileKeyResetRecovery {
  constructor(
    private readonly deps: {
      /** A device that still has its own journal resumes instead of recovering. */
      readonly journal: Pick<ProfileResetJournalStore, 'load'>;
      readonly open: ProfileResetLibraryOpener;
      /** The household key this device holds: the old household, readable until the reset retires it last. */
      readonly householdKey: string;
    },
  ) {}

  /**
   * `attempt` is the recovery attempt id `R`, kept by the caller so a recovery that dies resumes as the same attempt.
   * `successorKey` is the successor household key when this browser can prove it, else null: without it a committed
   * reset can only be rolled back (before retirement started), never finished.
   */
  async recover(input: {
    readonly attempt: string;
    readonly successorKey: string | null;
  }): Promise<ProfileResetRecoveryResult> {
    if (!ID.test(input.attempt)) throw new TypeError('Recovery attempt is not canonical');
    if ((await this.deps.journal.load()) !== null)
      throw new Error(
        'This device has a reset journal; resume that reset instead of recovering it',
      );
    const household = await this.deps.open(this.deps.householdKey, HOUSEHOLD_WIRE);
    const proven = input.successorKey !== null;

    // Lookup-first, so a recovery that died after taking the lock over continues as that same attempt.
    const stored = await lookupAttempt(household, input.attempt);
    if (stored.state === 'completed')
      return stored.outcome === 'aborted'
        ? { kind: 'aborted' }
        : input.successorKey === null
          ? { kind: 'blocked' }
          : { kind: 'retired', successorLibraryId: await libraryIdOfKey(input.successorKey) };
    // The household is retired last, so this attempt's own tombstone on it means the whole retirement finished.
    if (stored.state === 'retired')
      return { kind: 'retired', successorLibraryId: stored.successor };
    let recovers: Recovers;
    if (stored.state === 'open' || stored.state === 'committed') {
      const parsed = parsedRecovers(stored.body.recovers);
      if (parsed === null) throw new ProfileResetUnavailableError('stored recovery has no origin');
      recovers = parsed;
    } else if (stored.state !== 'unknown') {
      return { kind: 'blocked' };
    } else {
      const taken = await this.takeOver(household, input.attempt, input.successorKey);
      if ('result' in taken) return taken.result;
      recovers = taken.recovers;
    }

    if (recovers.phase === 'open') return this.abort(household, input.attempt);
    // Committed or retiring: only a holder of the successor key may retire, and only they were let through.
    if (!proven) return { kind: 'blocked' };
    return this.finish(household, input.attempt, recovers);
  }

  private async takeOver(
    household: ProfileResetLibrary,
    attempt: string,
    successorKey: string | null,
  ): Promise<{ readonly result: ProfileResetRecoveryResult } | { readonly recovers: Recovers }> {
    let headers: Record<string, string> | undefined;
    if (successorKey !== null) {
      const raw = Uint8Array.from(atob(successorKey), (character) => character.charCodeAt(0));
      try {
        headers = { 'x-den-successor-token': (await deriveKeys(raw)).token };
      } finally {
        raw.fill(0);
      }
    }
    for (let round = 0; round < 3; round += 1) {
      let observed;
      try {
        observed = await observeResetSource(household, HOUSEHOLD_WIRE);
      } catch (error) {
        // A retired household has nothing left to recover.
        if (error instanceof ProfileResetRefusedError && error.reason === 'library-moved')
          return { result: { kind: 'blocked' } };
        throw error;
      }
      if (observed === null) throw new ProfileResetUnavailableError('the household kept changing');
      const reply = await resetSend(household, {
        method: 'POST',
        path: attemptPath(household.libraryId),
        body: {
          attempt,
          purpose: 'key-reset-recovery',
          role: 'household',
          expectedSource: observed.source,
        },
        ...(headers ? { headers } : {}),
      });
      if (reply.status === 200 && record(reply.body)) {
        if (reply.body.attempt !== attempt) break;
        // The proofless rollback of a committed reset completes inside the takeover itself.
        if (reply.body.state === 'completed' && reply.body.outcome === 'aborted')
          return { result: { kind: 'aborted' } };
        const recovers = parsedRecovers(reply.body.recovers);
        if (
          reply.body.state === 'open' &&
          reply.body.purpose === 'key-reset-recovery' &&
          reply.body.library === household.libraryId &&
          recovers !== null
        )
          return { recovers };
        break;
      }
      const code = errorCode(reply);
      if (reply.status === 409 && code === 'migration_source_changed') continue;
      // No metadata: no lock, another owner, a wrong proof, or a retiring reset without proof all look the same.
      if (reply.status === 409 && code === 'migration_in_progress')
        return { result: { kind: 'blocked' } };
      throw new ProfileResetRefusedError(code ?? `recovery-${reply.status}`);
    }
    throw new ProfileResetUnavailableError('the recovery answer is not recognised');
  }

  /** Before the successor commit: one household commit releases the whole set. */
  private async abort(
    household: ProfileResetLibrary,
    attempt: string,
  ): Promise<ProfileResetRecoveryResult> {
    const reply = await resetSend(household, {
      method: 'DELETE',
      path: attemptPath(household.libraryId, attempt),
    });
    if (
      reply.status === 200 &&
      record(reply.body) &&
      reply.body.state === 'completed' &&
      reply.body.outcome === 'aborted'
    )
      return { kind: 'aborted' };
    // The original owner committed first; the next recovery sees the committed phase.
    if (reply.status === 409 && errorCode(reply) === 'migration_in_progress')
      return { kind: 'blocked' };
    throw new ProfileResetRefusedError(errorCode(reply) ?? `abort-${reply.status}`);
  }

  /** Retire every declared member with the recovery attempt and the declared successor, then the household last. */
  private async finish(
    household: ProfileResetLibrary,
    attempt: string,
    recovers: Recovers,
  ): Promise<ProfileResetRecoveryResult> {
    const snapshot = await household.resetSnapshot();
    if (snapshot === null)
      throw new ProfileResetUnavailableError('the household could not be read');
    // The old household is the only place the old profile keys can be read, which is why it is retired last. If it is
    // already gone, every member was retired before it and this attempt's earlier run finished the job.
    const gone = snapshot === 'absent' || snapshot === 'moved';
    const keys =
      gone || snapshot.directory === null
        ? new Map<string, string>()
        : await profileKeysById(snapshot.directory);
    for (const member of recovers.members) {
      const key = keys.get(member.libraryId);
      if (key === undefined) {
        if (gone) continue;
        throw new ProfileResetRefusedError('member-key-unknown');
      }
      const result = await this.retire(
        await this.deps.open(key, PROFILE_WIRE),
        attempt,
        member.successor,
      );
      if (result === 'blocked') return { kind: 'blocked' };
    }
    const result = await this.retire(household, attempt, recovers.successor);
    return result === 'blocked'
      ? { kind: 'blocked' }
      : { kind: 'retired', successorLibraryId: recovers.successor };
  }

  private async retire(
    library: ProfileResetLibrary,
    attempt: string,
    successor: string,
  ): Promise<'retired' | 'blocked'> {
    const reply = await resetSend(library, {
      method: 'DELETE',
      path: `/lib/${library.libraryId}`,
      headers: { 'x-den-exclusive-attempt': attempt, 'x-den-successor': successor },
    });
    if (reply.status === 200) return 'retired';
    if (reply.status === 410) {
      const mine = await lookupAttempt(library, attempt);
      if (mine.state === 'retired' && mine.successor === successor) return 'retired';
      throw new ProfileResetRefusedError('retired-by-another-reset');
    }
    // A recovery that did not prove the successor key owns the lock but may not retire.
    if (reply.status === 409 && errorCode(reply) === 'migration_in_progress') return 'blocked';
    throw new ProfileResetRefusedError(errorCode(reply) ?? `retire-${reply.status}`);
  }
}

async function profileKeysById(directory: ProfileDirectoryDocument): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const entry of Object.values(directory.profiles))
    keys.set(await libraryIdOfKey(entry.library.value.key), entry.library.value.key);
  return keys;
}

function parsedRecovers(value: unknown): Recovers | null {
  if (!record(value) || !Array.isArray(value.members)) return null;
  if (value.phase !== 'open' && value.phase !== 'committed' && value.phase !== 'retiring')
    return null;
  if (typeof value.successor !== 'string' || !ID.test(value.successor)) return null;
  const members: { libraryId: string; successor: string }[] = [];
  for (const entry of value.members as unknown[]) {
    if (
      !record(entry) ||
      typeof entry.libraryId !== 'string' ||
      !ID.test(entry.libraryId) ||
      typeof entry.successor !== 'string' ||
      !ID.test(entry.successor)
    )
      return null;
    members.push({ libraryId: entry.libraryId, successor: entry.successor });
  }
  return { phase: value.phase, successor: value.successor, members };
}
