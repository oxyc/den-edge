import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../vendor/den-core/startup.js');
  vi.doUnmock('../vendor/den-core/deferred.js');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function loader(
  initializeStartup = vi.fn().mockResolvedValue(undefined),
  initializeDeferred = vi.fn().mockResolvedValue(undefined),
) {
  vi.resetModules();
  vi.doMock('../vendor/den-core/startup.js', () => ({ initializeStartup }));
  vi.doMock('../vendor/den-core/deferred.js', () => ({ initializeDeferred }));
  return { ...(await import('./syncLoader')), initializeStartup, initializeDeferred };
}

it('defers idle work and accelerates the same initialization when clicked', async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn(() => 17),
  );
  vi.stubGlobal('cancelIdleCallback', cancel);
  const core = await loader();
  const background = core.ensureSyncPolicy(true);
  expect(core.initializeStartup).not.toHaveBeenCalled();
  const action = core.ensureSyncPolicy();
  expect(action).toBe(background);
  expect(cancel).toHaveBeenCalledWith(17);
  await Promise.all([background, action]);
  expect(core.initializeStartup).toHaveBeenCalledTimes(1);
  await core.ensureSyncPolicy();
  expect(core.initializeStartup).toHaveBeenCalledTimes(1);
});

it('uses a timer fallback without eagerly loading', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  const core = await loader();
  core.preloadSyncPolicy();
  expect(core.initializeStartup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(core.initializeStartup).toHaveBeenCalledTimes(1);
});

it('rejects waiting actions on failure and retries on the next action', async () => {
  const initialize = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const core = await loader(initialize);
  await expect(core.ensureSyncPolicy()).rejects.toThrow('offline');
  await expect(core.ensureSyncPolicy()).resolves.toBeUndefined();
  expect(initialize).toHaveBeenCalledTimes(2);
});

it('a Worker offered the page’s compiled den-core waits for it and loads nothing of its own', async () => {
  const core = await loader();
  const startup = new MessageChannel();
  const deferred = new MessageChannel();
  core.acceptSyncPolicy(startup.port2, deferred.port2);
  const requested = new Promise((resolve) => {
    startup.port1.onmessage = (event) => resolve(event.data);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(core.initializeStartup, 'an unused offer loads nothing').not.toHaveBeenCalled();
  expect(core.initializeDeferred, 'the deferred offer stays idle').not.toHaveBeenCalled();
  const opening = core.ensureSyncPolicy();
  await expect(requested).resolves.toBe('den-core-module-request');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(core.initializeStartup, 'nothing loads before the page answers').not.toHaveBeenCalled();
  // The smallest valid wasm module: magic and version.
  const module = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  startup.port1.postMessage(module);
  await opening;
  expect(core.initializeStartup).toHaveBeenCalledTimes(1);
  expect(core.initializeStartup.mock.calls[0]![0]).toBeInstanceOf(WebAssembly.Module);
  expect(core.initializeDeferred).not.toHaveBeenCalled();
  deferred.port1.close();
});

it('a Worker whose page could not compile den-core loads its own', async () => {
  const core = await loader();
  const startup = new MessageChannel();
  const deferred = new MessageChannel();
  core.acceptSyncPolicy(startup.port2, deferred.port2);
  const requested = new Promise((resolve) => {
    startup.port1.onmessage = (event) => resolve(event.data);
  });
  const opening = core.ensureSyncPolicy();
  await requested;
  startup.port1.postMessage(null);
  await opening;
  expect(core.initializeStartup).toHaveBeenCalledWith(undefined);
  deferred.port1.close();
});

it('also retries when initialization throws before returning a promise', async () => {
  const initialize = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('setup failed');
    })
    .mockResolvedValue(undefined);
  const core = await loader(initialize);
  await expect(core.ensureSyncPolicy()).rejects.toThrow('setup failed');
  await expect(core.ensureSyncPolicy()).resolves.toBeUndefined();
});

it('keeps deferred policy unloaded until mutation work explicitly asks for it', async () => {
  const core = await loader();
  await core.ensureSyncPolicy();
  expect(core.initializeStartup).toHaveBeenCalledTimes(1);
  expect(core.initializeDeferred).not.toHaveBeenCalled();
  await core.ensureDeferredSyncPolicy();
  expect(core.initializeDeferred).toHaveBeenCalledTimes(1);
});
