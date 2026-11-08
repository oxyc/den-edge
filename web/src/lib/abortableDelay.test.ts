import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableDelay } from './abortableDelay';

describe('abortableDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears its timer and settles on the task that aborts its owner', async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    let settled = false;
    const delay = abortableDelay(15_000, owner.signal).then(() => (settled = true));
    expect(vi.getTimerCount()).toBe(1);

    owner.abort();
    await delay;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('also leaves no timer after its ordinary deadline', async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    const delay = abortableDelay(500, owner.signal);
    await vi.advanceTimersByTimeAsync(500);
    await delay;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
