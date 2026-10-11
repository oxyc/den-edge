// Whether a title is playing somewhere right now, and where. A playing device writes its position and the log carries
// when each was written, so a position written recently is one still moving: it is shown counting on from there.
//
// The Apple TV writes every three seconds into its own log, but that log reaches den-edge only when the TV syncs:
// den-edge's request log, with a TV playing, showed its `POST /lib/:id/batch` arriving in bursts about 30 s apart
// (02:51:58, 02:52:25, 02:52:55, 02:53:18). The TV's code agrees: each 3 s write pushes a 5 s sync debounce back (up
// to a 60 s cap), and its reconciliation poll syncs after each 25 s held read (den's `LibraryLogSync.scheduleSync`,
// `RootView.startReconciliationPoll`). So the newest position any reader can see is up to ~30 s old, and a window
// shorter than that showed the clock for a moment and then lost it until the next burst.
//
// The TV's 3 s write runs whether or not the player is paused (den's `PlayerView` loop calls `persistProgress`
// unconditionally — read from its code, not observed): a paused title keeps getting fresh writes at one position.
// So a write is only playing if its position moved since the previous write seen of the same title.

/**
 * A position written longer ago than this is no longer playing: the device stopped or went away. About 1.5 times
 * the ~30 s between the TV's pushes, so one push arriving late (or a pull just missing it) does not stop the clock.
 * The cost is that a stop on the TV shows here up to this long after its last write.
 */
export const LIVE_MS = 45_000;
/** How often the library is pulled while something plays, so a pause stops the clock soon after. */
export const LIVE_PULL_MS = 5_000;

/** A title's latest write as this page has seen it, and whether it moved from the one seen before it. */
export interface Sighting {
  seconds: number;
  at: number;
  /** False when this write left the position where the previous one had it: paused on the device. */
  moving: boolean;
}

/**
 * Folds a title's latest write into what was seen of it before. The first write seen counts as moving: there is
 * nothing yet to compare it with, and a title paused on the device shows ticking only until its next push.
 */
export function sight(
  previous: Sighting | undefined,
  entry: { seconds?: number; at?: number },
): Sighting | undefined {
  if (entry.seconds === undefined || entry.at === undefined) return undefined;
  if (previous && entry.at <= previous.at) return previous;
  return {
    seconds: entry.seconds,
    at: entry.at,
    moving: !previous || entry.seconds !== previous.seconds,
  };
}

/** Whether a write is recent enough that its device may still be playing (or paused with the player open). */
export function recent(entry: { at?: number }, now: number): boolean {
  return entry.at !== undefined && now - entry.at <= LIVE_MS;
}

/** Where a title is now, in seconds, if its last position is recent enough to be playing; else undefined. */
export function livePosition(
  entry: { seconds?: number; at?: number; moving?: boolean },
  now: number,
): number | undefined {
  if (entry.seconds === undefined || entry.at === undefined || entry.moving === false)
    return undefined;
  // A clock a little ahead of this one reads as a write from the future: count from its own time.
  const age = Math.max(0, now - entry.at);
  return age > LIVE_MS ? undefined : entry.seconds + age / 1000;
}

/** A position as the player shows it: 4:05, 1:02:09. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
