import { afterEach, expect, it, vi } from 'vitest';
import { whenIdle } from './idle';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('cancels queued component work before its idle callback runs', async () => {
  let idle!: IdleRequestCallback;
  const cancelIdle = vi.fn();
  vi.stubGlobal('navigator', { connection: {} });
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn((callback: IdleRequestCallback) => {
      idle = callback;
      return 17;
    }),
  );
  vi.stubGlobal('cancelIdleCallback', cancelIdle);
  const task = vi.fn();
  const cancel = whenIdle(task);
  await Promise.resolve();
  cancel();
  idle?.({ didTimeout: false, timeRemaining: () => 10 });
  await Promise.resolve();
  expect(cancelIdle).toHaveBeenCalledWith(17);
  expect(task).not.toHaveBeenCalled();
});

it('clears the hold-limit timer when idle work finishes promptly', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { connection: {} });
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callback({ didTimeout: false, timeRemaining: () => 10 });
    return 18;
  });
  const task = vi.fn();

  whenIdle(task);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();

  expect(task).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
