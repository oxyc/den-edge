import { describe, expect, it } from 'vitest';
import { RESUME_FLOOR, WATCHED } from './actions';
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

  /**
   * The floor is den-core's (`crates/den-sync/src/series.rs:141`), and `continue_entry` is what applies it:
   * a mark resumes only above it. Asked of the policy rather than by comparing two numbers, for the same
   * reason as the watched threshold — comparing constants would only prove the web consistent with itself.
   */
  it('agrees with the shared policy about where a resume begins', () => {
    const above = RESUME_FLOOR + 0.01;
    const below = RESUME_FLOOR - 0.01;
    const started = (fraction: number): Library => ({
      records: [record('tv', 9, 'inProgress')],
      marks: [mark(9, 1, 2, fraction, 1000)],
      flags: new Map(),
      shapes: new Map([['tv:9', { counts: new Map([[1, 6]]) }]]),
      dismissed: new Map(),
    });
    expect(
      continueWatching(started(above)).map((e) => [e.episode, e.fraction]),
      'above the floor, the mark is where to resume',
    ).toEqual([[{ season: 1, episode: 2 }, above]]);
    // Below it the play has barely begun: whatever the row offers, it is not that position.
    expect(
      continueWatching(started(below)).map((e) => e.fraction),
      'below the floor, not a resume point',
    ).not.toEqual([below]);
  });

  /**
   * A mark with no season shape is NOT lost. `continue_entry` answers it from the mark itself, because a
   * resume needs no layout to reason about (den-core `crates/den-sync/src/series.rs:210`). den-edge#14
   * supposed the opposite — that every started series vanished until shapes arrived — and the first version
   * of this test asserted that drop and failed, which is the only reason anyone knows otherwise.
   *
   * The layout is needed to know what comes NEXT, and there are three ways to end up needing it. The resume
   * branch is `mark.fraction > RESUME_FLOOR && mark.fraction < WATCHED && ahead`, so `no_layout` is reached
   * when the mark is finished, when it sits at or below the floor, or when `ahead` is false — an in-progress
   * mark at or behind the furthest finished episode. The last is the one worth fearing: it drops a series
   * holding a live resume position, not merely one waiting to advance. All are the web's half of the TV's
   * symptom, where the same state drew the finished episode at 100% (oxyc/den#32).
   *
   * No viewer meets either state. Home's row and the Watchlist page both wait for `shelvesReady`, set only
   * after the naming pass has fetched a shape for every marked series — `shelfTitleRefs` passes the marks
   * wholesale, and a `tv` ref with no shape is deliberately not skipped.
   *
   * Both halves are pinned because that safety is load order rather than logic, and load order is not
   * something a test can watch. A surface drawing this row before the shapes arrive would lose finished-mark
   * series silently; it fails this instead.
   */
  it('resumes a started series with no shape, and holds back the three that need the layout', () => {
    const shapeless = (fraction: number, flags = new Map()): Library => ({
      records: [record('tv', 9, 'inProgress')],
      marks: [mark(9, 1, 2, fraction, 1000)],
      flags,
      shapes: new Map(),
      dismissed: new Map(),
    });
    expect(
      continueWatching(shapeless(0.5)).map((e) => [e.episode, e.fraction]),
      'in progress and ahead: the mark is the answer, no layout needed',
    ).toEqual([[{ season: 1, episode: 2 }, 0.5]]);
    expect(
      continueWatching(shapeless(1)),
      'finished: nothing to offer until the layout lands',
    ).toEqual([]);
    expect(
      continueWatching(shapeless(RESUME_FLOOR)),
      'at the floor: not a resume point, so it needs the layout too',
    ).toEqual([]);
    // `ahead` is false: E4 is flagged watched, so the E2 mark is behind the front. This one loses a real
    // resume position rather than merely waiting to advance, which is why it is the worst of the three.
    expect(
      continueWatching(
        shapeless(0.5, new Map([['tv:9:1:4', { type: 'tv', id: 9, season: 1, episode: 4 }]])),
      ),
      'behind the front: a live resume position, dropped',
    ).toEqual([]);
  });

  it('shows nothing for an empty library', () => {
    expect(watchlist(emptyLibrary())).toEqual([]);
    expect(continueWatching(emptyLibrary())).toEqual([]);
  });
});
