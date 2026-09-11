import { describe, expect, it } from 'vitest';
import { continueWatching, parseSnapshot, swiftDate, watchlist } from './library';

// A snapshot shaped the way the TV's JSONEncoder writes it: Dates as seconds since 2001, the episode progress
// as base64 JSON, Int-keyed dictionaries as flat [key, value, …] arrays.
const at = (seconds: number) => seconds;
const stamped = <T>(value: T, seconds: number) => ({ value, at: at(seconds) });

function record(type: 'movie' | 'tv', id: number, status: string, opts: { progress?: number; t?: number; deleted?: boolean } = {}) {
  const t = opts.t ?? 100;
  return {
    id: { id, mediaType: type },
    status: stamped(status, t),
    progress: stamped(opts.progress ?? 0, t),
    reaction: { at: t },
    isDeleted: stamped(opts.deleted ?? false, t),
    addedAt: t,
    schemaVersion: 1,
    title: `${type} ${id}`,
    posterPath: `/${id}.jpg`,
    year: 2020,
    genreIDs: [],
    voteAverage: 7.5,
  };
}

function mark(id: number, season: number, episode: number, fraction: number, updatedAt: number) {
  return { type: 'tv', id, season, episode, fraction, updatedAt, title: `tv ${id}`, voteAverage: 8, timeSeconds: 0 };
}

const progress = {
  marks: {
    'tv:1:1:3': mark(1, 1, 3, 0.4, 500), // resume S1E3
    'tv:1:1:2': mark(1, 1, 2, 1, 400), // older, superseded
    'tv:2:1:10': mark(2, 1, 10, 1, 600), // finished → next is S2E1
    'tv:3:2:3': mark(3, 2, 3, 1, 700), // finished the newest aired episode → drops out
    'tv:4:1:1': mark(4, 1, 1, 0.5, 800), // dismissed since
    'tv:5:1:1': mark(5, 1, 1, 0.5, 900), // the series is marked watched in the library
  },
  watchedKeys: [],
  shapes: {
    'tv:2': { episodeCounts: [1, 10, 2, 8], lastAiredSeason: 2, lastAiredEpisode: 3 },
    'tv:3': { episodeCounts: [1, 10, 2, 3], lastAiredSeason: 2, lastAiredEpisode: 3 },
  },
  dismissed: { 'tv:4': 850, 'movie:12': 150 },
};

const snapshot = {
  createdAt: 1000,
  records: [
    record('movie', 10, 'watchlist', { t: 200 }),
    record('tv', 11, 'watchlist', { t: 300 }),
    record('movie', 13, 'watchlist', { t: 400, deleted: true }),
    record('movie', 12, 'inProgress', { progress: 0.3, t: 100 }),
    record('movie', 14, 'inProgress', { progress: 0.6, t: 250 }),
    record('tv', 5, 'watched'),
  ],
  episodeProgress: btoa(JSON.stringify(progress)),
};

describe('the library from a TV backup', () => {
  const library = parseSnapshot(snapshot);

  it('reads Swift dates as seconds since 2001', () => {
    expect(new Date(swiftDate(0)).toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });

  it('lists the watchlist newest first, without deleted titles', () => {
    expect(watchlist(library).map((t) => `${t.type}:${t.id}`)).toEqual(['tv:11', 'movie:10']);
    expect(watchlist(library)[0]).toMatchObject({ title: 'tv 11', posterPath: '/11.jpg', rating: 7.5 });
  });

  it('continues series then movies, newest first, the way the TV does', () => {
    expect(continueWatching(library).map((e) => [`${e.title.type}:${e.title.id}`, e.episode, e.fraction])).toEqual([
      ['tv:2', { season: 2, episode: 1 }, 0],
      ['tv:1', { season: 1, episode: 3 }, 0.4],
      // movie 12 was dismissed after its last activity
      ['movie:14', undefined, 0.6],
    ]);
  });

  it('survives a snapshot with junk in it', () => {
    const junk = parseSnapshot({ records: [{ id: { id: 'x' } }, null], episodeProgress: 'not base64!' });
    expect(watchlist(junk)).toEqual([]);
    expect(continueWatching(junk)).toEqual([]);
  });
});
