// Whether a title is playing somewhere right now, and where. A playing device writes its position and the log carries
// when each was written, so a position written recently is one still moving: it is shown counting on from there.
//
// The Apple TV writes every three seconds into its own log, but that log reaches den-edge only when the TV syncs:
// each 3 s write pushes a 5 s sync debounce back, so while a title plays the debounce never ends and the TV pushes at
// its cap, 15 s (den's `LibraryLogSync.maxWait`). With a 60 s cap the TV's `doc.episodes` row reached den-edge about
// once a minute, longer than LIVE_MS, and the clock and TV controls showed after each push and vanished before the
// next. So the newest position any reader can see is up to ~15 s old, plus a pull.
//
// The TV's 3 s write runs whether or not the player is paused (den's `PlayerView` loop calls `persistProgress`
// unconditionally — read from its code, not observed): a paused title keeps getting fresh writes at one position.
// So a write is only playing if its position moved since the previous write seen of the same title.

/**
 * A position written longer ago than this is no longer playing: the device stopped or went away. Three times the
 * 15 s between the TV's pushes, so one push arriving late (or a pull just missing it) does not stop the clock.
 * The cost is that a stop on the TV shows here up to this long after its last write.
 */
export const LIVE_MS = 45_000;
/**
 * An exact unfinished position remains eligible for a guarded Resume command for ten minutes. This is deliberately
 * longer than `LIVE_MS`: it never makes the clock advance, and the listening probe plus the TV's exact-title guard
 * still decide whether a command may affect a player.
 */
export const REMOTE_RESUME_MS = 10 * 60_000;
/** library-v2/v4's ordinary HLC future bound; farther-ahead values are not trustworthy live activity. */
export const MAX_ACTIVITY_CLOCK_SKEW_MS = 24 * 60 * 60_000;
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
  if (entry.at === undefined) return false;
  const age = now - entry.at;
  return age >= -MAX_ACTIVITY_CLOCK_SKEW_MS && age <= LIVE_MS;
}

/** Whether an exact position can still offer guarded Resume without claiming that it is live. */
export function resumable(entry: { at?: number }, now: number): boolean {
  if (entry.at === undefined) return false;
  const age = now - entry.at;
  return age >= -MAX_ACTIVITY_CLOCK_SKEW_MS && age <= REMOTE_RESUME_MS;
}

/** Where a title is now, in seconds, if its last position is recent enough to be playing; else undefined. */
export function livePosition(
  entry: { seconds?: number; at?: number; moving?: boolean },
  now: number,
): number | undefined {
  if (entry.seconds === undefined || entry.at === undefined || entry.moving === false)
    return undefined;
  // A clock a little ahead of this one reads as a write from the future: count from its own time.
  const rawAge = now - entry.at;
  if (rawAge < -MAX_ACTIVITY_CLOCK_SKEW_MS || rawAge > LIVE_MS) return undefined;
  return entry.seconds + Math.max(0, rawAge) / 1000;
}

/** A position as the player shows it: 4:05, 1:02:09. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
