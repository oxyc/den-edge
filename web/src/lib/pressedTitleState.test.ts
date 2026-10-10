import { describe, expect, it } from 'vitest';
import {
  addToWatchlist,
  blankTitle,
  markWatched,
  react,
  removeFromLibrary,
  unwatch,
} from './actions';
import { titleViewRows } from './libraryViewPresentation';
import type { TitleView } from './libraryServiceProtocol';
import { pressedTitleState, type Press } from './pressedTitleState';
import { titleState } from './titleState';
import type { Stamp, TitleRow } from './wire';

const at = (t: number): Stamp => [t, 0, 'web1'];
const ref = { type: 'movie' as const, id: 693134 };
const dune = blankTitle(ref, 1000);

/** The row the title page reads for a stored one: the library's view of it (`#title`), as `titleViewRows` presents it. */
function present(stored: TitleRow): TitleRow | undefined {
  const visible = !stored.deleted.value;
  const standings = {
    watchlist: 'watchlist',
    watched: 'watched',
    inProgress: 'in-progress',
  } as const;
  const view: TitleView = {
    kind: 'title',
    title: ref,
    listed: visible && stored.status.value !== 'none',
    watched: visible && stored.status.value === 'watched',
    reaction: visible ? stored.reaction.value : null,
    standing: visible && stored.status.value !== 'none' ? standings[stored.status.value] : null,
    progress: null,
    episodes: [],
  };
  return titleViewRows({ ...ref, title: 'Dune' }, view).row;
}

describe('pressedTitleState', () => {
  it('is the row as read when nothing is being saved', () => {
    expect(pressedTitleState(undefined, null)).toEqual(titleState(undefined));
    const loved = present({ ...dune, reaction: { value: 'love', at: at(2) } });
    expect(pressedTitleState(loved, null)).toEqual(titleState(loved));
  });

  it('shows a press on a title the library has never held, which the page reads as removed', () => {
    for (const row of [undefined, present(dune)]) {
      expect(pressedTitleState(row, { kind: 'watchlist', value: true })).toEqual({
        listed: true,
        seen: false,
        reaction: null,
      });
      expect(pressedTitleState(row, { kind: 'reaction', value: 'love' })).toEqual({
        listed: false,
        seen: false,
        reaction: 'love',
      });
      expect(pressedTitleState(row, { kind: 'seen', value: true }).seen).toBe(true);
    }
  });

  it('shows no opinion over a title removed from the library', () => {
    const loved = present({
      ...dune,
      status: { value: 'watchlist', at: at(2) },
      reaction: { value: 'love', at: at(2) },
    });
    expect(pressedTitleState(loved, { kind: 'watchlist', value: false })).toEqual({
      listed: false,
      seen: false,
      reaction: null,
    });
  });

  // The state shown must be the one the write then leaves: each press is run through the real action it saves as,
  // and what is read back is what the page would read.
  const actions: Array<[Press, (row: TitleRow, t: Stamp) => TitleRow]> = [
    [{ kind: 'watchlist', value: true }, addToWatchlist],
    [{ kind: 'watchlist', value: false }, removeFromLibrary],
    [{ kind: 'seen', value: true }, markWatched],
    [{ kind: 'seen', value: false }, unwatch],
    [{ kind: 'reaction', value: 'love' }, (row, t) => react(row, 'love', t)],
    [{ kind: 'reaction', value: 'dislike' }, (row, t) => react(row, 'dislike', t)],
    [{ kind: 'reaction', value: null }, (row, t) => react(row, null, t)],
  ];
  // A title removed from the library is left out: the page cannot tell it from one never held, and the one press that
  // differs there — rating it — shows at once and is then taken back, because the library keeps a removed title's
  // opinion hidden. Rating a title never held, the common case, is what the page has to show.
  const starts: TitleRow[] = [
    dune,
    { ...dune, status: { value: 'watchlist', at: at(2) } },
    { ...dune, status: { value: 'watched', at: at(2) } },
    { ...dune, status: { value: 'watched', at: at(2) }, reaction: { value: 'love', at: at(2) } },
    { ...dune, status: { value: 'inProgress', at: at(2) } },
    { ...dune, reaction: { value: 'like', at: at(2) } },
  ];

  it('agrees with what the write leaves, for every start and every press', () => {
    for (const start of starts)
      for (const [press, write] of actions)
        expect(
          pressedTitleState(present(start), press),
          `${JSON.stringify([start.status.value, start.reaction.value])}: ${press.kind}=${press.value}`,
        ).toEqual(titleState(present(write(start, at(10)))));
  });
});
