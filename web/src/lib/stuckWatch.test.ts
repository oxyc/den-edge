import { afterEach, describe, expect, it, vi } from 'vitest';
import { stuckWatch } from './stuckWatch';

describe('stuckWatch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calls the timers the way a browser allows', () => {
    // A browser's setTimeout throws "Illegal invocation" when called as a method of anything but the window; fake
    // timers don't care, so this stands in for the browser's rule.
    const set = setTimeout;
    const clear = clearTimeout;
    const strict = <T extends (...args: never[]) => unknown>(fn: T) =>
      function (this: unknown, ...args: Parameters<T>) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        return fn(...args);
      };
    vi.stubGlobal('setTimeout', strict(set));
    vi.stubGlobal('clearTimeout', strict(clear));
    const watch = stuckWatch(30_000, () => {});
    watch.progress();
    watch.stop();
  });

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

  it('counts the bytes of a fragment still loading, on a link too slow to finish one in the wait', () => {
    vi.useFakeTimers();
    const stuck = vi.fn();
    // A 20 MB segment at 3 Mbit/s: 53 s to load, no fragment finished inside the 30 s wait — but bytes keep coming.
    let loaded = 0;
    const tick = setInterval(() => (loaded += 375_000), 1_000);
    stuckWatch(30_000, stuck, () => loaded);
    vi.advanceTimersByTime(53_000);
    expect(stuck).not.toHaveBeenCalled();
    clearInterval(tick);
    // Then nothing more arrives: the check at 60 s still saw bytes since 30, the one at 90 sees none since 60.
    vi.advanceTimersByTime(36_999);
    expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stuck).toHaveBeenCalledOnce();
  });

  it('calls it stuck once nothing has arrived for the whole wait, however many requests started', () => {
    vi.useFakeTimers();
    const stuck = vi.fn();
    const watch = stuckWatch(30_000, stuck, () => 0);
    vi.advanceTimersByTime(20_000);
    watch.progress();
    vi.advanceTimersByTime(29_999);
    expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stuck).toHaveBeenCalledOnce();
  });
});
