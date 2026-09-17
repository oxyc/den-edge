import { describe, expect, it } from 'vitest';
import { WATCHED } from './actions';
import { applyLog, continueWatching, emptyLibrary, watchlist, type Library } from './library';

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

function epRow(season: number, episode: number, value: number, at: number) {
  return {
    kind: 'ep' as const,
    schema: 2,
    title: { type: 'tv' as const, id: 7 },
    season,
    episode,
    // The zero stamp is `[0, 0, ""]`: a watched bit learned without a time (wire/library-v2.md §3).
    progress: {
      value,
      at: [at, 0, at === 0 ? '' : 'aaaa'] as [number, number, string],
      viewing: 0,
    },
  };
}

describe('folding episode rows in', () => {
  /**
   * den-core defines the watched threshold once — `crates/den-sync/src/series.rs:6`, "One definition, so a
   * client cannot hold a different opinion about what 'watched' means" — and this app restated it in eight
   * places, two of them rival named constants. They agree today; nothing made them keep agreeing.
   *
   * So this asks the POLICY where the line is rather than comparing two numbers, which would only prove the
   * web consistent with itself. A timeless bit at or above the threshold is held as a flag; below it says
   * nothing at all (`episodes.rs`). Move `WATCHED` on either side without the other and this fails.
   */
  it('agrees with the shared policy about where watched begins', () => {
    const flags = (value: number) =>
      [...(applyLog(emptyLibrary(), [epRow(1, 2, value, 0)]).flags?.values() ?? [])].length;
    expect(flags(WATCHED), 'at the threshold').toBe(1);
    expect(flags(WATCHED - 0.01), 'just below it').toBe(0);
  });

  it('holds a timeless watched bit as a flag, never as progress stamped at the epoch', () => {
    const folded = applyLog(emptyLibrary(), [epRow(1, 2, 1, 0)]);
    // Written as a mark it became fraction 1 at updatedAt 0, and every later comparison then read real
    // progress as the older side — the opposite of what the zero stamp is for.
    expect(folded.marks).toEqual([]);
    expect([...(folded.flags?.values() ?? [])]).toEqual([
      { type: 'tv', id: 7, season: 1, episode: 2 },
    ]);
  });

  it('lets a timeless bit neither displace nor restamp real progress', () => {
    const started = applyLog(emptyLibrary(), [epRow(1, 2, 0.4, 1700000000000)]);
    const then = applyLog(started, [epRow(1, 2, 1, 0)]);
    expect(then.marks).toMatchObject([
      { season: 1, episode: 2, fraction: 0.4, updatedAt: 1700000000000 },
    ]);
    expect([...(then.flags?.values() ?? [])]).toEqual([]);
  });

  it('takes a stamped row, and an un-watch clears what was held', () => {
    const watched = applyLog(emptyLibrary(), [epRow(1, 2, 1, 1700000000000)]);
    expect(watched.marks).toMatchObject([{ fraction: 1, updatedAt: 1700000000000 }]);
    const cleared = applyLog(watched, [epRow(1, 2, 0, 1700000001000)]);
    expect(cleared.marks).toEqual([]);
    expect([...(cleared.flags?.values() ?? [])]).toEqual([]);
  });
});

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

  it('offers the next episode of a series known only through a bare watched flag', () => {
    // A tracker pull writes no progress at all, so this series has no mark: without the flag counting, a show
    // watched through SIMKL was watched everywhere except the row whose job is to offer its next episode.
    const flagged: Library = {
      records: [record('tv', 9, 'watched')],
      marks: [],
      flags: new Map([['tv:9:1:4', { type: 'tv', id: 9, season: 1, episode: 4 }]]),
      shapes: new Map([['tv:9', { counts: new Map([[1, 6]]) }]]),
      dismissed: new Map(),
    };
    expect(
      continueWatching(flagged).map((e) => [`${e.title.type}:${e.title.id}`, e.episode]),
    ).toEqual([['tv:9', { season: 1, episode: 5 }]]);
  });

  it('lets a flag ahead of the newest mark decide where the series is', () => {
    // The newest mark is E2; the flag says E4 was watched. The front is the further of the two, so the row
    // offers E5 rather than resuming E2.
    const both: Library = {
      records: [record('tv', 9, 'inProgress')],
      marks: [mark(9, 1, 2, 0.5, 1000)],
      flags: new Map([['tv:9:1:4', { type: 'tv', id: 9, season: 1, episode: 4 }]]),
      shapes: new Map([['tv:9', { counts: new Map([[1, 6]]) }]]),
      dismissed: new Map(),
    };
    expect(continueWatching(both).map((e) => [e.episode, e.fraction])).toEqual([
      [{ season: 1, episode: 5 }, 0],
    ]);
  });

  it('shows nothing for an empty library', () => {
    expect(watchlist(emptyLibrary())).toEqual([]);
    expect(continueWatching(emptyLibrary())).toEqual([]);
  });
});
