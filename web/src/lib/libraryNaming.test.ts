import { expect, it, vi } from 'vitest';
import { nameLibraryTitles } from './libraryNaming';
import type { Shape, Title } from './library';
import type { Details } from './tmdb';

const ref = { type: 'movie' as const, id: 42 };
const title: Title = { ...ref, title: 'Movie' };
const session = () => ({ displays: [] as Title[], shapes: new Map<string, Shape>() });

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
