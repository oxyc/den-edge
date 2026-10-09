// A title's watchlist/seen/opinion state, read from its row the one way `TitleActions` has always read it —
// shared so the detail page's pills and the poster menu (`titleActions.ts`) can never disagree.

import type { TitleRow } from './wire';

/** A person's opinion. `seen` survives in the wire union for imported legacy logs, but it is not a rating. */
export type Reaction = Exclude<NonNullable<TitleRow['reaction']['value']>, 'seen'>;

export interface TitleState {
  listed: boolean;
  seen: boolean;
  reaction: Reaction | null;
}

export function titleState(row: TitleRow | undefined): TitleState {
  const active = row !== undefined && !row.deleted.value;
  const rawReaction = active ? row.reaction.value : null;
  return {
    listed: active && row.status.value === 'watchlist',
    seen: active && row.status.value === 'watched',
    // Older trackers encoded "seen" in the reaction field. Seen now has its own status and must never light up
    // Like/Love or the phone rating picker merely because someone marked a title watched.
    reaction: rawReaction === 'seen' ? null : rawReaction,
  };
}
