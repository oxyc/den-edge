// What a title's Watchlist, Seen and opinion read as while a press on one of them is still being saved: the row as
// last read, with the press laid over it. The row stays the truth — a press that is saved changes it, one that fails
// never did — so dropping the press is all that undoing it takes.

import { titleState, type Reaction, type TitleState } from './titleState';
import type { TitleRow } from './wire';

export type SaveKind = 'watchlist' | 'seen' | 'reaction';

/** A press not yet saved: what it sets, and for an opinion, which button it was made on. */
export interface Press {
  kind: SaveKind;
  /** Watchlist and Seen: on or off. An opinion: the one it sets, or null for none. */
  value: boolean | Reaction | null;
  button?: Reaction;
}

/**
 * `row`, as the title page reads it (`titleViewRows`), with `press` laid over it: what the press does to the title
 * when it is saved (`actions.ts`). Watchlist and Seen share the one status, and removing from the library hides the
 * opinion with it.
 *
 * The page's row is the library's view of the title, not the stored row: a title that is not held reads as removed,
 * and one with an opinion reads as held ("a reaction means held"). Pressing an opinion on a title that is not held
 * therefore shows it, as the saved row will.
 */
export function pressedTitleState(row: TitleRow | undefined, press: Press | null): TitleState {
  if (!press) return titleState(row);
  const held = row !== undefined && !row.deleted.value;
  let removed = false;
  let status: TitleRow['status']['value'] = held ? row.status.value : 'none';
  let reaction: TitleRow['reaction']['value'] = held ? row.reaction.value : null;
  if (press.kind === 'reaction') reaction = press.value as Reaction | null;
  else if (press.kind === 'seen') status = press.value ? 'watched' : 'none';
  else if (!press.value) removed = true;
  else if (status === 'none' || status === 'watched') status = 'watchlist';
  // As the page reads a stored row back: nothing of a removed title shows, and an opinion alone holds it.
  const shownReaction = removed ? null : reaction;
  const gone = (removed || status === 'none') && shownReaction === null;
  return {
    listed: !gone && status === 'watchlist',
    seen: !gone && status === 'watched',
    reaction: gone || shownReaction === 'seen' ? null : shownReaction,
  };
}
