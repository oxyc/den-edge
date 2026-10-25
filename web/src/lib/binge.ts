// When to warm the next episode, so advancing to it does not start from cold.
//
// The tvOS app prefetches at the HALFWAY mark and holds the resolved route in memory for the rest of the
// episode (`BingePlan.shouldPrefetch`, `BingeCoordinator`). That does not port here. The web holds no route
// across an advance — the player keeps its video but starts the next episode's session afresh — so a warm is only
// worth making while its answer will still be fresh, and den-scout keeps a stream list for five minutes
// (`defaultListTTL`). Warming twenty minutes early would warm something that has expired before it is used.
//
// So the web warms LATE, on the same lead the TV uses for its CDN warm: late enough that the answer is still
// fresh when the next episode starts, early enough to finish well before the cut.

/** Seconds before the end at which the next episode is warmed — the TV's `BingeCoordinator.warmLead`. */
export const WARM_LEAD_SECS = 180;

/**
 * Whether the next episode should be warmed now.
 *
 * Release choice is a separate, stricter decision (`continuationPrefetch`): warming the list is harmless, while
 * queueing is allowed only when the next episode lists the exact release already on screen.
 */
export function shouldWarmNext(
  time: number,
  duration: number,
  lead: number = WARM_LEAD_SECS,
): boolean {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || time < 0)
    return false;
  const left = duration - time;
  // Past the end is not a warm: `finished` has already run, and the advance is under way.
  return left > 0 && left <= lead;
}

/** The source fields needed to decide whether a binge prefetch is continuity rather than a new release choice. */
export interface BingeSource {
  bingeGroup?: string;
  cached?: boolean;
}

/**
 * Pick the one source a near-end prefetch may prepare.
 *
 * Scout's non-empty binge group identifies one release/season pack while its episode filenames naturally differ.
 * It is deliberately stricter than Apple's quality fallback: a background request is allowed to keep using the
 * season pack already on screen, not to choose a merely similar release. Crossing a season boundary also requires
 * an ordinary foreground Play.
 */
export function continuationPrefetch<T extends BingeSource>(
  sources: readonly T[],
  playingBingeGroup: string | undefined,
  season: number | undefined,
  nextSeason: number | undefined,
): T | undefined {
  if (!playingBingeGroup || season === undefined || nextSeason !== season) return undefined;
  return sources.find((source) => source.bingeGroup === playingBingeGroup);
}
