// Resetting the library key from Den Web (den-spec wire/library-v2.md §1, wire/library-v4.md §12; oxyc/den#192): the
// library moves to a new key with every document, delivery receipt and setting, and the old library is deleted, so
// every device still holding the old key — the Apple TV included — is cut off and pairs again.

import { links, readPendingReset, writePendingReset } from './links.svelte';
import { exclusive, LibraryLog, type MoveRefusal } from './log';

/** The new key, or why the library stayed where it was. */
export type KeyReset = { key: string } | { refused: MoveRefusal };

/** Copy rounds before giving up on a library another device keeps writing to while it moves. */
const ROUNDS = 3;

/** One reset, or one settling of a pending one, at a time in this browser. */
const LOCK = 'den.keyReset';

/** Where a library is opened to move into or out of: `LibraryLog.destination`, or a test's. */
type Destination = (key: string) => Promise<LibraryLog>;

const destinationOf: Destination = (key) => LibraryLog.destination(key);

/**
 * Move `log`'s library (key `from`) to a new key, as `device`. The new key is kept as pending before anything is
 * written, so a reset cut short is finished or undone later (`settlePendingReset`). The rows go up first; the old
 * library is deleted only once they are all there, and copied again when something was written to it meanwhile. Then
 * every link moves to the new key (`links.rekey`), with the unsent edits this browser kept for the old one. A refused
 * or failed move leaves the old library as it was and deletes what it started under the new key.
 */
export function resetLibraryKey(
  log: LibraryLog,
  device: string,
  from: string,
  destination: Destination = destinationOf,
): Promise<KeyReset> {
  return exclusive(LOCK, async (): Promise<KeyReset> => {
    if (readPendingReset()) return { refused: 'unavailable' };
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    if (!writePendingReset({ from, to: key })) return { refused: 'unavailable' };
    const next = await destination(key);
    for (let round = 0; round < ROUNDS; round++) {
      const moving = await log.moving(device);
      if ('refused' in moving) return abandon(next, moving.refused);
      if (!(await next.takeMoved(moving, log.memberProof))) return abandon(next, 'unavailable');
      const ended = await log.endMoved(moving, next);
      if (ended === 'deleted') {
        await log.rekeyKept(next);
        links.rekey(from, key);
        return { key };
      }
      // The old library may be gone: the new one, and the pending reset, stay for `settlePendingReset`.
      if (ended === 'unknown') return { refused: 'unavailable' };
      if (ended === 'failed') return abandon(next, 'unavailable');
    }
    return abandon(next, 'unavailable');
  });
}

/**
 * A reset this browser started and didn't see through (a closed tab, a lost answer): finished when the old library is
 * gone and its `410` names the new one, or names none (a den-edge from before it did); undone when the old library is
 * still there, or another device's reset moved it elsewhere. Left for later when den-edge can't be reached.
 */
export function settlePendingReset(destination: Destination = destinationOf): Promise<void> {
  return exclusive(LOCK, async () => {
    const pending = readPendingReset();
    if (!pending) return;
    const [old, next] = await Promise.all([destination(pending.from), destination(pending.to)]);
    const standing = await old.standing();
    if (standing === null) return;
    if ('moved' in standing && (standing.successor ?? next.libraryId) === next.libraryId) {
      await old.rekeyKept(next);
      links.rekey(pending.from, pending.to);
      return;
    }
    await abandon(next, 'unavailable');
  });
}

/** The new library deleted again, and the reset no longer pending: it didn't happen. */
async function abandon(next: LibraryLog, refused: MoveRefusal): Promise<KeyReset> {
  if (!(await next.forget()))
    console.warn('den: a library started for a key reset that did not finish is still on den-edge');
  writePendingReset(null);
  return { refused };
}
