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

  it('gives a nested specific phase an equal-overlap task instead of its broad parent', async () => {
    let observed!: (list: { getEntries(): PerformanceEntry[] }) => void;
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
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const { beginStartupRenderPhase, startupLongTaskPhases } = await load();
    beginStartupRenderPhase('app_import');
    vi.advanceTimersByTime(100);
    const started = performance.now();
    beginStartupRenderPhase('app_mount');
    vi.advanceTimersByTime(80);
    observed({
      getEntries: () => [{ startTime: started, duration: 80 } as PerformanceEntry],
    });

    expect(Object.fromEntries(startupLongTaskPhases())).toEqual({ app_mount: [1, 80, 80] });
  });

  it('drains queued observer records before the load report snapshots its totals', async () => {
    const pending = [{ startTime: performance.now(), duration: 73 } as PerformanceEntry];
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask'];
        constructor(_callback: unknown) {}
        observe() {}
        takeRecords() {
          return pending.splice(0);
        }
      },
    );
    const { startupLongTaskPhases, startupLongTasks } = await load();

    expect(startupLongTasks()).toEqual([1, 73, 73]);
    expect(Object.fromEntries(startupLongTaskPhases())).toEqual({ other: [1, 73, 73] });
    expect(startupLongTasks(), 'a drained record is counted only once').toEqual([1, 73, 73]);
  });

  it('places every task in one coarse interval between startup milestones', async () => {
    let observed!: (list: { getEntries(): PerformanceEntry[] }) => void;
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
    const { startupLongTaskStages, startupMark } = await load();
    const task = (startTime: number, duration: number) =>
      ({ startTime, duration }) as PerformanceEntry;
    observed({ getEntries: () => [task(25, 51)] });
    vi.advanceTimersByTime(100);
    startupMark('app module requested');
    vi.advanceTimersByTime(100);
    startupMark('app module evaluated');
    vi.advanceTimersByTime(100);
    startupMark('app mounted');
    vi.advanceTimersByTime(200);
    startupMark('shelves ready');
    vi.advanceTimersByTime(200);
    startupMark('billboard detail');
    vi.advanceTimersByTime(100);
    startupMark('handover');
    vi.advanceTimersByTime(100);
    startupMark('first poster');
    observed({
      getEntries: () => [
        task(125, 52),
        task(225, 53),
        task(325, 54),
        task(525, 55),
        task(725, 56),
        task(825, 57),
        task(925, 58),
      ],
    });

    expect(Object.fromEntries(startupLongTaskStages())).toEqual({
      pre_app: [1, 51, 51],
      app_import: [1, 52, 52],
      app_mount: [1, 53, 53],
      before_shelves: [1, 54, 54],
      shelves_to_billboard: [1, 55, 55],
      billboard_to_handover: [1, 56, 56],
      handover_to_poster: [1, 57, 57],
      after_poster: [1, 58, 58],
    });
  });
});
