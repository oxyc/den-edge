// When a playing session may move to another release, and on what evidence. Whether a title plays is decided when
// den-remux chooses a release, before the first frame — a transcode included, which is never a way out of playback.
// This is the narrow exception: a copy that turns out, in its first seconds, to be one this player can't be given.
//
// Three tiers. Deliver this release well where only its peaks exceed the link: a buffer rides those out, and moving
// to a smaller release would cost picture for nothing. Switch early to another copy where the link can't carry this
// one at all: the deficit grows without bound and no buffer saves it. And a transcode only ever at selection.

import type { Want } from './remux';

/**
 * Seconds of playing, from a session's start, in which a switch is still cheap: about five of den-remux's 6 s
 * segments. The viewer has seen little, and the player has fetched little it would throw away. Counted in playing
 * time, which the player has at every `timeupdate`, rather than in segments, which the native player never shows.
 */
export const EARLY_WINDOW_SECS = 30;
/**
 * The most a player that hasn't shown a frame yet is willing to wait on top of what it has: the viewer is already
 * waiting for a start, and another release would cost a start of its own. As long as the most a player holds ahead.
 */
export const FIRST_FRAME_WAIT_SECS = 30;
/**
 * The most a player that is playing is willing to wait: den-remux's own bound on the wait before a start. Past it the
 * wait is a stall the viewer sits through, and one that a longer buffer won't end.
 */
export const PLAYING_WAIT_SECS = 10;
/** Delivery measured over less than this says more about one request than about the link. */
export const MIN_MEASURE_MS = 4_000;
/** The span the live rate is taken over: the recent link, not the start's. */
export const MEASURE_WINDOW_MS = 20_000;

/** Each segment's `[start, bytes]`, as den-remux sends them for a copy. */
export type Demand = readonly (readonly [start: number, bytes: number])[];

/** The bytes of `demand` between `from` and `to` seconds, a segment's in proportion to how much of it lies between. */
export function bytesBetween(demand: Demand, duration: number, from: number, to: number): number {
  let bytes = 0;
  for (let k = 0; k < demand.length; k++) {
    const [start, size] = demand[k]!;
    const end = demand[k + 1]?.[0] ?? duration;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0 && end > start) bytes += (size * overlap) / (end - start);
  }
  return bytes;
}

/**
 * `demand` scaled by what really came against what it said for the same stretches: the bytes of the fragments loaded,
 * over `demand`'s bytes for their spans. As it is where nothing has been weighed yet.
 */
export function scaleDemand(demand: Demand, seen: { bytes: number; demand: number }): Demand {
  if (!(seen.bytes > 0 && seen.demand > 0)) return demand;
  const share = seen.bytes / seen.demand;
  return demand.map(([start, bytes]) => [start, bytes * share] as const);
}

/**
 * How long a player at `position`, with media buffered to `bufferedEnd`, has to wait at `rate` bits a second before
 * it then plays through without running dry: den-remux's leaky bucket (`playlist::startup_delay`) over what isn't
 * buffered yet. Each segment past the buffer has to be in by the time the play head reaches it.
 */
export function waitAt(
  demand: Demand,
  duration: number,
  position: number,
  bufferedEnd: number,
  rate: number,
): number {
  if (!(rate > 0)) return Infinity;
  let fetched = 0;
  let wait = 0;
  for (let k = 0; k < demand.length; k++) {
    const [start, size] = demand[k]!;
    const end = demand[k + 1]?.[0] ?? duration;
    if (end <= bufferedEnd || end <= start) continue;
    const from = Math.max(start, bufferedEnd);
    fetched += (size * (end - from) * 8) / (end - start);
    wait = Math.max(wait, fetched / rate - (from - position));
  }
  return wait;
}

/**
 * The rate a session's media actually arrives at: bytes over wall time across the last MEASURE_WINDOW_MS, gaps
 * included — what the link gives this player now, not what a probe of it read once.
 */
export class DeliveryMeter {
  /** `[ms, bytes arrived by then]`, oldest first. */
  private samples: [number, number][] = [];
  private total = 0;

  /** `bytes` more had arrived by `at` (ms); `since`, where known, is when the request for them went out. */
  add(at: number, bytes: number, since?: number) {
    if (!this.samples.length) this.samples.push([since ?? at, 0]);
    this.total += Math.max(0, bytes);
    this.samples.push([at, this.total]);
    const keep = at - MEASURE_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]![0] <= keep) this.samples.shift();
  }

  /**
   * All that had arrived by `at` (ms): for a player that sees only how far its buffer reaches. The first reading is
   * where counting starts, not bytes that arrived in no time.
   */
  reached(at: number, bytes: number) {
    if (!this.samples.length) {
      this.total = bytes;
      this.samples.push([at, bytes]);
      return;
    }
    this.add(at, bytes - this.total);
  }

  /** Bits a second over the window, and the milliseconds it spans; null before anything arrived. */
  rate(): { bitsPerSecond: number; spanMs: number } | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last[0] <= first[0]) return null;
    const spanMs = last[0] - first[0];
    return { bitsPerSecond: ((last[1] - first[1]) * 8000) / spanMs, spanMs };
  }
}

/**
 * The share of the rate a session is really getting that a switch away from it may ask for. The live rate is what
 * the link gave this player, not a probe's guess at it, so less is held back than the probe's 70 %: room to dip.
 */
export const LIVE_HEADROOM = 0.85;

/**
 * What a switch adds to its session request: never a transcode, not the release playing now or one switched away
 * from before, and — for delivery — only a copy that fits what the link is really giving.
 */
export function switchAsk(
  reason: 'decode' | 'delivery',
  playing: string,
  excluded: readonly string[],
  rate?: number,
): Pick<Want, 'exclude' | 'transcode' | 'fitsOnly' | 'maxBitrate'> {
  return {
    exclude: [...excluded, playing],
    transcode: 'never',
    ...(reason === 'delivery' && rate
      ? { fitsOnly: true, maxBitrate: Math.round(rate * LIVE_HEADROOM) }
      : {}),
  };
}

/** What a playing session saw that might move it to another release. */
export type Signal =
  /** The decoder refused what it said it takes, and can't go on. */
  | { kind: 'decode' }
  /** Delivery: the wait `waitAt` gives at the live rate (what is buffered already counted in it), and over how long that rate was measured. */
  | { kind: 'delivery'; wait: number; measuredMs: number };

/**
 * Whether a session moves to another release on `signal`, `playedSecs` into its playing, having shown a frame or not.
 * A decoder that can't go on is a hard impossibility at any time, and the play head is kept. Delivery moves it only
 * early, only on a rate measured long enough to mean something, and only when even waiting as long as a viewer would
 * wouldn't carry it through — never on a stall alone, which a spike and a buffer that was too short also give.
 */
export function shouldSwitch(
  signal: Signal,
  { playedSecs, shownFrame }: { playedSecs: number; shownFrame: boolean },
): boolean {
  if (signal.kind === 'decode') return true;
  if (playedSecs >= EARLY_WINDOW_SECS || signal.measuredMs < MIN_MEASURE_MS) return false;
  return signal.wait > (shownFrame ? PLAYING_WAIT_SECS : FIRST_FRAME_WAIT_SECS);
}
