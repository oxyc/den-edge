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

  it('keeps what each library Worker’s open did by the library it serves, the first of each', async () => {
    vi.useRealTimers();
    const page = await load();
    // A Worker's copy: no document, and the page's time origin as its name.
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('name', String(performance.timeOrigin));
    const profile = await import('./startupTiming');
    profile.startupMark('den-core requested');
    profile.startupLibraryWorker('profile', 'facts');
    profile.startupLibraryPromoted('selection:continue');
    profile.startupLibraryPromoted('import:stopped');
    vi.resetModules();
    const household = await import('./startupTiming');
    household.startupLibraryWorker('household', 'saved');
    household.startupLibraryPromoted('task:assistant.publish');
    household.startupMark('den-core requested');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.startupLibraryWorkers()).toEqual({
      profile: {
        views: 'facts',
        coreRequestedMs: expect.any(Number),
        promoted: 'selection',
        selection: 'continue',
      },
      household: { views: 'saved', promoted: 'task', coreRequestedMs: expect.any(Number) },
    });
  });

  it('reduces a failure to its code and message', async () => {
    const { startupFailure } = await load();
    expect(
      startupFailure({ failure: { code: 'unavailable', message: 'library service is down' } }),
    ).toBe('unavailable: library service is down');
    expect(startupFailure(new Error('boom'))).toBe('boom');
    expect(startupFailure('not an error')).toBe('unknown error');
  });

  it('attributes long tasks only to fixed privacy-safe render phases', async () => {
    let observed!: (list: { getEntries(): PerformanceEntry[] }) => void;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask'];
        constructor(callback: typeof observed) {
          observed = callback;
        }
        observe() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const { startupLongTaskPhases, startupRenderPhase } = await load();
    const startTime = performance.now();
    startupRenderPhase('home_shelves');
    vi.advanceTimersByTime(81);
    observed({ getEntries: () => [{ startTime, duration: 81 } as PerformanceEntry] });
    observed({
      getEntries: () => [{ startTime: startTime - 100, duration: 55 } as PerformanceEntry],
    });

    expect(Object.fromEntries(startupLongTaskPhases())).toEqual({
      home_shelves: [1, 81, 81],
      other: [1, 55, 55],
    });
  });

  it('keeps bootstrap open while a separately downloaded application evaluates', async () => {
    let observed!: (list: { getEntries(): PerformanceEntry[] }) => void;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask'];
        constructor(callback: typeof observed) {
          observed = callback;
        }
        observe() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const { beginStartupRenderPhase, startupLongTaskPhases } = await load();
    const started = performance.now();
    const applicationEvaluated = beginStartupRenderPhase('bootstrap');

    vi.advanceTimersByTime(500);
    observed({
      getEntries: () => [{ startTime: started + 400, duration: 80 } as PerformanceEntry],
    });
    expect(frames).toHaveLength(0);

    applicationEvaluated();
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    frames.shift()!(0);
    expect(Object.fromEntries(startupLongTaskPhases())).toEqual({
      bootstrap: [1, 80, 80],
    });
  });
});
