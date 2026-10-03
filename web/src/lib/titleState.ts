// A title's watchlist/seen/opinion state, read from its row the one way `TitleActions` has always read it —
// shared so the detail page's pills and the poster menu (`titleActions.ts`) can never disagree.

import type { TitleRow } from './wire';

export type Reaction = NonNullable<TitleRow['reaction']['value']>;

export interface TitleState {
  listed: boolean;
  seen: boolean;
  reaction: Reaction | null;
}

export function titleState(row: TitleRow | undefined): TitleState {
  const active = row !== undefined && !row.deleted.value;
  return {
    listed: active && row.status.value === 'watchlist',
    seen: active && row.status.value === 'watched',
    reaction: active ? (row.reaction.value ?? null) : null,
  };
}
