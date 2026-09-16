// When to warm the next episode, so advancing to it does not start from cold.
//
// The tvOS app prefetches at the HALFWAY mark and holds the resolved route in memory for the rest of the
// episode (`BingePlan.shouldPrefetch`, `BingeCoordinator`). That does not port here. The web holds nothing
// across an advance — the player is remounted for the next episode and resolves again — so a warm is only
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
 * Deliberately says nothing about WHICH release to play. den-remux's release list carries no readiness, and
 * choosing one unattended is how a viewer lands in a debrid download they never asked for — the tvOS app
 * refuses that for the same reason (`BingePlan.continuationSource`: "dropping a viewer into a debrid download
 * they never asked for is the one thing automatic playback must not do"). This warms the lookup and leaves
 * every decision to the session that actually starts.
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
