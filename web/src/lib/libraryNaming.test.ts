import { expect, it, vi } from 'vitest';
import {
  INITIAL_SHELF_TITLES,
  nameLibraryHistoryTitles,
  nameLibraryShelfTitles,
  nameLibraryTitles,
  promoteLibraryTitle,
} from './libraryNaming';
import type { MediaType, Shape, Title } from './library';
import type { Details } from './tmdb';

const ref = { type: 'movie' as const, id: 42 };
type Ref = { type: MediaType; id: number };
const title: Title = { ...ref, title: 'Movie' };
const session = () => ({ displays: [] as Title[], shapes: new Map<string, Shape>() });

function idleHarness() {
  const queued: { task: () => void; cancelled: boolean }[] = [];
  return {
    schedule(task: () => void) {
      const entry = { task, cancelled: false };
      queued.push(entry);
      return () => (entry.cancelled = true);
    },
    run() {
      const entry = queued.find((candidate) => !candidate.cancelled);
      if (!entry) throw new Error('no idle callback queued');
      entry.cancelled = true;
      entry.task();
    },
    get pending() {
      return queued.filter((entry) => !entry.cancelled).length;
    },
  };
}

const turns = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

it('shares in-flight naming across retained pages and skips already named titles', async () => {
  const state = session();
  let finish!: (value: Details) => void;
  const lookup = vi.fn(
    () =>
      new Promise<Details>((resolve) => {
        finish = resolve;
      }),
  );
  const first = nameLibraryTitles(state, [ref], 'key', lookup);
  const second = nameLibraryTitles(state, [ref], 'key', lookup);
  await Promise.resolve();
  expect(lookup).toHaveBeenCalledTimes(1);
  finish({ title });
  await Promise.all([first, second]);
  await nameLibraryTitles(state, [ref], 'key', lookup);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(state.displays).toEqual([title]);
});

it('publishes names in batches, not one Home update per title', async () => {
  let assignments = 0;
  let displays: Title[] = [];
  const state = {
    get displays() {
      return displays;
    },
    set displays(next) {
      assignments++;
      displays = next;
    },
    shapes: new Map<string, Shape>(),
  };
  const refs = Array.from({ length: 40 }, (_, i) => ({ type: 'movie' as const, id: i + 1 }));
  await nameLibraryTitles(state, refs, 'key', async (r) => ({
    title: { ...r, title: `#${r.id}` },
  }));
  expect(displays).toHaveLength(40);
  expect(assignments).toBe(1);
});

it('hands sessions the exact changed metadata keys as one publication', async () => {
  const state = {
    ...session(),
    publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>) {
      state.displays = [...state.displays, ...titles];
      state.shapes = new Map([...state.shapes, ...shapes]);
    },
  };
  const publish = vi.spyOn(state, 'publishLibraryMetadata');
  const series = { type: 'tv' as const, id: 7 };
  const shape = { counts: new Map([[1, 8]]) };

  await nameLibraryTitles(state, [series], 'key', async () => ({
    title: { ...series, title: 'Seven' },
    shape,
  }));

  expect(publish).toHaveBeenCalledWith([{ ...series, title: 'Seven' }], [['tv:7', shape]]);
});

it('keeps six shelf-critical lookups in flight', async () => {
  const state = session();
  const refs = Array.from({ length: 7 }, (_, id) => ({ type: 'movie' as const, id: id + 1 }));
  const finishes: (() => void)[] = [];
  const lookup = vi.fn(
    (wanted: Ref) =>
      new Promise<Details>((resolve) => {
        finishes.push(() => resolve({ title: { ...wanted, title: `#${wanted.id}` } }));
      }),
  );
  const naming = nameLibraryTitles(state, refs, 'key', lookup);
  await turns();
  expect(lookup).toHaveBeenCalledTimes(6);
  finishes.shift()?.();
  await turns();
  expect(lookup).toHaveBeenCalledTimes(7);
  for (const finish of finishes) finish();
  await naming;
  expect(state.displays).toHaveLength(7);
});

it('does not duplicate a title remembered while its naming request was pending', async () => {
  const state = session();
  const task = nameLibraryTitles(state, [ref], 'key', async () => {
    state.displays = [title];
    return { title };
  });
  await task;
  expect(state.displays).toEqual([title]);
});

it('ignores stale API-key results and permits retry after a failed request', async () => {
  const state = session();
  let finish!: (value: Details) => void;
  const old = nameLibraryTitles(
    state,
    [ref],
    'old',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  await nameLibraryTitles(state, [ref], 'new', async () => null);
  finish({ title: { ...title, title: 'Stale' } });
  await old;
  expect(state.displays).toEqual([]);
  await nameLibraryTitles(state, [ref], 'new', async () => ({ title }));
  expect(state.displays).toEqual([title]);
});

it('prioritizes shelf titles and stable recent seeds ahead of older watched history', async () => {
  const { shelfTitleRefs, personalSeedRows } = await import('./libraryNaming');
  const { applyLog, emptyLibrary } = await import('./library');
  const {
    blankTitle,
    markWatched,
    addToWatchlist,
    updateProgress,
    blankEpisode,
    updateEpisodeProgress,
  } = await import('./actions');
  const rows = [
    ...[1, 2, 3].map((id) => markWatched(blankTitle({ type: 'movie', id }, id), [id, 0, 'test'])),
    addToWatchlist(blankTitle({ type: 'movie', id: 4 }, 4), [4, 0, 'test']),
    updateProgress(blankTitle({ type: 'movie', id: 5 }, 5), 0.5, 40, [5, 0, 'test']),
    updateEpisodeProgress(blankEpisode({ type: 'tv', id: 6 }, 1, 1), 0.5, 40, [6, 0, 'test']),
  ];
  expect(personalSeedRows(rows).watched.map((r) => r.title.id)).toEqual([3, 2]);
  expect(personalSeedRows([...rows].reverse())).toEqual(personalSeedRows(rows));
  expect(shelfTitleRefs(applyLog(emptyLibrary(), rows), rows).map((r) => r.id)).toEqual([
    3, 2, 4, 5, 6,
  ]);
});

it('publishes only the first viewport of each shelf, then admits the intended shelf in bounded tranches', async () => {
  const { applyLog, emptyLibrary } = await import('./library');
  const { addToWatchlist, blankTitle, updateProgress } = await import('./actions');
  const continued = Array.from({ length: 12 }, (_, index) =>
    updateProgress(blankTitle({ type: 'movie', id: 100 + index }, index + 1), 0.5, 40, [
      index + 1,
      0,
      'test',
    ]),
  );
  const saved = Array.from({ length: 12 }, (_, index) =>
    addToWatchlist(blankTitle({ type: 'movie', id: 200 + index }, 100 + index), [
      100 + index,
      0,
      'test',
    ]),
  );
  const rows = [...continued, ...saved];
  const state = session();
  const lookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: `#${wanted.id}` },
  }));
  const naming = nameLibraryShelfTitles(state, applyLog(emptyLibrary(), rows), rows, 'key', lookup);

  await naming.ready;
  expect(state.displays).toHaveLength(INITIAL_SHELF_TITLES * 2);
  expect(lookup).toHaveBeenCalledTimes(INITIAL_SHELF_TITLES * 2);

  await naming.admit('continue');
  expect(state.displays).toHaveLength(INITIAL_SHELF_TITLES * 2 + 4);
  expect(state.displays.filter(({ id }) => id >= 200)).toHaveLength(INITIAL_SHELF_TITLES);

  await naming.admit('watchlist');
  expect(state.displays).toHaveLength(24);
  expect(lookup).toHaveBeenCalledTimes(24);
  naming.cancel();
});

it('reuses a session-owned Continue projection when forming shelf queues', async () => {
  const { applyLog, emptyLibrary } = await import('./library');
  const { blankTitle, updateProgress } = await import('./actions');
  const rows = [updateProgress(blankTitle({ type: 'movie', id: 100 }, 1), 0.5, 40, [1, 0, 'test'])];
  const library = applyLog(emptyLibrary(), rows);
  const state = {
    ...session(),
    continueTitleRefs: vi.fn(() => [{ type: 'movie' as const, id: 900 }]),
  };
  const lookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: `#${wanted.id}` },
  }));

  const naming = nameLibraryShelfTitles(state, library, rows, 'key', lookup);
  await naming.ready;

  expect(state.continueTitleRefs).toHaveBeenCalledWith(library);
  expect(lookup).toHaveBeenCalledWith({ type: 'movie', id: 900 }, 'key');
  expect(lookup).not.toHaveBeenCalledWith({ type: 'movie', id: 100 }, 'key');
  naming.cancel();
});

it('does not let already-published titles hide an unnamed tail from the next intent tranche', async () => {
  const { applyLog, emptyLibrary } = await import('./library');
  const { blankTitle, updateProgress } = await import('./actions');
  const rows = Array.from({ length: 17 }, (_, index) =>
    updateProgress(blankTitle({ type: 'movie', id: 100 + index }, index + 1), 0.5, 40, [
      index + 1,
      0,
      'test',
    ]),
  );
  const state = session();
  // Everything except the oldest tail already has display metadata, as the large-window fixture does.
  state.displays = rows.slice(1).map(({ title: wanted }) => ({
    type: wanted.type,
    id: wanted.id,
    title: `#${wanted.id}`,
  }));
  const lookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: `#${wanted.id}` },
  }));
  const naming = nameLibraryShelfTitles(state, applyLog(emptyLibrary(), rows), rows, 'key', lookup);

  await naming.ready;
  expect(lookup).not.toHaveBeenCalled();
  await naming.admit('continue');
  expect(lookup).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledWith({ type: 'movie', id: 100 }, 'key');
  expect(state.displays.map(({ id }) => id)).toContain(100);
  naming.cancel();
});

it('publishes every series shape before shelves are ready while keeping off-window names dormant', async () => {
  const { applyLog, emptyLibrary } = await import('./library');
  const { blankEpisode, markEpisode } = await import('./actions');
  const rows = Array.from({ length: 10 }, (_, index) =>
    markEpisode(blankEpisode({ type: 'tv', id: 300 + index }, 1, 1), true, [index + 1, 0, 'test']),
  );
  const state = session();
  const lookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: `#${wanted.id}` },
    shape: { counts: new Map([[1, 2]]) },
  }));
  const naming = nameLibraryShelfTitles(state, applyLog(emptyLibrary(), rows), rows, 'key', lookup);

  await naming.ready;
  expect(state.shapes.size).toBe(10);
  expect(state.displays).toHaveLength(INITIAL_SHELF_TITLES);
  // Shape preflight and display admission join the same resolved details; no title is fetched twice.
  expect(lookup).toHaveBeenCalledTimes(10);
  await naming.admit('continue');
  expect(state.displays).toHaveLength(10);
  expect(lookup).toHaveBeenCalledTimes(10);
  naming.cancel();
});

it('reuses a staged shape detail when watched history later admits its display', async () => {
  vi.useFakeTimers();
  try {
    const { applyLog, emptyLibrary } = await import('./library');
    const { blankEpisode, markEpisode } = await import('./actions');
    const watched = { type: 'tv' as const, id: 399 };
    const rows = [markEpisode(blankEpisode(watched, 1, 1), true, [1, 0, 'test'])];
    const state = session();
    const lookup = vi.fn(async (wanted: Ref) => ({
      title: { ...wanted, title: 'Complete' },
      // There is no next episode, so this title belongs to watched history, not Continue Watching.
      shape: { counts: new Map([[1, 1]]) },
    }));
    const naming = nameLibraryShelfTitles(
      state,
      applyLog(emptyLibrary(), rows),
      rows,
      'key',
      lookup,
    );
    await naming.ready;
    expect(state.displays).toEqual([]);
    expect(lookup).toHaveBeenCalledOnce();

    const idle = idleHarness();
    const history = nameLibraryHistoryTitles(state, [watched], 'key', {
      lookup,
      scheduleIdle: idle.schedule,
    });
    idle.run();
    await turns();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.displays).toEqual([{ ...watched, title: 'Complete' }]);
    expect(lookup).toHaveBeenCalledOnce();
    history.cancel();
    naming.cancel();
  } finally {
    vi.useRealTimers();
  }
});

it('does not expand the old pre-ready request set for a flag-only history series', async () => {
  const { emptyLibrary } = await import('./library');
  const library = emptyLibrary();
  library.flags?.set('tv:500:1:1', { type: 'tv', id: 500, season: 1, episode: 1 });
  const state = session();
  const lookup = vi.fn(async () => null);
  const naming = nameLibraryShelfTitles(state, library, [], 'key', lookup);

  await naming.ready;
  expect(lookup).not.toHaveBeenCalled();
  naming.cancel();
});

it('loads the episode shape even when a series name is already remembered', async () => {
  const state = session();
  const series: Title = { type: 'tv', id: 7, title: 'Series' };
  state.displays = [series];
  const shape = { counts: new Map([[1, 10]]) };
  const lookup = vi.fn(async () => ({ title: series, shape }));
  await nameLibraryTitles(state, [series], 'key', lookup);
  await nameLibraryTitles(state, [series], 'key', lookup);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(state.shapes.get('tv:7')).toEqual(shape);
  expect(state.displays).toEqual([series]);
});

it('checks a large already-named library in linear work', async () => {
  let displayReads = 0;
  const state = session();
  state.displays = Array.from({ length: 1_000 }, (_, id) => ({
    get type() {
      displayReads++;
      return 'movie' as const;
    },
    get id() {
      displayReads++;
      return id;
    },
    title: `Movie ${id}`,
  }));
  const refs = Array.from({ length: 1_000 }, (_, id) => ({ type: 'movie' as const, id }));
  const lookup = vi.fn(async () => null);

  await nameLibraryTitles(state, refs, 'key', lookup);

  expect(lookup).not.toHaveBeenCalled();
  // Each existing display is indexed once, rather than scanned again for every ref.
  expect(displayReads).toBe(2_000);
});

it('does not admit watched history until priority naming completes and the browser is idle', async () => {
  const state = session();
  const idle = idleHarness();
  const priority = { type: 'movie' as const, id: 1 };
  const history = { type: 'movie' as const, id: 2 };
  let finishPriority!: (value: Details) => void;
  const priorityLookup = vi.fn(
    () =>
      new Promise<Details>((resolve) => {
        finishPriority = resolve;
      }),
  );
  const historyLookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: 'History' },
  }));

  const first = nameLibraryTitles(state, [priority], 'key', priorityLookup).then(() =>
    nameLibraryHistoryTitles(state, [history], 'key', {
      lookup: historyLookup,
      scheduleIdle: idle.schedule,
    }),
  );
  await turns();
  expect(priorityLookup).toHaveBeenCalledOnce();
  expect(historyLookup).not.toHaveBeenCalled();
  expect(idle.pending).toBe(0);

  finishPriority({ title: { ...priority, title: 'Priority' } });
  const background = await first;
  expect(idle.pending).toBe(1);
  expect(historyLookup).not.toHaveBeenCalled();
  idle.run();
  await turns();
  expect(historyLookup).toHaveBeenCalledOnce();
  background.cancel();
});

it('does not enumerate a lazy history tail until its first active idle turn', async () => {
  const state = session();
  const idle = idleHarness();
  const history = { type: 'movie' as const, id: 2 };
  const refs = vi.fn(() => [history]);
  const lookup = vi.fn(async (wanted: Ref) => ({
    title: { ...wanted, title: 'History' },
  }));
  const background = nameLibraryHistoryTitles(state, refs, 'key', {
    lookup,
    scheduleIdle: idle.schedule,
  });

  expect(refs).not.toHaveBeenCalled();
  background.pause();
  expect(idle.pending).toBe(0);
  background.resume();
  expect(idle.pending).toBe(1);
  expect(refs).not.toHaveBeenCalled();

  idle.run();
  await turns();
  expect(refs).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledOnce();
  background.cancel();
});

it('admits at most two background lookups and returns to idle before admitting another', async () => {
  const state = session();
  const idle = idleHarness();
  const refs = Array.from({ length: 5 }, (_, id) => ({ type: 'movie' as const, id: id + 1 }));
  const finishes: (() => void)[] = [];
  let running = 0;
  let highest = 0;
  const lookup = vi.fn(
    (wanted: Ref) =>
      new Promise<Details>((resolve) => {
        running++;
        highest = Math.max(highest, running);
        finishes.push(() => {
          running--;
          resolve({ title: { ...wanted, title: `#${wanted.id}` } });
        });
      }),
  );
  const background = nameLibraryHistoryTitles(state, refs, 'key', {
    lookup,
    scheduleIdle: idle.schedule,
  });

  idle.run();
  await turns();
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(highest).toBe(2);
  finishes.shift()?.();
  await turns();
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(idle.pending).toBe(1);
  idle.run();
  await turns();
  expect(lookup).toHaveBeenCalledTimes(3);
  expect(highest).toBe(2);
  for (const finish of finishes) finish();
  await turns();
  background.cancel();
});

it('promotes queued work and joins an already-running background key without another lookup', async () => {
  const state = session();
  const idle = idleHarness();
  const queued = { type: 'movie' as const, id: 1 };
  const running = { type: 'movie' as const, id: 2 };
  const finishes = new Map<number, (value: Details) => void>();
  const lookup = vi.fn(
    (wanted: Ref) =>
      new Promise<Details>((resolve) => {
        finishes.set(wanted.id, resolve);
      }),
  );
  const background = nameLibraryHistoryTitles(state, [running, queued], 'key', {
    lookup,
    scheduleIdle: idle.schedule,
  });

  expect(promoteLibraryTitle(state, { type: 'movie', id: 3 }, 'key', lookup)).toBeUndefined();
  const promoted = promoteLibraryTitle(state, queued, 'key', lookup);
  expect(promoted).toBeDefined();
  await turns();
  expect(lookup.mock.calls.map(([wanted]) => wanted.id)).toEqual([queued.id]);
  idle.run();
  await turns();
  expect(lookup.mock.calls.map(([wanted]) => wanted.id).sort()).toEqual([queued.id, running.id]);
  const joined = promoteLibraryTitle(state, running, 'key', lookup);
  expect(joined).toBeDefined();
  await turns();
  expect(lookup).toHaveBeenCalledTimes(2);

  finishes.get(queued.id)?.({ title: { ...queued, title: 'Queued' } });
  finishes.get(running.id)?.({ title: { ...running, title: 'Running' } });
  await Promise.all([promoted, joined]);
  expect(lookup).toHaveBeenCalledTimes(2);
  background.cancel();
});

it('promotes an exact direct route before lazy history enumeration without requesting it twice', async () => {
  const state = session();
  const idle = idleHarness();
  const direct = { type: 'movie' as const, id: 1 };
  const other = { type: 'movie' as const, id: 2 };
  const refs = vi.fn(() => [direct, other]);
  const finishes = new Map<number, (value: Details) => void>();
  const lookup = vi.fn(
    (wanted: Ref) =>
      new Promise<Details>((resolve) => {
        finishes.set(wanted.id, resolve);
      }),
  );
  const background = nameLibraryHistoryTitles(state, refs, 'key', {
    lookup,
    scheduleIdle: idle.schedule,
    owns: (wanted) => wanted.id === direct.id,
  });
  // A retained detail route is not the Watchlist, so its history queue stays dormant.
  background.pause();

  expect(promoteLibraryTitle(state, other, 'key', lookup)).toBeUndefined();
  const promoted = promoteLibraryTitle(state, direct, 'key', lookup);
  expect(promoted).toBeDefined();
  await turns();
  expect(refs).not.toHaveBeenCalled();
  expect(lookup.mock.calls.map(([wanted]) => wanted.id)).toEqual([direct.id]);

  background.resume();
  idle.run();
  await turns();
  expect(refs).toHaveBeenCalledOnce();
  expect(lookup.mock.calls.map(([wanted]) => wanted.id)).toEqual([direct.id, other.id]);

  finishes.get(direct.id)?.({ title: { ...direct, title: 'Direct' } });
  finishes.get(other.id)?.({ title: { ...other, title: 'Other' } });
  await promoted;
  expect(lookup).toHaveBeenCalledTimes(2);
  background.cancel();
});

it('cancels idle admission while inactive and resumes only when active and visible', async () => {
  const state = session();
  const idle = idleHarness();
  const history = { type: 'movie' as const, id: 9 };
  let hidden = true;
  let visibilityChanged = () => {};
  const lookup = vi.fn(async () => ({ title: { ...history, title: 'History' } }));
  const background = nameLibraryHistoryTitles(state, [history], 'key', {
    lookup,
    scheduleIdle: idle.schedule,
    hidden: () => hidden,
    onVisibilityChange: (listener) => {
      visibilityChanged = listener;
      return () => (visibilityChanged = () => {});
    },
  });

  expect(idle.pending).toBe(0);
  hidden = false;
  visibilityChanged();
  expect(idle.pending).toBe(1);
  background.pause();
  expect(idle.pending).toBe(0);
  expect(lookup).not.toHaveBeenCalled();
  background.resume();
  expect(idle.pending).toBe(1);
  background.cancel();
  expect(idle.pending).toBe(0);
  expect(lookup).not.toHaveBeenCalled();
});
