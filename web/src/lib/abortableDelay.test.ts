import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableDelay, withDeadline } from './abortableDelay';

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

describe('withDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves its owning lifetime and exact abort reason', () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const reason = new DOMException('authority replaced', 'AbortError');
    const signal = withDeadline(15_000, owner.signal);

    owner.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it('uses the owner reason when it was already aborted', () => {
    const owner = new AbortController();
    const reason = new Error('closed');
    owner.abort(reason);

    const signal = withDeadline(15_000, owner.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it('returns the deadline itself when there is no owner', () => {
    const deadline = new AbortController().signal;
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline);

    expect(withDeadline(500)).toBe(deadline);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(500);
  });
});
