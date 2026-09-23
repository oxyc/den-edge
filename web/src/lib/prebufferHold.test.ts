import { describe, expect, it } from 'vitest';
import { countdownLabel, MAX_HOLD_SECS, PrebufferHold } from './prebufferHold';

describe('PrebufferHold', () => {
  it('holds a start with prebuffer 20 behind a countdown, and lets go once 20 s are buffered', () => {
    const hold = new PrebufferHold(20, 0);
    expect(hold.counts).toBe(true);
    // A second and a half of media a second: it counts down from the wait den-remux worked out, then with the buffer.
    const seen: number[] = [];
    let at = 0;
    for (; at <= 12_000; at += 1_000) {
      const { ready, seconds } = hold.update((at / 1000) * 1.5, at);
      if (ready) break;
      seen.push(seconds!);
    }
    expect(seen[0]).toBe(20);
    expect(
      seen.every((s, i) => i === 0 || s <= seen[i - 1]!),
      `${seen}`,
    ).toBe(true);
    expect(hold.update(19.9, 13_300)).toEqual({ ready: false, seconds: expect.any(Number) });
    expect(hold.update(20, 13_400)).toEqual({ ready: true, seconds: null });
  });

  it('goes back up only when the buffer has really fallen behind', () => {
    const hold = new PrebufferHold(20, 0);
    hold.update(0, 0);
    const before = hold.update(6, 4_000).seconds!;
    // A jitter — a hair slower — does not raise it; filling at a third of the rate does.
    expect(hold.update(7.5, 5_000).seconds).toBeLessThanOrEqual(before);
    expect(hold.update(7.6, 10_000).seconds!).toBeGreaterThan(before);
  });

  it('shows no countdown for a moment’s hold, and never holds past the cap or on a buffer that stopped', () => {
    expect(new PrebufferHold(2, 0).update(0.5, 500)).toEqual({ ready: false, seconds: null });
    const long = new PrebufferHold(90, 0);
    expect(long.target).toBe(MAX_HOLD_SECS);
    expect(long.update(10, MAX_HOLD_SECS * 1000).ready).toBe(true);
    const still = new PrebufferHold(20, 0);
    expect(still.update(8, 3_000).ready).toBe(false);
    expect(still.update(8, 8_100).ready, 'the player buffers no further while held').toBe(true);
  });

  it('reads as minutes and seconds', () => {
    expect(countdownLabel(24)).toBe('Starts in 0:24');
    expect(countdownLabel(9.2)).toBe('Starts in 0:10');
  });
});
