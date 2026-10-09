// Bounded presentation bridge for components that still render stamped row shapes. It synthesizes no authority:
// every value comes from an immutable LibraryModel view, and every mutation goes back through semantic commands.

import { blankEpisode, blankTitle, WATCHED } from './actions';
import { titleKey, type Title } from './library';
import type { Immutable } from './libraryModel.svelte';
import type { LibraryOverviewView, Standing, TitleView } from './libraryServiceProtocol';
import type { EpisodeRow, Stamp, TitleRow } from './wire';

const DISPLAY_STAMP: Stamp = [0, 0, 'service'];

interface OverviewTitleState {
  listed?: true;
  watched?: true;
  standing?: Standing;
}

/**
 * The title state Home needs, keyed once for one immutable overview replacement.
 *
 * Billboard slides ask for this state during presentation and interaction updates. Keeping the index beside that
 * presentation boundary avoids repeatedly walking the whole library without giving components another library
 * authority of their own.
 */
export class OverviewTitleIndex {
  readonly #states = new Map<string, OverviewTitleState>();

  constructor(overview: Immutable<LibraryOverviewView>) {
    for (const title of overview.owned) this.#state(title).listed = true;
    for (const title of overview.watched) this.#state(title).watched = true;
    for (const { title, standing } of overview.standings) {
      const state = this.#state(title);
      // Preserve the old `find` behavior if a malformed projection contains the same title twice.
      state.standing ??= standing;
    }
  }

  row(title: Title): TitleRow | undefined {
    const state = this.#states.get(titleKey(title));
    if (!state) return undefined;
    return rowFromState(title, {
      listed: state.listed === true,
      watched: state.watched === true,
      standing: state.watched ? 'watched' : (state.standing ?? null),
      reaction: null,
      progress: null,
    });
  }

  #state(title: { type: string; id: number }): OverviewTitleState {
    const key = titleKey(title);
    let state = this.#states.get(key);
    if (!state) {
      state = {};
      this.#states.set(key, state);
    }
    return state;
  }
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
