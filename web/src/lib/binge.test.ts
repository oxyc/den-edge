import { describe, expect, it } from 'vitest';
import { shouldWarmNext, WARM_LEAD_SECS } from './binge';

describe('shouldWarmNext', () => {
  /**
   * Late, not at the halfway mark the TV uses. den-scout keeps a stream list for five minutes, so a warm
   * twenty minutes out would have expired long before the advance that was meant to use it.
   */
  it('warms only inside the lead before the end', () => {
    const episode = 40 * 60;
    expect(shouldWarmNext(episode / 2, episode)).toBe(false);
    expect(shouldWarmNext(episode - WARM_LEAD_SECS - 1, episode)).toBe(false);
    expect(shouldWarmNext(episode - WARM_LEAD_SECS, episode)).toBe(true);
    expect(shouldWarmNext(episode - 5, episode)).toBe(true);
  });

  /** The end itself is not a warm: playback has finished and the advance is already running. */
  it('does not warm at or past the end', () => {
    expect(shouldWarmNext(2400, 2400)).toBe(false);
    expect(shouldWarmNext(2500, 2400)).toBe(false);
  });

  /** A duration the player does not know yet, which is every frame before `loadedmetadata`. */
  it('says no until the length is known', () => {
    expect(shouldWarmNext(100, 0)).toBe(false);
    expect(shouldWarmNext(100, Number.NaN)).toBe(false);
    expect(shouldWarmNext(Number.NaN, 2400)).toBe(false);
    expect(shouldWarmNext(Number.POSITIVE_INFINITY, 2400)).toBe(false);
    expect(shouldWarmNext(-1, 2400)).toBe(false);
  });

  /** A short episode is all lead, and warming it from the start is right rather than a bug. */
  it('warms a whole episode shorter than the lead', () => {
    expect(shouldWarmNext(1, 120)).toBe(true);
  });
});
