import { afterEach, expect, it, vi } from 'vitest';
import { LibraryLog } from './log';
import { LibrarySession } from './librarySession.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const fakeLog = () => ({
  moved: false,
  settings: vi.fn(),
  refresh: vi.fn().mockResolvedValue(true),
});

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
