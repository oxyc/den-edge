import { afterEach, describe, expect, it, vi } from 'vitest';
import { stuckWatch } from './stuckWatch';

describe('stuckWatch', () => {
  afterEach(() => vi.useRealTimers());

  it('does not call a slow load that keeps arriving stuck', () => {
    vi.useFakeTimers();
    const stuck = vi.fn();
    const watch = stuckWatch(30_000, stuck);
    // A 20 MB segment over 6.5 Mbit/s: a fragment every 25 s, the first picture only after a minute and a half.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25_000);
      watch.progress();
    }
    expect(stuck).not.toHaveBeenCalled();
    watch.stop();
    vi.advanceTimersByTime(60_000);
    expect(stuck).not.toHaveBeenCalled();
  });

  it('calls it stuck once nothing has arrived for the whole wait', () => {
    vi.useFakeTimers();
    const stuck = vi.fn();
    const watch = stuckWatch(30_000, stuck);
    vi.advanceTimersByTime(20_000);
    watch.progress();
    vi.advanceTimersByTime(29_999);
    expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stuck).toHaveBeenCalledOnce();
  });
});
