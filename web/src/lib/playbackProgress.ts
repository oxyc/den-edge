import { RESUME_FLOOR, WATCHED } from './actions';

export type ProgressWrite = (fraction: number, seconds: number, playing: boolean) => void;

export type PlaybackContent = 'movie' | 'episode';

export interface PlaybackEvidence {
  readonly naturallyFinished?: boolean;
  readonly creditsReached?: boolean;
  readonly everRenderedAFrame?: boolean;
  readonly sourceEverPlayed?: boolean;
}

export const PLAYBACK_PROGRESS_SAVE_MS = 30_000;

/**
 * The web form of DenKit's PlaybackProgressPersistencePolicy. Storage and authority fencing remain with each
 * client; evidence, accidental-start floors and completion normalization must agree everywhere.
 */
export function persistablePlaybackFraction(
  duration: number,
  currentTime: number,
  content: PlaybackContent,
  evidence: PlaybackEvidence,
): number | null {
  const provesPlayback =
    evidence.naturallyFinished || evidence.everRenderedAFrame || evidence.sourceEverPlayed;
  if (!provesPlayback || !Number.isFinite(currentTime) || currentTime < 0) return null;
  if (evidence.naturallyFinished && (!Number.isFinite(duration) || duration <= 0)) return 1;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const measured = Math.min(1, Math.max(0, currentTime / duration));
  const minimumSeconds = content === 'episode' ? 8 : 30;
  if (measured <= RESUME_FLOOR && currentTime <= minimumSeconds) return null;
  if (evidence.naturallyFinished || evidence.creditsReached || measured >= WATCHED) return 1;
  return measured;
}

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
  private sourceEverPlayed = false;
  private isPlaying = false;
  private reportedPlaying: boolean | undefined;
  /** Playback started or resumed and no position has been written since. */
  private starting = false;

  constructor(
    private readonly write: ProgressWrite,
    private readonly content: PlaybackContent = 'movie',
  ) {}

  playing() {
    this.completed = false;
    this.sourceEverPlayed = true;
    this.starting = true;
    this.isPlaying = true;
  }

  paused() {
    this.isPlaying = false;
  }

  /**
   * The first eligible position after playback starts or resumes, written at once rather than at the next periodic
   * report: another device of the same profile (the Apple TV) pauses itself when it sees this one start. The shared
   * accidental-start floor keeps a briefly sampled title out of Continue Watching.
   */
  reportStart(currentTime: number, duration: number, evidence: PlaybackEvidence = {}) {
    if (this.starting) this.report(currentTime, duration, 0, evidence);
  }

  report(currentTime: number, duration: number, slack = 0, evidence: PlaybackEvidence = {}) {
    if (this.completed) return;
    const fraction = persistablePlaybackFraction(duration, currentTime, this.content, {
      ...evidence,
      sourceEverPlayed: evidence.sourceEverPlayed || this.sourceEverPlayed,
    });
    if (fraction === null) return;
    const second = Math.floor(currentTime);
    if (
      this.reported >= 0 &&
      Math.abs(second - this.reported) <= slack &&
      this.reportedPlaying === this.isPlaying
    )
      return;
    this.reported = second;
    this.reportedPlaying = this.isPlaying;
    this.starting = false;
    this.write(fraction, second, this.isPlaying);
  }

  complete(currentTime: number) {
    if (this.completed) return;
    const second = Number.isFinite(currentTime) ? Math.max(0, Math.floor(currentTime)) : 0;
    this.completed = true;
    this.reported = second;
    this.isPlaying = false;
    this.reportedPlaying = false;
    this.write(1, second, false);
  }
}
