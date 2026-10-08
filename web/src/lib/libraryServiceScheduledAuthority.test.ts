import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryObservation } from './libraryServiceProtocol';
import type { LibraryAuthorityEvent, LibraryServiceAuthority } from './libraryServiceCore';
import {
  ACTIVE_PLAYBACK_REFRESH_MS,
  ScheduledLibraryServiceAuthority,
  VISIBLE_REFRESH_MS,
  type LibraryMaintenance,
  type LibraryMaintenanceResult,
} from './libraryServiceScheduledAuthority';

const lifecycle = (
  values: Partial<Extract<LibraryObservation, { kind: 'lifecycle' }>> = {},
): Extract<LibraryObservation, { kind: 'lifecycle' }> => ({
  kind: 'lifecycle',
  visible: true,
  online: true,
  playbackActive: false,
  ...values,
});

function authority() {
  const observe = vi.fn<LibraryServiceAuthority['observe']>(async () => ({
    outcome: 'unchanged',
    affected: [],
  }));
  const close = vi.fn<() => void>();
  const port: LibraryServiceAuthority = {
    generation: 'g1',
    select: vi.fn<LibraryServiceAuthority['select']>(async () => ({
      kind: 'history',
      items: [],
    })),
    command: vi.fn<LibraryServiceAuthority['command']>(async () => ({
      outcome: 'unchanged',
      delivery: 'synced',
      affected: [],
    })),
    query: vi.fn<LibraryServiceAuthority['query']>(async () => ({
      kind: 'playback.prepare',
      action: 'start',
      target: { type: 'movie', id: 1 },
      resume: null,
    })),
    task: vi.fn<LibraryServiceAuthority['task']>(async () => ({
      result: { kind: 'recovery.disable', outcome: 'disabled' },
      affected: [],
    })),
    observe,
    close,
  };
  return { port, observe, close };
}

function maintenance(mode: 'online' | 'local' = 'online') {
  const results: LibraryMaintenanceResult[] = [];
  const run = vi.fn<LibraryMaintenance['run']>(
    async () =>
      results.shift() ??
      ({ changed: false, status: { kind: 'ready' } } satisfies LibraryMaintenanceResult),
  );
  return {
    port: { mode, run } satisfies LibraryMaintenance,
    run,
    results,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ScheduledLibraryServiceAuthority', () => {
  it('keeps optional background work behind foreground readiness and online visibility', async () => {
    vi.useFakeTimers();
    const base = authority();
    const work = maintenance();
    const background = { run: vi.fn(async () => true) };
    const scheduled = new ScheduledLibraryServiceAuthority(base.port, work.port, { background });
    const events: LibraryAuthorityEvent[] = [];
    scheduled.listen((event) => events.push(event));

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(background.run).not.toHaveBeenCalled();

    await scheduled.observe({ kind: 'foreground-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(background.run).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ kind: 'changed', affected: [{ kind: 'downloads' }] });

    await scheduled.observe(lifecycle({ online: false }));
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS * 2);
    expect(background.run).toHaveBeenCalledTimes(1);
  });

  it('polls visible online libraries at the foreground and playback cadences', async () => {
    vi.useFakeTimers();
    const base = authority();
    const work = maintenance();
    work.results.push({ changed: true, status: { kind: 'ready' } });
    const scheduled = new ScheduledLibraryServiceAuthority(base.port, work.port);
    const events: LibraryAuthorityEvent[] = [];
    scheduled.listen((event) => events.push(event));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.run).not.toHaveBeenCalled();

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(work.run).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { kind: 'changed', affected: [{ kind: 'all' }] },
      { kind: 'status', status: { kind: 'ready' } },
    ]);

    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS - 1);
    expect(work.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.run).toHaveBeenCalledTimes(2);

    await scheduled.observe(lifecycle({ playbackActive: true }));
    await vi.advanceTimersByTimeAsync(ACTIVE_PLAYBACK_REFRESH_MS - 1);
    expect(work.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.run).toHaveBeenCalledTimes(3);

    await scheduled.close();
  });

  it('honors a sooner worker-owned download cadence after foreground readiness', async () => {
    vi.useFakeTimers();
    const work = maintenance();
    const background = {
      run: vi.fn(async () => false),
      nextDelay: vi.fn(() => 5_000),
    };
    const scheduled = new ScheduledLibraryServiceAuthority(authority().port, work.port, {
      background,
    });

    await scheduled.observe(lifecycle());
    await scheduled.observe({ kind: 'foreground-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(background.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(background.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(background.run).toHaveBeenCalledTimes(2);
    await scheduled.close();
  });

  it('pauses while hidden or offline and catches up immediately on return', async () => {
    vi.useFakeTimers();
    const work = maintenance();
    const scheduled = new ScheduledLibraryServiceAuthority(authority().port, work.port);

    await scheduled.observe(lifecycle({ visible: false }));
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS);
    expect(work.run).not.toHaveBeenCalled();

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(work.run).toHaveBeenCalledTimes(1);

    await scheduled.observe(lifecycle({ online: false }));
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS * 2);
    expect(work.run).toHaveBeenCalledTimes(1);

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(work.run).toHaveBeenCalledTimes(2);
    await scheduled.close();
  });

  it('runs local maintenance once when foregrounded without polling', async () => {
    vi.useFakeTimers();
    const work = maintenance('local');
    const scheduled = new ScheduledLibraryServiceAuthority(authority().port, work.port);

    await scheduled.observe(lifecycle({ online: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(work.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS * 10);
    expect(work.run).toHaveBeenCalledTimes(1);

    await scheduled.observe(lifecycle({ visible: false, online: false }));
    await scheduled.observe(lifecycle({ online: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(work.run).toHaveBeenCalledTimes(2);
    await scheduled.close();
  });

  it('reports a retrying pass once and returns to ready on the next pass', async () => {
    vi.useFakeTimers();
    const work = maintenance();
    work.run.mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduled = new ScheduledLibraryServiceAuthority(authority().port, work.port);
    const events: LibraryAuthorityEvent[] = [];
    scheduled.listen((event) => events.push(event));

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ kind: 'status', status: { kind: 'reconnecting' } }]);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS);
    expect(events.at(-1)).toEqual({ kind: 'status', status: { kind: 'ready' } });
    await scheduled.close();
  });

  it('stops permanently when the library has moved', async () => {
    vi.useFakeTimers();
    const work = maintenance();
    work.results.push({ changed: false, status: { kind: 'moved', successor: 'next' } });
    const scheduled = new ScheduledLibraryServiceAuthority(authority().port, work.port);

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS * 2);

    expect(work.run).toHaveBeenCalledOnce();
    await scheduled.close();
  });

  it('cancels future work and suppresses an in-flight result before closing the log', async () => {
    vi.useFakeTimers();
    let finish!: (result: LibraryMaintenanceResult) => void;
    const run = vi.fn(
      () =>
        new Promise<LibraryMaintenanceResult>((resolve) => {
          finish = resolve;
        }),
    );
    const base = authority();
    const scheduled = new ScheduledLibraryServiceAuthority(base.port, { mode: 'online', run });
    const events: LibraryAuthorityEvent[] = [];
    scheduled.listen((event) => events.push(event));

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    const closing = scheduled.close();
    expect(base.close).not.toHaveBeenCalled();
    finish({ changed: true, status: { kind: 'ready' } });
    await closing;

    expect(events).toEqual([]);
    expect(base.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(VISIBLE_REFRESH_MS * 2);
    expect(run).toHaveBeenCalledOnce();
  });

  it('forwards the lifecycle observation through the ordinary authority contract', async () => {
    vi.useFakeTimers();
    const base = authority();
    const scheduled = new ScheduledLibraryServiceAuthority(base.port, maintenance().port);
    const observation = lifecycle();

    await scheduled.observe(observation);

    expect(base.observe).toHaveBeenCalledWith(observation);
    await scheduled.close();
  });

  it('defers and coalesces provider delivery until foreground content is released', async () => {
    vi.useFakeTimers();
    let finish!: (changed: boolean) => void;
    const delivery = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const base = authority();
    vi.mocked(base.port.command).mockResolvedValue({
      outcome: 'applied',
      delivery: 'queued',
      affected: [],
    });
    const scheduled = new ScheduledLibraryServiceAuthority(
      base.port,
      maintenance().port,
      {},
      { run: delivery },
    );
    const events: LibraryAuthorityEvent[] = [];
    scheduled.listen((event) => events.push(event));

    await scheduled.observe(lifecycle());
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery).not.toHaveBeenCalled();

    await scheduled.observe({ kind: 'foreground-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery).toHaveBeenCalledOnce();
    await scheduled.command({ kind: 'watchlist.add', title: { type: 'movie', id: 1 } }, 'add');
    await scheduled.command({ kind: 'watchlist.add', title: { type: 'movie', id: 2 } }, 'add-2');
    expect(delivery).toHaveBeenCalledOnce();

    finish(true);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(2));
    expect(events).toContainEqual({
      kind: 'changed',
      affected: [{ kind: 'simkl' }, { kind: 'connections' }],
    });
    finish(false);
    await scheduled.observe(lifecycle({ visible: false }));
    await scheduled.command({ kind: 'watchlist.add', title: { type: 'movie', id: 3 } }, 'add-3');
    expect(delivery).toHaveBeenCalledTimes(2);
    await scheduled.close();
  });

  it('invalidates an in-flight provider pass when hidden, offline, or closed', async () => {
    vi.useFakeTimers();
    let current!: () => boolean;
    let finish!: () => void;
    const delivery = vi.fn(
      (isCurrent: () => boolean) =>
        new Promise<boolean>((resolve) => {
          current = isCurrent;
          finish = () => resolve(false);
        }),
    );
    const scheduled = new ScheduledLibraryServiceAuthority(
      authority().port,
      maintenance().port,
      {},
      { run: delivery },
    );

    await scheduled.observe(lifecycle());
    await scheduled.observe({ kind: 'foreground-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(current()).toBe(true);
    await scheduled.observe(lifecycle({ online: false }));
    expect(current()).toBe(false);
    await scheduled.observe(lifecycle());
    expect(current()).toBe(false);
    const closing = scheduled.close();
    expect(current()).toBe(false);
    finish();
    await closing;
  });
});
