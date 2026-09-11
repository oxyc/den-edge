// What the web can do to a title, as the TV's LibraryStateMachine does it: each action is a "set" (never a toggle,
// den-spec §6) stamped once, applied to the row as last read — or to a blank one for a title new to the library.

import { ZERO_STAMP, type EpisodeRow, type Progress, type Stamp, type TitleRow } from './wire';

type Reaction = NonNullable<TitleRow['reaction']['value']>;

/** All but the credits: seen (the TV's `LibraryRecord.watchedThreshold`). */
export const WATCHED = 0.95;

/** A resume point moved to `fraction` (the TV's `updateProgress`); playing past the end of a finished one is a replay. */
function moved(progress: Progress, fraction: number, seconds: number, at: Stamp): Progress {
  const value = Math.min(1, Math.max(0, fraction));
  // A replay starts a new viewing, or the finished one's 100% outvotes every new position.
  const replay = progress.value >= WATCHED && value < WATCHED;
  return { value, at, viewing: progress.viewing + (replay ? 1 : 0), seconds };
}

/** Where playback of a movie got to: in progress, or seen past the credits' start. */
export function updateProgress(row: TitleRow, fraction: number, seconds: number, at: Stamp): TitleRow {
  const resume = moved(row.resume, fraction, seconds, at);
  if (resume.value >= WATCHED) return { ...row, resume, status: { value: 'watched', at }, watchedAt: row.watchedAt ?? at[0] };
  if (resume.value > 0) return { ...row, resume, status: { value: 'inProgress', at } };
  return { ...row, resume };
}

/** Where playback of an episode got to. */
export function updateEpisodeProgress(row: EpisodeRow, fraction: number, seconds: number, at: Stamp): EpisodeRow {
  return { ...row, progress: moved(row.progress, fraction, seconds, at) };
}

/** A title the library has never held: every field at the zero stamp, so any real edit beats it. */
export function blankTitle(ref: { type: 'movie' | 'tv'; id: number }, now: number): TitleRow {
  return {
    kind: 'rec',
    schema: 2,
    title: { type: ref.type, id: ref.id },
    status: { value: 'none', at: ZERO_STAMP },
    resume: { value: 0, at: ZERO_STAMP, viewing: 0 },
    reaction: { value: null, at: ZERO_STAMP },
    deleted: { value: false, at: ZERO_STAMP },
    dismissed: { value: false, at: ZERO_STAMP },
    episodesReset: null,
    addedAt: now,
    watchedAt: null,
  };
}

/** On the watchlist, and back in the library if it was removed. A title in progress stays in progress. */
export function addToWatchlist(row: TitleRow, at: Stamp): TitleRow {
  const status = row.status.value === 'none' || row.status.value === 'watched' ? { value: 'watchlist' as const, at } : row.status;
  return { ...row, deleted: { value: false, at }, status };
}

/** Out of the library: a tombstone, which a later add undoes. */
export function removeFromLibrary(row: TitleRow, at: Stamp): TitleRow {
  return { ...row, deleted: { value: true, at } };
}

export function markWatched(row: TitleRow, at: Stamp): TitleRow {
  return {
    ...row,
    deleted: { value: false, at },
    status: { value: 'watched', at },
    resume: { ...row.resume, value: 1, at },
    watchedAt: row.watchedAt ?? at[0],
  };
}

/** "Seen" off: the resume point starts over in a new viewing, so the old 100% can't outvote it. */
export function unwatch(row: TitleRow, at: Stamp): TitleRow {
  return {
    ...row,
    status: { value: 'none', at },
    resume: { value: 0, at, viewing: row.resume.viewing + 1 },
    watchedAt: null,
  };
}

export function react(row: TitleRow, reaction: Reaction | null, at: Stamp): TitleRow {
  return { ...row, reaction: { value: reaction, at } };
}

/** An episode the library has never held: no progress, at the zero stamp. */
export function blankEpisode(ref: { type: 'movie' | 'tv'; id: number }, season: number, episode: number): EpisodeRow {
  return {
    kind: 'ep',
    schema: 2,
    title: { type: ref.type, id: ref.id },
    season,
    episode,
    progress: { value: 0, at: ZERO_STAMP, viewing: 0 },
  };
}

/**
 * An episode seen, or not (den-spec §3): seen is the whole of it in this viewing; un-seen is nothing in a new one, so
 * the old 100% can't outvote it.
 */
export function markEpisode(row: EpisodeRow, seen: boolean, at: Stamp): EpisodeRow {
  const progress = seen
    ? { value: 1, at, viewing: row.progress.viewing }
    : { value: 0, at, viewing: row.progress.viewing + 1 };
  return { ...row, progress };
}
