import { describe, expect, it } from 'vitest';
import { labelsFor, neighbourhood } from './atlasIndex';

/** atlas at `base`, answering GETs from `routes` by path and query; anything else is a 404. */
const atlas = (routes: Record<string, unknown>) => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    return url in routes
      ? new Response(JSON.stringify(routes[url]))
      : new Response('{"error":"not_found"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
};

const record = (mediaType: string, tmdbId: number, subgenre: string) => ({
  tmdbId,
  mediaType,
  primaryGenre: 'Crime',
  animated: false,
  subgenres: [{ label: subgenre, confidence: 0.9 }],
  moods: [{ label: 'Tense', confidence: 0.6 }],
});

describe('labelsFor', () => {
  it('reads the dataset’s labels file under this page’s own atlas, once, and keeps series as Den names them', async () => {
    const { asked, fetchImpl } = atlas({
      '/atlas-a/dataset.json': {
        labels: { url: 'http://192.168.86.193:8081/labels-t02.json?v=abc' },
      },
      '/atlas-a/labels-t02.json?v=abc': {
        records: [
          record('tv', 1399, 'Neo-Noir'),
          record('tv', 1399, 'Later'),
          record('movie', 1399, 'Heist'),
        ],
      },
    });
    const found = await labelsFor(
      '/atlas-a',
      [
        { type: 'tv', id: 1399 },
        { type: 'movie', id: 155 },
      ],
      fetchImpl,
    );
    expect(asked).toEqual(['/atlas-a/dataset.json', '/atlas-a/labels-t02.json?v=abc']);
    // The first row wins a duplicate, as atlas reads the file; ids collide across movies and series.
    expect(found.get('tv:1399')).toEqual({
      primaryGenre: 'Crime',
      animated: false,
      subgenres: [['Neo-Noir', 0.9]],
      moods: [['Tense', 0.6]],
    });
    // Absent is a title atlas has never indexed, not one with nothing in common.
    expect(found.has('movie:155')).toBe(false);

    const again = await labelsFor('/atlas-a', [{ type: 'movie', id: 1399 }], fetchImpl);
    expect(again.get('movie:1399')?.subgenres).toEqual([['Heist', 0.9]]);
    expect(asked).toHaveLength(2);
  });

  it('says nothing rather than failing when atlas cannot be reached, and asks again next time', async () => {
    const failing = atlas({});
    await expect(
      labelsFor('/atlas-b', [{ type: 'movie', id: 1 }], failing.fetchImpl),
    ).resolves.toEqual(new Map());
    await labelsFor('/atlas-b', [{ type: 'movie', id: 1 }], failing.fetchImpl);
    expect(failing.asked).toEqual(['/atlas-b/dataset.json', '/atlas-b/dataset.json']);
  });
});

describe('neighbourhood', () => {
  it('counts how many of the library’s seeds each title is a neighbour of, one GET per seed', async () => {
    const { asked, fetchImpl } = atlas({
      '/atlas/index/similar/movie/155.json': { ids: [1, 2, 603] },
      '/atlas/index/similar/movie/603.json': { ids: [2, 3] },
    });
    const { seeds, hits } = await neighbourhood(
      '/atlas',
      [
        { type: 'movie', id: 155 },
        { type: 'movie', id: 603 },
      ],
      fetchImpl,
    );
    expect(asked).toEqual([
      '/atlas/index/similar/movie/155.json',
      '/atlas/index/similar/movie/603.json',
    ]);
    expect(seeds).toBe(2);
    // Deep inside the neighbourhood: two different seeds both lead here.
    expect(hits.get('movie:2')).toBe(2);
    expect(hits.get('movie:1')).toBe(1);
    // Another seed is not a neighbour to mark down.
    expect(hits.has('movie:603')).toBe(false);
  });

  it('asks about a series by atlas’s name for it and reads its answers back as Den’s', async () => {
    const { fetchImpl } = atlas({ '/atlas/index/similar/series/1396.json': { ids: [95396] } });
    const { hits } = await neighbourhood('/atlas', [{ type: 'tv', id: 1396 }], fetchImpl);
    expect(hits.get('tv:95396')).toBe(1);
  });

  it('counts only the seeds atlas could answer for, since it holds few series', async () => {
    const { fetchImpl } = atlas({
      '/atlas/index/similar/movie/155.json': { ids: [1] },
      '/atlas/index/similar/series/1396.json': { ids: [] },
    });
    const { seeds, hits } = await neighbourhood(
      '/atlas',
      [
        { type: 'movie', id: 155 },
        { type: 'tv', id: 1396 },
      ],
      fetchImpl,
    );
    // One of the two said nothing, so a title every answering seed leads to is wholly redundant, not half.
    expect(seeds).toBe(1);
    expect(hits.get('movie:1')).toBe(1);
  });

  it('asks for nothing when there are no seeds', async () => {
    const { asked, fetchImpl } = atlas({});
    expect(await neighbourhood('/atlas', [], fetchImpl)).toEqual({ seeds: 0, hits: new Map() });
    expect(asked).toHaveLength(0);
  });
});
