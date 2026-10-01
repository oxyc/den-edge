import { describe, expect, it } from 'vitest';
import {
  blankEpisode,
  blankTitle,
  markEpisode,
  markWatched,
  removeFromLibrary,
  unwatch,
  updateEpisodeProgress,
} from './actions';
import {
  UNKNOWN_YEAR,
  airedEpisodes,
  seenAired,
  seenEpisodes,
  watchedHistory,
  watchedView,
  type WatchedEntry,
} from './history';
import type { Title } from './library';
import type { Row, Stamp } from './wire';

const at = (t: number): Stamp => [t, 0, 'web1'];
const named = (...titles: Title[]) => new Map(titles.map((t) => [`${t.type}:${t.id}`, t]));
const movie = (id: number): Title => ({ type: 'movie', id, title: `Movie ${id}` });
const show = (id: number): Title => ({ type: 'tv', id, title: `Series ${id}` });
const seen = (id: number, season: number, episode: number, t: number) =>
  markEpisode(blankEpisode({ type: 'tv', id }, season, episode), true, at(t));

describe('watched history', () => {
  it('lists seen titles and part-watched series together, newest first', () => {
    const rows: Row[] = [
      markWatched(blankTitle({ type: 'movie', id: 1 }, 1), at(1000)),
      markWatched(blankTitle({ type: 'movie', id: 2 }, 1), at(3000)),
      seen(10, 1, 1, 2000),
      seen(10, 1, 2, 4000),
      // Half an episode isn't a watched one.
      updateEpisodeProgress(blankEpisode({ type: 'tv', id: 11 }, 1, 1), 0.5, 600, at(5000)),
    ];
    const history = watchedHistory(rows, named(movie(1), movie(2), show(10), show(11)));
    expect(history.map((e) => [e.title.id, e.at, e.episode, e.episodes])).toEqual([
      [10, 4000, { season: 1, episode: 2 }, 2],
      [2, 3000, undefined, 0],
      [1, 1000, undefined, 0],
    ]);
  });

  it('dates a series seen as a whole by its latest episode when that came later', () => {
    const rows: Row[] = [
      markWatched(blankTitle({ type: 'tv', id: 10 }, 1), at(2000)),
      seen(10, 2, 8, 6000),
    ];
    expect(watchedHistory(rows, named(show(10)))).toEqual([
      { title: show(10), at: 6000, episode: { season: 2, episode: 8 }, episodes: 1 },
    ]);
  });

  it('waits for a name, drops episodes from before a reset, and leaves out a title removed since', () => {
    const reset = {
      ...unwatch(markWatched(blankTitle({ type: 'tv', id: 10 }, 1), at(1000)), at(3000)),
      episodesReset: at(3000),
    };
    const removed = removeFromLibrary(
      markWatched(blankTitle({ type: 'movie', id: 2 }, 1), at(1000)),
      at(2000),
    );
    const rows: Row[] = [
      reset,
      seen(10, 1, 1, 2500),
      removed,
      markWatched(blankTitle({ type: 'movie', id: 3 }, 1), at(1500)),
    ];
    expect(watchedHistory(rows, named(show(10), movie(2)))).toEqual([]);
    // Seen again after the reset, it's back.
    expect(watchedHistory([...rows, seen(10, 1, 2, 4000)], named(show(10))).length).toBe(1);
  });

  it('dates a title seen again by that watch, not its first', () => {
    const first = markWatched(blankTitle({ type: 'movie', id: 1 }, 1), at(1000));
    const again = markWatched(unwatch(first, at(2000)), at(9000));
    expect(watchedHistory([{ ...again, watchedAt: 1000 }], named(movie(1)))[0]?.at).toBe(9000);
  });

  it('keeps a watch with no time, after every dated one', () => {
    const imported = markEpisode(blankEpisode({ type: 'tv', id: 10 }, 1, 1), true, [0, 0, '']);
    const history = watchedHistory(
      [imported, markWatched(blankTitle({ type: 'movie', id: 1 }, 1), at(1000))],
      named(show(10), movie(1)),
    );
    expect(history.map((e) => [e.title.id, e.at])).toEqual([
      [1, 1000],
      [10, 0],
    ]);
  });

  it('counts seen episodes against aired ones, leaving out Specials and unaired ones', () => {
    const episodes = seenEpisodes([
      seen(10, 1, 1, 1000),
      seen(10, 1, 2, 2000),
      seen(10, 0, 1, 2500),
      seen(10, 2, 9, 3000),
      seen(11, 3, 1, 1000),
    ]);
    expect([...episodes].map(([key, list]) => [key, list.length])).toEqual([
      ['tv:10', 4],
      ['tv:11', 1],
    ]);
    const shape = {
      counts: new Map([
        [0, 4],
        [1, 8],
        [2, 10],
        [3, 10],
      ]),
      lastAired: { season: 2, episode: 6 },
    };
    expect(airedEpisodes(shape)).toBe(14);
    expect(airedEpisodes({ counts: shape.counts })).toBe(28);
    // S0E1 is a Special and S2E9 hasn't aired: two of the four count; without a layout, the three regular ones.
    expect(seenAired(episodes.get('tv:10') ?? [], shape)).toBe(2);
    expect(seenAired(episodes.get('tv:10') ?? [], undefined)).toBe(3);
  });

  it('falls back to when the status changed for a watched title without a watched date', () => {
    const imported = {
      ...markWatched(blankTitle({ type: 'movie', id: 1 }, 1), at(7000)),
      watchedAt: -1,
    };
    expect(watchedHistory([imported], named(movie(1)))[0]?.at).toBe(7000);
  });
});

describe('watched years', () => {
  // Mid-year in the viewer's own calendar, as the page files them, so no time zone moves one across New Year.
  const inYear = (year: number) => new Date(year, 5, 15).getTime();
  const entry = (title: Title, when: number): WatchedEntry => ({ title, at: when, episodes: 0 });
  // Newest first, as `watchedHistory` gives them, with the undated last.
  const history = [
    entry(show(10), inYear(2024)),
    entry(movie(1), inYear(2024)),
    entry(movie(2), inYear(2019)),
    entry(show(11), inYear(2012)),
    entry(movie(3), 0),
  ];

  it('lists each year with a watch, newest first, its count, and the undated last', () => {
    const { years, shown } = watchedView(history, null);
    expect(years).toEqual([
      { year: '2024', count: 2 },
      { year: '2019', count: 1 },
      { year: '2012', count: 1 },
      { year: UNKNOWN_YEAR, count: 1 },
    ]);
    expect(shown).toEqual(history);
  });

  it('shows one year, and the undated under Unknown rather than nowhere', () => {
    expect(watchedView(history, null, '2024').shown.map((e) => e.title.id)).toEqual([10, 1]);
    expect(watchedView(history, null, UNKNOWN_YEAR).shown.map((e) => e.title.id)).toEqual([3]);
  });

  it('counts and shows within the type tab picked', () => {
    const series = watchedView(history, 'tv');
    expect(series.years).toEqual([
      { year: '2024', count: 1 },
      { year: '2012', count: 1 },
    ]);
    expect(watchedView(history, 'movie', '2024').shown.map((e) => e.title.id)).toEqual([1]);
    // A year picked under All that this type has nothing in stays listed, at 0, and shows nothing.
    const none = watchedView(history, 'tv', '2019');
    expect(none.years.map((y) => [y.year, y.count])).toEqual([
      ['2024', 1],
      ['2019', 0],
      ['2012', 1],
    ]);
    expect(none.shown).toEqual([]);
  });
});
