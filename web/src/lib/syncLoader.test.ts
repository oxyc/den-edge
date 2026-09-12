import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.doUnmock('../vendor/den-core/index.js'); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function loader(initialize = vi.fn().mockResolvedValue(undefined)) {
  vi.resetModules();
  vi.doMock('../vendor/den-core/index.js', () => ({ initialize }));
  return { ...await import('./syncLoader'), initialize };
}

it('defers idle work and accelerates the same initialization when clicked', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', vi.fn(() => 17));
  vi.stubGlobal('cancelIdleCallback', cancel);
  const core = await loader();
  const background = core.ensureSyncPolicy(true);
  expect(core.initialize).not.toHaveBeenCalled();
  const action = core.ensureSyncPolicy();
  expect(action).toBe(background);
  expect(cancel).toHaveBeenCalledWith(17);
  await Promise.all([background, action]);
  expect(core.initialize).toHaveBeenCalledTimes(1);
  await core.ensureSyncPolicy();
  expect(core.initialize).toHaveBeenCalledTimes(1);
});

it('uses a timer fallback without eagerly loading', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  const core = await loader();
  core.preloadSyncPolicy();
  expect(core.initialize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(core.initialize).toHaveBeenCalledTimes(1);
});

it('rejects waiting actions on failure and retries on the next action', async () => {
  const initialize = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const core = await loader(initialize);
  await expect(core.ensureSyncPolicy()).rejects.toThrow('offline');
  await expect(core.ensureSyncPolicy()).resolves.toBeUndefined();
  expect(initialize).toHaveBeenCalledTimes(2);
});

it('also retries when initialization throws before returning a promise', async () => {
  const initialize = vi.fn().mockImplementationOnce(() => { throw new Error('setup failed'); }).mockResolvedValue(undefined);
  const core = await loader(initialize);
  await expect(core.ensureSyncPolicy()).rejects.toThrow('setup failed');
  await expect(core.ensureSyncPolicy()).resolves.toBeUndefined();
});
