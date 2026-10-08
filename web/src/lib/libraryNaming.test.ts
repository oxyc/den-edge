import { expect, it, vi } from 'vitest';
import { nameLibraryTitles, promoteLibraryTitle } from './libraryNaming';
import type { MediaType, Shape, Title } from './library';
import type { Details } from './tmdb';

const ref = { type: 'movie' as const, id: 42 };
type Ref = { type: MediaType; id: number };
const title: Title = { ...ref, title: 'Movie' };
const session = () => ({ displays: [] as Title[], shapes: new Map<string, Shape>() });

const turns = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

it('shares in-flight naming and skips already named titles', async () => {
  const state = session();
  let finish!: (value: Details) => void;
  const lookup = vi.fn(
    () =>
      new Promise<Details>((resolve) => {
        finish = resolve;
      }),
  );
  const first = nameLibraryTitles(state, [ref], 'key', lookup);
  const second = promoteLibraryTitle(state, ref, 'key', lookup);
  await Promise.resolve();
  expect(lookup).toHaveBeenCalledTimes(1);
  finish({ title });
  await Promise.all([first, second]);
  await nameLibraryTitles(state, [ref], 'key', lookup);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(state.displays).toEqual([title]);
});

it('publishes names in one batch instead of one Home update per title', async () => {
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
  await nameLibraryTitles(state, refs, 'key', async (wanted) => ({
    title: { ...wanted, title: `#${wanted.id}` },
  }));
  expect(displays).toHaveLength(40);
  expect(assignments).toBe(1);
});

it('hands sessions one exact metadata publication', async () => {
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

it('keeps six lookups in flight', async () => {
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
