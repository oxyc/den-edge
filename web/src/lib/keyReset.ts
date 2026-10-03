// Resetting the library key from Den Web (den-spec wire/library-v2.md §1, wire/library-v4.md §12; oxyc/den#192): the
// library moves to a new key with every document, delivery receipt and setting, and the old library is deleted, so
// every device still holding the old key — the Apple TV included — is cut off and pairs again.

import { links, readPendingReset, writePendingReset, type PendingReset } from './links.svelte';
import { exclusive, LibraryLog, successorTag, type MoveRefusal } from './log';

/**
 * Why a reset didn't leave this browser on a new key:
 * - `update_required`, `unavailable`: it didn't start, or was undone; the library is where it was.
 * - `unknown`: den-edge couldn't say whether the old library went. Both are kept, and it settles later.
 * - `moved`: another device's reset moved the library first; this browser is cut off and pairs again.
 * - `held`: the old library is gone, but den-edge didn't say which reset retired it. The new key is kept, and used
 *   only when a later check proves the reset was this one, or the person chooses to (`adoptHeldReset`).
 */
export type KeyResetRefusal = MoveRefusal | 'unknown' | 'moved' | 'held';

/** The new key, or why the library isn't on one. */
export type KeyReset = { key: string } | { refused: KeyResetRefusal };

/** Copy rounds before giving up on a library another device keeps writing to while it moves. */
const ROUNDS = 3;

/** One reset, or one settling of a pending one, at a time in this browser. */
const LOCK = 'den.keyReset';

/** Where a library is opened to move into or out of: `LibraryLog.destination`, or a test's. */
type Destination = (key: string) => Promise<LibraryLog>;

const destinationOf: Destination = (key) => LibraryLog.destination(key);

/**
 * Move `log`'s library (key `from`) to a new key, as `device`. A reset pending from before is settled first: finished,
 * or undone and then started afresh. The new key is kept as pending before anything is written. The rows go up
 * first; the old library is deleted only once they are all there, and copied again when something was written to it
 * meanwhile. Then every link moves to the new key (`links.rekey`), with the unsent edits this browser kept for the
 * old one. The new library is deleted only when the old one is known to be still there and fenced against a late
 * `DELETE`, or known to have gone to another device's library.
 */
export function resetLibraryKey(
  log: LibraryLog,
  device: string,
  from: string,
  destination: Destination = destinationOf,
): Promise<KeyReset> {
  return exclusive(LOCK, async (): Promise<KeyReset> => {
    const pending = readPendingReset();
    if (pending) {
      const settled = await settle(pending, destination);
      if (settled === 'adopted') return { key: pending.to };
      if (settled !== 'undone') return { refused: settled };
    }
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    if (!writePendingReset({ from, to: key, device })) return { refused: 'unavailable' };
    const next = await destination(key);
    for (let round = 0; round < ROUNDS; round++) {
      const moving = await log.moving(device);
      if ('refused' in moving) return abandon(next, moving.refused);
      if (!(await next.takeMoved(moving, log.memberProof))) return abandon(next, 'unavailable');
      switch (await log.endMoved(moving, next)) {
        case 'deleted':
          await log.rekeyKept(next);
          links.rekey(from, key);
          return { key };
        case 'changed':
          continue;
        case 'failed':
          return abandon(next, 'unavailable');
        case 'lost':
          await abandon(next, 'moved');
          return cutOff(from);
        case 'lost_unnamed':
          // Gone, but den-edge doesn't say whose reset it was. The new key may be the only key to the library: it is
          // kept, held from adopting itself, until a standing check proves the reset or the person chooses.
          hold({ from, to: key, device });
          return { refused: 'held' };
        case 'unknown':
          return { refused: 'unknown' };
      }
    }
    return abandon(next, 'unavailable');
  });
}

/**
 * A reset this browser started and didn't see through (a closed tab, a lost answer), as den-edge now says:
 * - `adopted`: the old library is gone, its `410` naming the new one; every link moves to it.
 * - `undone`: the old library is still there; it is fenced against a late `DELETE`, and the new one deleted.
 * - `moved`: another device's reset moved it elsewhere; this browser is cut off.
 * - `held`: it is gone, naming no reset; the new key is kept, and nothing adopts it on its own (`adoptHeldReset`).
 * - `unknown`: den-edge can't say yet; everything stays, for the next try.
 */
export function settlePendingReset(
  destination: Destination = destinationOf,
): Promise<'adopted' | 'undone' | 'moved' | 'held' | 'unknown' | null> {
  return exclusive(LOCK, async () => {
    const pending = readPendingReset();
    return pending ? settle(pending, destination) : null;
  });
}

/**
 * A held reset (`PendingReset.held`) taken up because the person says this browser made it: every link moves to the
 * new key. Den never decides that on its own, since den-edge can't prove it. False when no reset is held.
 */
export function adoptHeldReset(destination: Destination = destinationOf): Promise<boolean> {
  return exclusive(LOCK, async () => {
    const pending = readPendingReset();
    if (!pending?.held) return false;
    const [old, next] = await Promise.all([destination(pending.from), destination(pending.to)]);
    await old.rekeyKept(next);
    links.rekey(pending.from, pending.to);
    return true;
  });
}

async function settle(
  pending: PendingReset,
  destination: Destination,
): Promise<'adopted' | 'undone' | 'moved' | 'held' | 'unknown'> {
  const [old, next] = await Promise.all([destination(pending.from), destination(pending.to)]);
  const standing = await old.standing();
  if (standing === null) return 'unknown';
  if ('moved' in standing) {
    if (standing.successor === (await successorTag(next.libraryId))) {
      await old.rekeyKept(next);
      links.rekey(pending.from, pending.to);
      return 'adopted';
    }
    if (standing.successor === undefined) {
      // Not proven either way: the new key stays, held.
      hold(pending);
      return 'held';
    }
    // Another device's library: this reset's copy is one nobody needs.
    await abandon(next, 'moved');
    cutOff(pending.from);
    return 'moved';
  }
  await old.refresh();
  if (!(await old.fence(pending.device))) return 'unknown';
  await abandon(next, 'unavailable');
  return 'undone';
}

/** Keep the reset pending, held from adopting itself. A key that couldn't be kept is said loudly: it may be the only one. */
function hold(pending: PendingReset): void {
  if (!writePendingReset({ ...pending, held: true }))
    console.error('den: the new library key of an unresolved reset could not be kept');
}

/** Another device's reset moved the library: the link to it goes, and the link screen says why. */
function cutOff(from: string): KeyReset {
  for (const link of links.list.filter((l) => l.libraryKey === from)) links.forgetMoved(link);
  return { refused: 'moved' };
}

/** The new library deleted again, and the reset no longer pending: it didn't happen. */
async function abandon(next: LibraryLog, refused: KeyResetRefusal): Promise<KeyReset> {
  if (!(await next.forget()))
    console.warn('den: a library started for a key reset that did not finish is still on den-edge');
  writePendingReset(null);
  return { refused };
}
