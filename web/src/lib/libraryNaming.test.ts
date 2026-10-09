import { expect, it, vi } from 'vitest';
import { LIBRARY_METADATA_BATCH, nameLibraryTitles, promoteLibraryTitle } from './libraryNaming';
import type { Shape, Title } from './library';
import type { LibraryModel } from './libraryModel.svelte';
import { LibrarySession } from './librarySession.svelte';
import type { LibraryMetadataShape, LibraryMetadataTitle } from './libraryServiceProtocol';

const movie = { type: 'movie' as const, id: 42 };
const title: LibraryMetadataTitle = { ...movie, title: 'Movie' };

type MetadataLookup = (refs: readonly { type: 'movie' | 'tv'; id: number }[]) => Promise<{
  titles: LibraryMetadataTitle[];
  shapes: LibraryMetadataShape[];
  retryable: Array<{ type: 'movie' | 'tv'; id: number }>;
}>;

const session = (
  libraryMetadata: MetadataLookup = vi.fn(async () => ({ titles: [], shapes: [], retryable: [] })),
) => ({
  displays: [] as Title[],
  shapes: new Map<string, Shape>(),
  libraryMetadata,
});

it('asks the service once for deduplicated missing metadata and skips what the page already has', async () => {
  const libraryMetadata = vi.fn(async () => ({ titles: [title], shapes: [], retryable: [] }));
  const state = session(libraryMetadata);
  await nameLibraryTitles(state, [movie, movie]);
  expect(libraryMetadata).toHaveBeenCalledWith([movie]);
  expect(state.displays).toEqual([title]);

  await promoteLibraryTitle(state, movie);
  expect(libraryMetadata).toHaveBeenCalledTimes(1);
});

it('publishes the Worker title and TV shape together in one page assignment', async () => {
  const series = { type: 'tv' as const, id: 7 };
  const state = {
    ...session(
      vi.fn(async () => ({
        titles: [{ ...series, title: 'Seven' }],
        shapes: [
          {
            title: series,
            seasons: [{ season: 1, episodes: 8 }],
            lastAired: { season: 1, episode: 8 },
          },
        ],
        retryable: [],
      })),
    ),
    publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>) {
      state.displays = [...state.displays, ...titles];
      state.shapes = new Map([...state.shapes, ...shapes]);
    },
  };
  const publish = vi.spyOn(state, 'publishLibraryMetadata');

  await nameLibraryTitles(state, [series]);

  expect(publish).toHaveBeenCalledTimes(1);
  expect(state.displays).toEqual([{ ...series, title: 'Seven' }]);
  expect(state.shapes.get('tv:7')).toEqual({
    counts: new Map([[1, 8]]),
    lastAired: { season: 1, episode: 8 },
  });
});

it('publishes each small service batch progressively across a tail larger than the wire bound', async () => {
  const count = 513;
  const refs = Array.from({ length: count }, (_, index) => ({
    type: 'movie' as const,
    id: index + 1,
  }));
  const libraryMetadata = vi.fn(async (batch: readonly { type: 'movie' | 'tv'; id: number }[]) => ({
    titles: batch.map((ref) => ({ ...ref, title: `#${ref.id}` })),
    shapes: [],
    retryable: [],
  }));
  const state = {
    ...session(libraryMetadata),
    publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>) {
      state.displays = [...state.displays, ...titles];
      state.shapes = new Map([...state.shapes, ...shapes]);
    },
  };
  const publish = vi.spyOn(state, 'publishLibraryMetadata');

  await nameLibraryTitles(state, refs);

  expect(libraryMetadata.mock.calls.map(([batch]) => batch.length)).toEqual([
    ...Array(8).fill(LIBRARY_METADATA_BATCH),
    1,
  ]);
  expect(publish).toHaveBeenCalledTimes(9);
  expect(state.displays).toHaveLength(count);
});

it('leaves a failed Worker question retryable', async () => {
  vi.useFakeTimers();
  try {
    const libraryMetadata = vi
      .fn<MetadataLookup>()
      .mockRejectedValueOnce(new Error('worker restarted'))
      .mockResolvedValueOnce({ titles: [title], shapes: [], retryable: [] });
    const state = session(libraryMetadata);

    await expect(nameLibraryTitles(state, [movie])).resolves.toBeUndefined();
    expect(state.displays).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(state.displays).toEqual([title]));
    expect(libraryMetadata).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('retries only transient refs while publishing successful neighbours immediately', async () => {
  vi.useFakeTimers();
  try {
    const later = { type: 'movie' as const, id: 43 };
    const libraryMetadata = vi
      .fn<MetadataLookup>()
      .mockResolvedValueOnce({ titles: [title], shapes: [], retryable: [later] })
      .mockResolvedValueOnce({
        titles: [{ ...later, title: 'Later' }],
        shapes: [],
        retryable: [],
      });
    const state = session(libraryMetadata);
    await nameLibraryTitles(state, [movie, later]);
    expect(state.displays).toEqual([title]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(state.displays).toHaveLength(2));

    expect(libraryMetadata.mock.calls.map(([refs]) => refs)).toEqual([[movie, later], [later]]);
    expect(state.displays).toEqual([title, { ...later, title: 'Later' }]);
  } finally {
    vi.useRealTimers();
  }
});

it('coalesces overlapping background retries for the same session and title', async () => {
  vi.useFakeTimers();
  try {
    const libraryMetadata = vi
      .fn<MetadataLookup>()
      .mockResolvedValueOnce({ titles: [], shapes: [], retryable: [movie] })
      .mockResolvedValueOnce({ titles: [], shapes: [], retryable: [movie] })
      .mockResolvedValueOnce({ titles: [title], shapes: [], retryable: [] });
    const state = session(libraryMetadata);

    await Promise.all([nameLibraryTitles(state, [movie]), nameLibraryTitles(state, [movie])]);
    expect(libraryMetadata).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(state.displays).toEqual([title]));

    expect(libraryMetadata).toHaveBeenCalledTimes(3);
    expect(libraryMetadata.mock.calls[2]?.[0]).toEqual([movie]);
  } finally {
    vi.useRealTimers();
  }
});

it('cancels a pending retry when its LibrarySession closes', async () => {
  vi.useFakeTimers();
  try {
    const libraryMetadata = vi.fn<MetadataLookup>().mockResolvedValue({
      titles: [],
      shapes: [],
      retryable: [movie],
    });
    const close = vi.fn();
    const model = { libraryMetadata, close } as unknown as LibraryModel;
    const state = new LibrarySession(model);

    await nameLibraryTitles(state, [movie]);
    state.close();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(libraryMetadata).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
