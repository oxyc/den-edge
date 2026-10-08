// Bounded presentation bridge for components that still render stamped row shapes. It synthesizes no authority:
// every value comes from an immutable LibraryModel view, and every mutation goes back through semantic commands.

import { blankEpisode, blankTitle, WATCHED } from './actions';
import type { Title } from './library';
import type { Immutable } from './libraryModel.svelte';
import type { LibraryOverviewView, TitleRef, TitleView } from './libraryServiceProtocol';
import type { EpisodeRow, Stamp, TitleRow } from './wire';

const DISPLAY_STAMP: Stamp = [0, 0, 'service'];

export function overviewTitleRow(
  title: Title,
  overview: Immutable<LibraryOverviewView> | undefined,
): TitleRow | undefined {
  if (!overview) return undefined;
  const same = (ref: Immutable<TitleRef>) => ref.type === title.type && ref.id === title.id;
  const standing = overview.standings.find(({ title: ref }) => same(ref))?.standing;
  const watched = overview.watched.some(same);
  const listed = overview.owned.some(same);
  if (!listed && !standing && !watched) return undefined;
  return rowFromState(title, {
    listed,
    watched,
    standing: watched ? 'watched' : (standing ?? null),
    reaction: null,
    progress: null,
  });
}

export function titleViewRows(
  title: Title,
  view: Immutable<TitleView> | undefined,
): { row: TitleRow | undefined; episodes: Map<string, EpisodeRow> } {
  if (!view) return { row: undefined, episodes: new Map() };
  const row = rowFromState(title, view);
  const episodes = new Map<string, EpisodeRow>();
  for (const item of view.episodes) {
    const episode = blankEpisode(title, item.season, item.episode);
    episode.progress = {
      value: item.watched ? WATCHED : item.fraction,
      at: DISPLAY_STAMP,
      viewing: item.updatedAt ?? 0,
      ...(item.seconds === undefined ? {} : { seconds: item.seconds }),
    };
    episodes.set(`${item.season}:${item.episode}`, episode);
  }
  return { row, episodes };
}

function rowFromState(
  title: Title,
  state: Pick<Immutable<TitleView>, 'listed' | 'watched' | 'standing' | 'reaction' | 'progress'>,
): TitleRow {
  const row = blankTitle(title, 0);
  row.deleted = { value: !state.listed, at: DISPLAY_STAMP };
  row.status = {
    value:
      state.watched || state.standing === 'watched'
        ? 'watched'
        : state.standing === 'in-progress'
          ? 'inProgress'
          : (state.standing ?? 'none'),
    at: DISPLAY_STAMP,
  };
  row.reaction = { value: state.reaction, at: DISPLAY_STAMP };
  row.resume = {
    value: state.progress?.fraction ?? 0,
    at: DISPLAY_STAMP,
    viewing: state.progress?.updatedAt ?? 0,
    ...(state.progress?.seconds === undefined ? {} : { seconds: state.progress.seconds }),
  };
  return row;
}
