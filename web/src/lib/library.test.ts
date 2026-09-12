import { describe, expect, it } from 'vitest';
import { continueWatching, emptyLibrary, watchlist, type Library } from './library';

function record(
  type: 'movie' | 'tv',
  id: number,
  status: 'watchlist' | 'inProgress' | 'watched',
  opts: { progress?: number; t?: number; deleted?: boolean } = {},
) {
  const t = opts.t ?? 100;
  return {
    title: { type, id, title: `${type} ${id}`, posterPath: `/${id}.jpg`, year: 2020, rating: 7.5 },
    status,
    progress: opts.progress ?? 0,
    progressAt: t,
    addedAt: t,
    deleted: opts.deleted ?? false,
  };
}

function mark(id: number, season: number, episode: number, fraction: number, updatedAt: number) {
  return {
    type: 'tv',
    id,
    season,
    episode,
    fraction,
    updatedAt,
    title: `tv ${id}`,
    voteAverage: 8,
  };
}

const library: Library = {
  records: [
    record('movie', 10, 'watchlist', { t: 200 }),
    record('tv', 11, 'watchlist', { t: 300 }),
    record('movie', 13, 'watchlist', { t: 400, deleted: true }),
    record('movie', 12, 'inProgress', { progress: 0.3, t: 100 }),
    record('movie', 14, 'inProgress', { progress: 0.6, t: 250 }),
    record('tv', 5, 'watched'),
  ],
  marks: [
    mark(1, 1, 3, 0.4, 500), // resume S1E3
    mark(1, 1, 2, 1, 400), // older, superseded
    mark(2, 1, 10, 1, 600), // finished → next is S2E1
    mark(3, 2, 3, 1, 700), // finished the newest aired episode → drops out
    mark(4, 1, 1, 0.5, 800), // dismissed since
    mark(5, 1, 1, 0.5, 900), // the series is marked watched in the library
  ],
  shapes: new Map([
    [
      'tv:2',
      {
        counts: new Map([
          [1, 10],
          [2, 8],
        ]),
        lastAired: { season: 2, episode: 3 },
      },
    ],
    [
      'tv:3',
      {
        counts: new Map([
          [1, 10],
          [2, 3],
        ]),
        lastAired: { season: 2, episode: 3 },
      },
    ],
  ]),
  dismissed: new Map([
    ['tv:4', 850],
    ['movie:12', 150],
  ]),
};

describe("the TV's rows", () => {
  it('lists the watchlist newest first, without deleted titles', () => {
    expect(watchlist(library).map((t) => `${t.type}:${t.id}`)).toEqual(['tv:11', 'movie:10']);
    expect(watchlist(library)[0]).toMatchObject({
      title: 'tv 11',
      posterPath: '/11.jpg',
      rating: 7.5,
    });
  });

  it('continues series then movies, newest first, the way the TV does', () => {
    expect(
      continueWatching(library).map((e) => [
        `${e.title.type}:${e.title.id}`,
        e.episode,
        e.fraction,
      ]),
    ).toEqual([
      ['tv:2', { season: 2, episode: 1 }, 0],
      ['tv:1', { season: 1, episode: 3 }, 0.4],
      // movie 12 was dismissed after its last activity
      ['movie:14', undefined, 0.6],
    ]);
  });

  it('shows nothing for an empty library', () => {
    expect(watchlist(emptyLibrary())).toEqual([]);
    expect(continueWatching(emptyLibrary())).toEqual([]);
  });
});
