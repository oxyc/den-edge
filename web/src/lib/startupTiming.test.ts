import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

describe('startup timing', () => {
  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;

  // The module decides at load whether it runs in a page or a Worker, and keeps its milestones in module state: load a
  // fresh copy of it, as a page, for each test.
  const load = async () => {
    vi.resetModules();
    vi.stubGlobal('document', {});
    return import('./startupTiming');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs one prefixed line per milestone with the time since navigation', async () => {
    const { startupMark } = await load();
    startupMark('capability answered', 'enabled in 3ms');
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(
      /^den: startup \+\d+ms capability answered \(enabled in 3ms\)$/,
    );
  });

  it('numbers the Workers a page starts and names why', async () => {
    const { startupWorkerCreated } = await load();
    startupWorkerCreated('session start');
    startupWorkerCreated('restart: library supervisor reconnect');
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toMatch(/worker created \(#1, session start\)$/);
    expect(lines[1]).toMatch(/worker created \(#2, restart: library supervisor reconnect\)$/);
  });

  it('summarises the last milestone when nothing replaces the frame within 15 s', async () => {
    const { startupMark, watchStartupHandover } = await load();
    startupMark('profile directory lease value', 'pending, connecting');
    watchStartupHandover();
    vi.advanceTimersByTime(14_000);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /^den: startup stalled \+\d+ms, no handover; last milestone "profile directory lease value" at \+\d+ms/,
    );
  });

  it('stays quiet once the frame is replaced', async () => {
    const { watchStartupHandover, startupHandedOver } = await load();
    watchStartupHandover();
    startupHandedOver('owner session');
    vi.advanceTimersByTime(30_000);
    expect(warn).not.toHaveBeenCalled();
    expect(String(info.mock.calls.at(-1)?.[0])).toMatch(/handover \(owner session\)$/);
  });

  it('reduces a failure to its code and message', async () => {
    const { startupFailure } = await load();
    expect(
      startupFailure({ failure: { code: 'unavailable', message: 'library service is down' } }),
    ).toBe('unavailable: library service is down');
    expect(startupFailure(new Error('boom'))).toBe('boom');
    expect(startupFailure('not an error')).toBe('unknown error');
  });
});
