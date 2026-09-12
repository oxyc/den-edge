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
  const lookup = vi.fn(() => new Promise<Details>(resolve => { finish = resolve; }));
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
  const old = nameLibraryTitles(state, [ref], 'old', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await nameLibraryTitles(state, [ref], 'new', async () => null);
  finish({ title: { ...title, title: 'Stale' } });
  await old;
  expect(state.displays).toEqual([]);
  await nameLibraryTitles(state, [ref], 'new', async () => ({ title }));
  expect(state.displays).toEqual([title]);
});
