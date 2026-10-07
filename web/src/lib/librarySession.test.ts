import { afterEach, expect, it, vi } from 'vitest';
import {
  continueWatching,
  ContinueProjector,
  emptyLibrary,
  type Library,
  type Title,
} from './library';
import { LibraryLog } from './log';
import { BACKGROUND_PROVIDER_FALLBACK_MS, LibrarySession } from './librarySession.svelte';
import { deliverSimkl } from './simklDelivery';
import { ensureSyncPolicy } from './syncLoader';
import type { Row } from './wire';

vi.mock('./simklDelivery', () => ({ deliverSimkl: vi.fn(async () => false) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(deliverSimkl).mockReset().mockResolvedValue(false);
});

it('holds provider delivery until the foreground explicitly releases background work', async () => {
  const log = {
    ...fakeLog(),
    fromCache: true,
    wireMinimum: 4,
    readOnly: false,
    needsV4: false,
    compact: vi.fn(async () => false),
  };
  vi.mocked(deliverSimkl).mockResolvedValue(true);
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');

  await session.opened;
  expect(
    deliverSimkl,
    'the cached library is visible without provider synchronization',
  ).not.toHaveBeenCalled();
  const revision = session.revision;
  session.foregroundReady();
  await vi.waitFor(() => expect(deliverSimkl).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(session.revision).toBeGreaterThan(revision));
});

it('eventually releases provider delivery on a route with no Home hero', async () => {
  vi.useFakeTimers();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  const log = {
    ...fakeLog(),
    fromCache: true,
    wireMinimum: 4,
    readOnly: false,
    needsV4: false,
    compact: vi.fn(async () => false),
  };
  vi.spyOn(LibraryLog, 'open').mockResolvedValue(log as unknown as LibraryLog);
  const session = new LibrarySession('test');
  await session.opened;
  const stop = session.start(vi.fn());

  await vi.advanceTimersByTimeAsync(BACKGROUND_PROVIDER_FALLBACK_MS - 1);
  expect(deliverSimkl).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deliverSimkl).toHaveBeenCalledOnce();
  stop();
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
  const projectContinue = vi.spyOn(ContinueProjector.prototype, 'project');
  session.continueTitleRefs(applied);
  expect(projectContinue).toHaveBeenCalledOnce();
  const displayed = session.displayedLibrary(applied);
  expect(session.displayedLibrary(applied)).toBe(displayed);
  const continued = session.continueWatching(applied, displayed);
  expect(projectContinue).toHaveBeenCalledOnce();
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

it('patches only records and marks named by a metadata batch', () => {
  const session = new LibrarySession(null);
  const records = Array.from({ length: 1_000 }, (_, id) => ({
    title: { type: 'movie' as const, id, title: '' },
    status: 'watched' as const,
    progress: 0,
    progressAt: id,
    addedAt: id,
    deleted: false,
  }));
  const projection: Library = {
    ...emptyLibrary(),
    records,
    marks: [
      {
        type: 'tv',
        id: 7,
        season: 1,
        episode: 1,
        fraction: 0.5,
        updatedAt: 1,
        title: '',
        voteAverage: 0,
      },
    ],
  };
  const before = session.displayedLibrary(projection);
  const untouchedRecord = before.records[998];
  const untouchedMark = before.marks[0];

  session.publishLibraryMetadata([{ type: 'movie', id: 7, title: 'Seven' }], []);
  const namedMovie = session.displayedLibrary(projection);
  expect(namedMovie.records[7]!.title.title).toBe('Seven');
  expect(namedMovie.records[998]).toBe(untouchedRecord);
  expect(namedMovie.marks[0]).toBe(untouchedMark);

  session.publishLibraryMetadata([{ type: 'tv', id: 7, title: 'Series' }], []);
  const namedSeries = session.displayedLibrary(projection);
  expect(namedSeries.marks[0]!.title).toBe('Series');
  expect(namedSeries.records[998]).toBe(untouchedRecord);
});

it('keeps unrelated Continue entries identical across display and shape batches', async () => {
  await ensureSyncPolicy();
  const session = new LibrarySession(null);
  const projection: Library = {
    ...emptyLibrary(),
    records: [1, 2].map((id) => ({
      title: { type: 'tv' as const, id, title: '' },
      status: 'inProgress' as const,
      progress: 0,
      progressAt: id,
      addedAt: id,
      deleted: false,
    })),
    marks: [1, 2].map((id) => ({
      type: 'tv',
      id,
      season: 1,
      episode: 1,
      fraction: id === 1 ? 1 : 0.5,
      updatedAt: id,
      title: '',
      voteAverage: 0,
    })),
  };
  const titles: Title[] = [1, 2].map((id) => ({ type: 'tv', id, title: `Series ${id}` }));
  session.publishLibraryMetadata(titles, []);
  let displayed = session.displayedLibrary(projection);
  const initial = session.continueWatching(projection, displayed);
  const untouched = initial.find((entry) => entry.title.id === 2);
  expect(initial.map((entry) => entry.title.id)).toEqual([2]);

  session.publishLibraryMetadata([], [['tv:1', { counts: new Map([[1, 8]]) }]]);
  displayed = session.displayedLibrary(projection);
  const shaped = session.continueWatching(projection, displayed);

  expect(shaped.map((entry) => entry.title.id)).toEqual([2, 1]);
  expect(shaped.find((entry) => entry.title.id === 2)).toBe(untouched);
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
