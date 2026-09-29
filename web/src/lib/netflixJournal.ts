// A Netflix import's marks as tracker events (`trackerEvents`), the same rows the web's own "Seen" writes, so the
// Apple TV delivers them to Simkl like any other action.
//
// Each is stamped with the day it was watched rather than now, because a stamp's time is what the TV sends a tracker
// as the watched date. That also decides every clash by date: a mark older than what the library already says of the
// title or episode (seen again since, or un-seen since) loses, so it is left out rather than journalled to lose.

import { blankEpisode, blankTitle, markEpisode, markWatched } from './actions';
import type { Mark } from './netflixImport';
import { recordTrackerEvent } from './trackerEvents';
import {
  compareStamps,
  type EpisodeRow,
  type SettingsRow,
  type Stamp,
  type TitleRow,
} from './wire';

export interface Rows {
  title(ref: { type: string; id: number }): TitleRow | undefined;
  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined;
}

export function importJournals(marks: readonly Mark[], rows: Rows, device: string): SettingsRow[] {
  const journals: SettingsRow[] = [];
  // Marks share days, so the counter keeps each one's stamp its own.
  marks.forEach((mark, counter) => {
    const at: Stamp = [mark.at, counter, device];
    const ref = { type: mark.type, id: mark.id };
    if (mark.type === 'movie') {
      const before = rows.title(ref) ?? blankTitle(ref, mark.at);
      if (compareStamps(before.status.at, at) >= 0) return;
      const event = recordTrackerEvent(before, markWatched(before, at), at);
      if (event) journals.push(event);
      return;
    }
    const before =
      rows.episode(ref, mark.season!, mark.episode!) ??
      blankEpisode(ref, mark.season!, mark.episode!);
    if (compareStamps(before.progress.at, at) >= 0) return;
    const event = recordTrackerEvent(before, markEpisode(before, true, at), at);
    if (event) journals.push(event);
  });
  return journals;
}
