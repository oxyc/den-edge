// Whether a title is playing somewhere right now, and where. A playing device writes its position every few
// seconds (the Apple TV every three) and the log carries when each was written, so a position written moments ago
// is one still moving: it is shown counting on from there, and stops once the writes do.

/** A position written longer ago than this is no longer playing: the device paused, stopped or went away. */
export const LIVE_MS = 15_000;
/** How often the library is pulled while something plays, so a pause stops the clock soon after. */
export const LIVE_PULL_MS = 5_000;

/** Where a title is now, in seconds, if its last position is recent enough to be playing; else undefined. */
export function livePosition(
  entry: { seconds?: number; at?: number },
  now: number,
): number | undefined {
  if (entry.seconds === undefined || entry.at === undefined) return undefined;
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
