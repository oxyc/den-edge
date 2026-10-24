import { describe, expect, it, vi } from 'vitest';
import { PlaybackProgressReporter } from './playbackProgress';

describe('PlaybackProgressReporter', () => {
  it('persists a natural end as 100% despite a short, already-reported media clock', () => {
    const write = vi.fn();
    const progress = new PlaybackProgressReporter(write);

    progress.playing();
    progress.report(91, 100);
    progress.report(91.4, 100);
    progress.complete(91.4);

    expect(write.mock.calls).toEqual([
      [0.91, 91],
      [1, 91],
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
      [1, 91],
      [0.1, 10],
    ]);
  });

  it('writes the first part-way position once per start or resume, and nothing more until the next', () => {
    const write = vi.fn();
    const progress = new PlaybackProgressReporter(write);

    // Not started yet: nothing.
    progress.reportStart(5, 100);
    progress.playing();
    // Still at the very start: nothing yet, and the start write waits for a part-way position.
    progress.reportStart(0, 100);
    progress.reportStart(0.4, 100);
    progress.reportStart(2.2, 100);
    progress.reportStart(3, 100);
    progress.reportStart(4, 100);
    // Paused: the pause writes, then the resume writes once the clock leaves that second.
    progress.report(20.2, 100);
    progress.playing();
    progress.reportStart(20.6, 100);
    progress.reportStart(21.1, 100);
    progress.reportStart(22, 100);

    expect(write.mock.calls.map(([, seconds]) => seconds)).toEqual([2, 20, 21]);
  });
});
