import { afterEach, expect, it, vi } from 'vitest';
import { continueWatching } from './library';
import { LibraryLog } from './log';
import { LibrarySession } from './librarySession.svelte';
import { ensureSyncPolicy } from './syncLoader';
import type { Row } from './wire';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const fakeLog = (held: Row[] = []) => {
  const rows = vi.fn().mockReturnValue(held);
  return {
    moved: false,
    settings: vi.fn(),
    refresh: vi.fn().mockResolvedValue(true),
    rows,
    rowsInSlices: vi.fn(async () => rows()),
  };
};

it('retries an initially failed open without discarding a recovered log', async () => {
  const log = fakeLog();
  const open = vi
    .spyOn(LibraryLog, 'open')
    .mockResolvedValueOnce(null)
    .mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  expect(await session.opened).toBeNull();
  await session.refresh();
  expect(session.log).toBe(log);
  expect(open).toHaveBeenCalledTimes(2);
  log.refresh.mockRejectedValueOnce(new Error('offline'));
  await session.refresh();
  expect(session.log).toBe(log);
});

it('shows a copy kept from the last visit at once and brings it up to date straight after', async () => {
  const log = { ...fakeLog(), fromCache: true };
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;
  expect(session.log).toBe(log);
  expect(log.refresh).toHaveBeenCalledTimes(1);
});

it('publishes the first log only after its complete projection is ready', async () => {
  let finish!: (rows: Row[]) => void;
  const log = {
    ...fakeLog(),
    rowsInSlices: vi.fn(
      () =>
        new Promise<Row[]>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await vi.waitFor(() => expect(log.rowsInSlices).toHaveBeenCalledOnce());
  expect(session.log).toBeUndefined();
  finish([]);
  await session.opened;
  expect(session.log).toBe(log);
  expect(session.libraryProjection()?.rows).toEqual([]);
});

it('discards a sliced projection whose session revision changed while it yielded', async () => {
  let finish!: () => void;
  const log = {
    ...fakeLog(),
    rowsInSlices: vi.fn(
      (options: { shouldContinue?: () => boolean }) =>
        new Promise<Row[] | null>((resolve) => {
          finish = () => resolve(options.shouldContinue?.() ? [] : null);
        }),
    ),
  };
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await vi.waitFor(() => expect(log.rowsInSlices).toHaveBeenCalledOnce());
  session.changed();
  finish();
  expect(await session.opened).toBeNull();
  expect(session.log).toBeUndefined();
  expect(session.libraryProjection()).toBeNull();
});

it('stops projecting an abandoned session before another local library replaces it', async () => {
  let finish!: () => void;
  const log = {
    ...fakeLog(),
    rowsInSlices: vi.fn(
      (options: { shouldContinue?: () => boolean }) =>
        new Promise<Row[] | null>((resolve) => {
          finish = () => resolve(options.shouldContinue?.() ? [] : null);
        }),
    ),
  };
  vi.spyOn(LibraryLog, 'openLocal').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test', true);
  const stop = session.start(vi.fn());
  await vi.waitFor(() => expect(log.rowsInSlices).toHaveBeenCalledOnce());
  stop();
  finish();
  expect(await session.opened).toBeNull();
  expect(session.log).toBeUndefined();
  expect(session.libraryProjection()).toBeNull();
});

it('notify clears after TOAST_MS by default, and a later call replaces an earlier timer', async () => {
  vi.useFakeTimers();
  const session = new LibrarySession(null);
  session.notify('first');
  session.notify('second');
  expect(session.toast).toBe('second');
  vi.advanceTimersByTime(5_999);
  expect(session.toast).toBe('second');
  vi.advanceTimersByTime(1);
  expect(session.toast).toBeNull();
});

it('notify({ holdMs }) overrides how long the toast stays, and Infinity holds it until replaced', async () => {
  vi.useFakeTimers();
  const session = new LibrarySession(null);
  session.notify('quick', { holdMs: 1_000 });
  vi.advanceTimersByTime(1_000);
  expect(session.toast).toBeNull();

  session.notify('sent to the TV…', { holdMs: Infinity });
  vi.advanceTimersByTime(60_000);
  expect(session.toast).toBe('sent to the TV…');
  session.notify('playing on the TV');
  vi.advanceTimersByTime(6_000);
  expect(session.toast).toBeNull();
});

it('refreshes remote configuration only when settings changed and serializes refreshes', async () => {
  const log = fakeLog();
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;
  const initial = session.settingsRevision;
  await session.refresh();
  expect(session.settingsRevision).toBe(initial);
  let finish!: () => void;
  log.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          log.settings.mockReturnValue({ changed: true });
          resolve(true);
        };
      }),
  );
  const first = session.refresh();
  expect(session.refresh()).toBe(first);
  finish();
  await first;
  expect(session.settingsRevision).toBe(initial + 1);
});

it('keeps a single foreground retry loop independent of the active route and cleans it up', async () => {
  vi.useFakeTimers();
  const win = new EventTarget(),
    doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  const log = fakeLog();
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;
  const moved = vi.fn(),
    stop = session.start(moved);
  await session.refresh();
  const initial = log.refresh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(log.refresh).toHaveBeenCalledTimes(initial + 1);
  doc.hidden = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(log.refresh).toHaveBeenCalledTimes(initial + 1);
  doc.hidden = false;
  log.moved = true;
  win.dispatchEvent(new Event('online'));
  await session.refresh();
  expect(moved).toHaveBeenCalledTimes(1);
  stop();
  const stopped = log.refresh.mock.calls.length;
  win.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(log.refresh).toHaveBeenCalledTimes(stopped);
});

it('shares one immutable library projection per revision across retained pages', async () => {
  const log = fakeLog();
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;

  const first = session.libraryProjection();
  expect(session.libraryProjection()).toBe(first);
  expect(log.rows).toHaveBeenCalledOnce();

  const applied = first!.library;
  const displayed = session.displayedLibrary(applied);
  expect(session.displayedLibrary(applied)).toBe(displayed);
  const continued = session.continueWatching(applied, displayed);
  expect(session.continueWatching(applied, displayed)).toBe(continued);

  session.displays = [{ type: 'movie', id: 1, title: 'One' }];
  const renamed = session.displayedLibrary(applied);
  expect(renamed).not.toBe(displayed);
  expect(session.displayedLibrary(applied)).toBe(renamed);

  session.changed();
  const changed = session.libraryProjection();
  expect(changed).not.toBe(first);
  expect(log.rows).toHaveBeenCalledTimes(2);
});

it('keeps the shared projection and Continue result equal to the real den-core path', async () => {
  await ensureSyncPolicy();
  const rows: Row[] = [
    {
      kind: 'rec',
      schema: 2,
      title: { type: 'tv', id: 7 },
      status: { value: 'inProgress', at: [1000, 0, 'web'] },
      resume: { value: 0, at: [1000, 0, 'web'], viewing: 0 },
      reaction: { value: null, at: [0, 0, ''] },
      deleted: { value: false, at: [0, 0, ''] },
      dismissed: { value: false, at: [0, 0, ''] },
      episodesReset: null,
      addedAt: 1000,
      watchedAt: null,
    },
    {
      kind: 'ep',
      schema: 2,
      title: { type: 'tv', id: 7 },
      season: 1,
      episode: 2,
      progress: { value: 0.4, seconds: 900, viewing: 0, at: [2000, 0, 'web'] },
    },
  ];
  const log = fakeLog(rows);
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;
  session.displays = [{ type: 'tv', id: 7, title: 'Seven' }];

  const applied = session.libraryProjection()!.library;
  const displayed = session.displayedLibrary(applied);
  expect(session.continueWatching(applied, displayed)).toEqual(continueWatching(displayed));
});
