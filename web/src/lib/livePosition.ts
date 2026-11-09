// Whether a title is playing somewhere right now, and where. A playing device writes its position and the log carries
// when each was written, so a position written recently is one still moving: it is shown counting on from there.
//
// Native Apple and shared Web/TV players persist the first eligible position immediately and then every 30 s.
// Native periodic writes ordinarily wait for a 5 s delivery debounce; shared consumers can then take one 5 s pull
// to observe them. A position can therefore need 70 s to be replaced when one scheduled periodic delivery is lost.
//
// Producers now carry explicit playing state. Legacy rows without it are only playing if their position moved since
// the previous write seen of the same title.

/**
 * A position written longer ago than this is no longer playing: the device stopped or went away. The window holds
 * two 30 s producer intervals, native's 5 s delivery debounce and one 5 s consumer pull, plus a 5 s boundary margin.
 * Thus one lost delivery does not stop the clock. Producer traffic is unchanged; the cost is that an ungraceful stop
 * can appear live for up to 30 s longer than the old 45 s window. A delivered explicit pause/stop still applies at
 * once.
 */
export const LIVE_MS = 75_000;
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
  entry: { seconds?: number; at?: number; playing?: boolean },
): Sighting | undefined {
  if (entry.seconds === undefined || entry.at === undefined) return undefined;
  if (previous && entry.at <= previous.at) return previous;
  return {
    seconds: entry.seconds,
    at: entry.at,
    moving: entry.playing ?? (!previous || entry.seconds !== previous.seconds),
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
