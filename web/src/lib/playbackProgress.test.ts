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
});
