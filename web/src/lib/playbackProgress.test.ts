import { describe, expect, it, vi } from 'vitest';
import { persistablePlaybackFraction, PlaybackProgressReporter } from './playbackProgress';

describe('persistablePlaybackFraction', () => {
  const played = { sourceEverPlayed: true };

  it('uses the shared episode and movie accidental-start floors', () => {
    expect(persistablePlaybackFraction(2_820, 8, 'episode', played)).toBeNull();
    expect(persistablePlaybackFraction(2_820, 9, 'episode', played)).not.toBeNull();
    expect(persistablePlaybackFraction(2_820, 30, 'movie', played)).toBeNull();
    expect(persistablePlaybackFraction(2_820, 31, 'movie', played)).not.toBeNull();
    expect(persistablePlaybackFraction(100, 3, 'movie', played)).toBe(0.03);
  });

  it('requires playback evidence and normalizes completion evidence', () => {
    expect(persistablePlaybackFraction(3_000, 1_500, 'episode', {})).toBeNull();
    expect(persistablePlaybackFraction(3_000, 1_500, 'episode', { everRenderedAFrame: true })).toBe(
      0.5,
    );
    expect(persistablePlaybackFraction(100, 95, 'movie', played)).toBe(1);
    expect(
      persistablePlaybackFraction(100, 91, 'movie', {
        sourceEverPlayed: true,
        creditsReached: true,
      }),
    ).toBe(1);
    expect(persistablePlaybackFraction(0, 0, 'movie', { naturallyFinished: true })).toBe(1);
  });
});

describe('PlaybackProgressReporter', () => {
  it('persists a natural end as 100% despite a short, already-reported media clock', () => {
    const write = vi.fn();
    const progress = new PlaybackProgressReporter(write);

    progress.playing();
    progress.report(91, 100);
    progress.report(91.4, 100);
    progress.complete(91.4);

    expect(write.mock.calls).toEqual([
      [0.91, 91, true],
      [1, 91, false],
    ]);
  });

  it('does not let teardown downgrade completion, but reports a deliberate replay', () => {
    const write = vi.fn();
    const progress = new PlaybackProgressReporter(write);

    progress.complete(91);
    progress.report(92, 100);
    progress.complete(93);
    progress.playing();
    progress.report(10, 100);

    expect(write.mock.calls).toEqual([
      [1, 91, false],
      [0.1, 10, true],
    ]);
  });

  it('writes the first part-way position once per start or resume, and nothing more until the next', () => {
    const write = vi.fn();
    const progress = new PlaybackProgressReporter(write, 'episode');

    // Not started yet: nothing.
    progress.reportStart(5, 1_000);
    progress.playing();
    // Still at the very start: nothing yet, and the start write waits for a part-way position.
    progress.reportStart(0, 1_000);
    progress.reportStart(0.4, 1_000);
    progress.reportStart(2.2, 1_000);
    progress.reportStart(8, 1_000);
    progress.reportStart(9, 1_000);
    progress.reportStart(10, 1_000);
    // Paused: the pause writes, then the resume writes once the clock leaves that second.
    progress.paused();
    progress.report(20.2, 1_000);
    progress.playing();
    progress.reportStart(20.6, 1_000);
    progress.reportStart(21.1, 1_000);
    progress.reportStart(22, 1_000);

    expect(write.mock.calls.map(([, seconds, playing]) => [seconds, playing])).toEqual([
      [9, true],
      [20, false],
      [20, true],
    ]);
  });
});
