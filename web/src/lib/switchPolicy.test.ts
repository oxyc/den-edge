import { describe, expect, it } from 'vitest';
import {
  averageBitrate,
  bytesBetween,
  DeliveryMeter,
  EARLY_WINDOW_SECS,
  FIRST_FRAME_WAIT_SECS,
  LIGHTER_SHARE,
  NATIVE_MIN_STALLS,
  NATIVE_STALLED_SECS,
  scaleDemand,
  shouldSwitch,
  switchAsk,
  tooSlow,
  waitAt,
  type Demand,
} from './switchPolicy';

/**
 * The first 72 s of a 1080p HEVC WEB-DL as den-remux cut it, from its GOP files: 26.8 s of titles at about 1 Mbit/s,
 * then a scene at 13–20 Mbit/s. Its average over the whole film is 5.3 Mbit/s.
 */
const film: Demand = [
  [0, 1_387_892],
  [10.427, 1_387_892],
  [20.854, 857_310],
  [26.777, 20_233_883],
  [37.204, 21_416_856],
  [46.964, 4_676_768],
  [49.132, 16_898_311],
  [57.015, 17_113_752],
  [67.442, 11_414_975],
];
const end = 72.489;

describe('waitAt', () => {
  it('is den-remux’s bucket: each segment in by the time the play head reaches it', () => {
    const tiny: Demand = [
      [0, 600],
      [6, 600],
      [12, 300],
    ];
    // playlist.rs: 600 bit/s from the start needs 10 s.
    expect(waitAt(tiny, 15, 0, 0, 600)).toBeCloseTo(10);
    // What is buffered is not fetched again: with the first segment in, the second takes 8 s and is due in 6.
    expect(waitAt(tiny, 15, 0, 6, 600)).toBeCloseTo(2);
    expect(waitAt(tiny, 15, 0, 0, 0)).toBe(Infinity);
  });

  it('tells variance from a link that can’t carry the film', () => {
    // On 15 Mbit/s only the scene's peaks exceed the link, and a second's wait rides them out.
    expect(waitAt(film, end, 0, 0, 15_000_000)).toBeLessThan(2);
    // On 6 Mbit/s the scene outruns the link for as long as it lasts: well past what a playing viewer waits.
    expect(waitAt(film, end, 0, 0, 6_000_000)).toBeGreaterThan(40);
  });

  it('prices what a buffer reaches by the segments it covers', () => {
    expect(bytesBetween(film, end, 0, 10.427)).toBeCloseTo(1_387_892);
    expect(bytesBetween(film, end, 5.2135, 10.427)).toBeCloseTo(1_387_892 / 2);
  });
});

describe('DeliveryMeter', () => {
  it('measures bytes over wall time, the gaps between fragments included', () => {
    const meter = new DeliveryMeter();
    // Two 1 MB fragments, each taking a second, a second apart: 8 Mbit over 3 s.
    meter.add(1_000, 1_000_000, 0);
    meter.add(3_000, 1_000_000, 2_000);
    expect(meter.rate()).toEqual({ bitsPerSecond: (2_000_000 * 8) / 3, spanMs: 3_000 });
  });

  it('follows how far a buffer reaches, for a player that shows no requests', () => {
    const meter = new DeliveryMeter();
    // Already buffered when counting starts: not bytes that arrived in no time.
    meter.reached(0, 5_000_000);
    meter.reached(2_000, 6_000_000);
    meter.reached(4_000, 8_000_000);
    expect(meter.rate()?.bitsPerSecond).toBe(6_000_000);
  });

  it('keeps to the recent window', () => {
    const meter = new DeliveryMeter();
    meter.add(0, 10_000_000, 0);
    for (let t = 30_000; t <= 60_000; t += 1_000) meter.add(t, 125_000);
    // The early burst has left the window: what is left is 1 Mbit/s.
    expect(meter.rate()?.bitsPerSecond).toBeCloseTo(1_000_000, -3);
  });
});

describe('shouldSwitch', () => {
  const early = { playedSecs: 8, shownFrame: true };
  const late = { playedSecs: EARLY_WINDOW_SECS + 60, shownFrame: true };
  const measured = (rate: number) => ({
    kind: 'delivery' as const,
    wait: waitAt(film, end, 8, 20, rate),
    measuredMs: 8_000,
    aheadSecs: 2,
  });

  it('rides out a stall where the live rate carries the film with a short wait', () => {
    expect(shouldSwitch(measured(15_000_000), early)).toBe(false);
  });

  it('switches early where the live rate is below what the film keeps asking', () => {
    expect(shouldSwitch(measured(6_000_000), early)).toBe(true);
  });

  it('never switches for delivery past the early window', () => {
    expect(shouldSwitch(measured(6_000_000), late)).toBe(false);
  });

  it('waits for a measurement that means something', () => {
    expect(shouldSwitch({ ...measured(1_000_000), measuredMs: 1_500 }, early)).toBe(false);
  });

  it('tolerates a longer wait before the first frame than once playing', () => {
    const wait = { kind: 'delivery' as const, wait: 20, measuredMs: 8_000, aheadSecs: 0 };
    expect(shouldSwitch(wait, { playedSecs: 0, shownFrame: false })).toBe(false);
    expect(shouldSwitch(wait, { playedSecs: 0, shownFrame: true })).toBe(true);
  });

  it('switches for a decoder that can’t go on, early or late', () => {
    expect(shouldSwitch({ kind: 'decode' }, early)).toBe(true);
    expect(shouldSwitch({ kind: 'decode' }, late)).toBe(true);
  });

  it('reads nothing into a buffer that stopped growing: no rate is no measurement', () => {
    // What a native player's buffer gives between bursts, or any player's while it is ahead: 0 bits a second.
    const still = { kind: 'delivery' as const, wait: Infinity, measuredMs: 20_000, aheadSecs: 0 };
    expect(shouldSwitch(still, early)).toBe(false);
  });

  it('never switches a player that has a buffer ahead of it', () => {
    expect(shouldSwitch({ ...measured(6_000_000), aheadSecs: 25 }, early)).toBe(false);
  });

  it('moves a native player only on stalls it sat through, more than one and long', () => {
    const stalls = (n: number, secs: number) => ({
      kind: 'stalls' as const,
      stalls: n,
      stalledSecs: secs,
    });
    expect(shouldSwitch(stalls(1, NATIVE_STALLED_SECS + 10), early)).toBe(false);
    expect(shouldSwitch(stalls(NATIVE_MIN_STALLS, NATIVE_STALLED_SECS - 1), early)).toBe(false);
    expect(shouldSwitch(stalls(NATIVE_MIN_STALLS, NATIVE_STALLED_SECS), early)).toBe(true);
    // One stall that goes on as long as a viewer waits for a start is as sure.
    expect(shouldSwitch(stalls(1, FIRST_FRAME_WAIT_SECS), early)).toBe(true);
    // Before its first frame a native player has stalled through nothing.
    expect(shouldSwitch(stalls(3, 40), { playedSecs: 0, shownFrame: false })).toBe(false);
    expect(shouldSwitch(stalls(3, 40), late)).toBe(false);
    // `tooSlow` is the same judgement without the early window: what a viewer's own pick is warned on.
    expect(tooSlow(stalls(3, 40), true)).toBe(true);
  });
});

describe('averageBitrate', () => {
  it('is den-remux’s bytes over the length, else the file’s size, never anything else', () => {
    expect(
      averageBitrate(
        [
          [0, 500_000],
          [2, 500_000],
        ],
        4,
      ),
    ).toBe(2_000_000);
    expect(averageBitrate(null, 2054, 547_008_511)).toBeCloseTo(2_130_510, -1);
    expect(averageBitrate(undefined, 0, 547_008_511)).toBeUndefined();
    expect(averageBitrate([], 60)).toBeUndefined();
  });
});

describe('scaleDemand', () => {
  it('weighs the film by the share of what was said that really came', () => {
    // Half of what den-remux counted arrived for the fragments loaded: the film asks half as much of the link.
    const half = scaleDemand(film, { bytes: 5_000_000, demand: 10_000_000 });
    expect(half[3]).toEqual([26.777, 20_233_883 / 2]);
    expect(waitAt(half, end, 0, 0, 6_000_000)).toBeLessThan(waitAt(film, end, 0, 0, 6_000_000));
    expect(scaleDemand(film, { bytes: 0, demand: 0 })).toBe(film);
  });
});

describe('switchAsk', () => {
  it('never asks for a transcode, and not for a release it moved away from', () => {
    for (const reason of ['decode', 'delivery'] as const) {
      const ask = switchAsk(reason, 'b.mkv', ['a.mkv'], { rate: 6_000_000, bitrate: 9_000_000 });
      expect(ask?.transcode).toBe('never');
      expect(ask?.exclude).toEqual(['a.mkv', 'b.mkv']);
    }
  });

  it('asks, for delivery, only for a copy that fits the rate the link is really giving', () => {
    expect(
      switchAsk('delivery', 'b.mkv', [], { rate: 6_000_000, bitrate: 9_000_000 }),
    ).toMatchObject({ fitsOnly: true, maxBitrate: 5_100_000 });
    // A decoder's refusal says nothing about the link: the session's own limit stands.
    expect(switchAsk('decode', 'b.mkv', [])).not.toHaveProperty('fitsOnly');
    expect(switchAsk('decode', 'b.mkv', [])).not.toHaveProperty('maxBitrate');
  });

  it('asks, for delivery, only for a copy lighter than the one playing, however fast the link reads', () => {
    // The evening's "6.3 GB" (2.1 Mbit/s a file) left for the "13 GB" pack's 4.4 Mbit/s episode: never again.
    const ask = switchAsk('delivery', 'b.mkv', [], { rate: 30_000_000, bitrate: 2_100_000 });
    expect(ask).toMatchObject({
      fitsOnly: true,
      maxBitrate: Math.round(2_100_000 * LIGHTER_SHARE),
    });
    // No rate measured — a native player, or a buffer that stood still — is still a lighter copy, not any copy.
    expect(switchAsk('delivery', 'b.mkv', [], { rate: 0, bitrate: 2_100_000 })).toMatchObject({
      fitsOnly: true,
      maxBitrate: Math.round(2_100_000 * LIGHTER_SHARE),
    });
    // Nothing known of the playing copy: nothing can be called lighter, and no switch is asked for.
    expect(switchAsk('delivery', 'b.mkv', [], { rate: 30_000_000 })).toBeNull();
  });
});
