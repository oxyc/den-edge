export type ProgressWrite = (fraction: number, seconds: number) => void;

/**
 * Reports a player's sampled position and its authoritative natural end.
 *
 * Completion does not pass through the sampled-position de-duplication: an `ended` event is stronger evidence than
 * the media clock, which can stop short of the declared duration. Once complete, late pause/pagehide events cannot
 * replace 100% with that short clock. Playing again opens reporting for a new viewing.
 */
export class PlaybackProgressReporter {
  private reported = -1;
  private completed = false;
  /** Playback started or resumed and no position has been written since. */
  private starting = false;

  constructor(private readonly write: ProgressWrite) {}

  playing() {
    this.completed = false;
    this.starting = true;
  }

  /**
   * The first part-way position after playback starts or resumes, written at once rather than at the next periodic
   * report: another device of the same profile (the Apple TV) pauses itself when it sees this one start.
   */
  reportStart(currentTime: number, duration: number) {
    if (this.starting) this.report(currentTime, duration);
  }

  report(currentTime: number, duration: number, slack = 0) {
    if (
      this.completed ||
      !Number.isFinite(currentTime) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      currentTime < 1
    )
      return;
    const second = Math.floor(currentTime);
    if (this.reported >= 0 && Math.abs(second - this.reported) <= slack) return;
    this.reported = second;
    this.starting = false;
    this.write(currentTime / duration, second);
  }

  complete(currentTime: number) {
    if (this.completed) return;
    const second = Number.isFinite(currentTime) ? Math.max(0, Math.floor(currentTime)) : 0;
    this.completed = true;
    this.reported = second;
    this.write(1, second);
  }
}
