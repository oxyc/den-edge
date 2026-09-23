// Holding a copy's start until it can play through (`prebuffer` in the session answer), with an honest countdown.

/** The longest any start is held: den-remux ranks a copy that needs more below a transcode, and this is the cap. */
export const MAX_HOLD_SECS = 30;
/** Holds shorter than this show no countdown: a moment, not a wait to explain. */
export const COUNTDOWN_FROM_SECS = 3;
/** A buffer that has stood still this long won't grow however long the start is held: it lets go. */
export const STILL_BUFFER_MS = 5_000;
/** How far above what the viewer saw a new estimate must be before the countdown goes back up. */
const RAISE_AFTER_SECS = 2;

/**
 * Holds a start until `target` seconds are buffered ahead — `prebuffer`, capped at MAX_HOLD_SECS — and says how long
 * that will take. The estimate comes from the rate the buffer is filling at, not a clock: it counts down with the bytes.
 * It never goes back up by less than RAISE_AFTER_SECS, so a buffer that jitters doesn't make the number jump about.
 */
export class PrebufferHold {
  readonly target: number;
  private shown: number | null = null;
  private grew: { at: number; ahead: number };

  constructor(
    prebuffer: number,
    private readonly began: number,
  ) {
    this.target = Math.min(Math.max(prebuffer, 0), MAX_HOLD_SECS);
    this.grew = { at: began, ahead: 0 };
  }

  /** Whether the hold shows a countdown at all. */
  get counts(): boolean {
    return this.target > COUNTDOWN_FROM_SECS;
  }

  /** With `ahead` seconds buffered at `now` (ms): whether to start playing, and the seconds to show until then. */
  update(ahead: number, now: number): { ready: boolean; seconds: number | null } {
    if (ahead > this.grew.ahead) this.grew = { at: now, ahead };
    const elapsed = (now - this.began) / 1000;
    const ready =
      ahead >= this.target ||
      elapsed >= MAX_HOLD_SECS ||
      (now - this.grew.at >= STILL_BUFFER_MS && ahead > 0);
    if (ready) return { ready, seconds: null };
    // Media seconds buffered per second waited; before two seconds of it, the wait den-remux worked out stands.
    const filling = elapsed >= 2 && ahead > 0 ? ahead / elapsed : null;
    const left = Math.min(
      filling ? (this.target - ahead) / filling : this.target - elapsed,
      MAX_HOLD_SECS - elapsed,
    );
    if (this.shown === null || left < this.shown || left > this.shown + RAISE_AFTER_SECS)
      this.shown = Math.max(left, 0);
    return { ready, seconds: this.counts ? Math.ceil(this.shown) : null };
  }
}

/** `Starts in 0:24`. */
export function countdownLabel(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `Starts in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
