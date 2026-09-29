// A Netflix import's marks as tracker events (`trackerEvents`), the same rows the web's own "Seen" writes, so the
// Apple TV delivers them to Simkl like any other action.
//
// Each is stamped with the day it was watched rather than now, because a stamp's time is what the TV sends a tracker
// as the watched date. That also decides every clash by date: a mark older than what the library already says of the
// title or episode (seen again since, or un-seen since) loses, so it is left out rather than journalled to lose.
// Compared by time alone: the counter is a mark's place in this file, so the same file imported again would
// otherwise read as newer and journal every mark twice.

import {
  blankEpisode,
  blankTitle,
  dismissFromContinueWatching,
  markEpisode,
  markWatched,
  WATCHED,
} from './actions';
import { isAired } from './library';
import type { Mark, Show } from './netflixImport';
import { recordTrackerEvent } from './trackerEvents';
import type { EpisodeRow, Row, SettingsRow, Stamp, TitleRow } from './wire';

export interface Rows {
  title(ref: { type: string; id: number }): TitleRow | undefined;
  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined;
}

/** What one film or series of the import writes, under its `type:id`, so the preview can leave it out whole. */
export interface Writes {
  key: string;
  /** Tracker events: its films or episodes seen, and a series finished. */
  events: SettingsRow[];
  /** Rows written as they are, which no tracker hears of: an old series off Continue Watching. */
  rows: Row[];
}

/** An unfinished series last watched this long before the import stays off Continue Watching. */
export const STALE_MS = 182 * 86_400_000;

export const importKey = (mark: { type: string; id: number }) => `${mark.type}:${mark.id}`;

/**
 * The import's writes, one entry per film and series.
 *
 * A series whose every aired episode the library will then hold as seen is marked seen itself, as the web's own
 * series "Seen" does, which takes it off Continue Watching and gives its poster the check. One left unfinished and
 * last watched more than `STALE_MS` before `now` is taken off Continue Watching instead: a dismissal stamped just
 * after its last viewing, so watching it again anywhere puts it back.
 */
export function importWrites(
  marks: readonly Mark[],
  shows: Readonly<Record<number, Show>>,
  rows: Rows,
  device: string,
  now: number,
): Writes[] {
  let counter = 0;
  const stamp = (at: number): Stamp => [at, counter++, device];
  const byTitle = new Map<string, Mark[]>();
  for (const mark of marks) {
    const key = importKey(mark);
    byTitle.set(key, [...(byTitle.get(key) ?? []), mark]);
  }

  return [...byTitle].map(([key, group]) => {
    const ref = { type: group[0]!.type, id: group[0]!.id };
    const events: SettingsRow[] = [];
    const written: Row[] = [];
    const journal = (before: Row, after: Row, at: Stamp) => {
      const event = recordTrackerEvent(before, after, at);
      if (event) events.push(event);
    };

    if (ref.type === 'movie') {
      const mark = group[0]!;
      const before = rows.title(ref) ?? blankTitle(ref, mark.at);
      if (before.status.at[0] < mark.at) {
        const at = stamp(mark.at);
        journal(before, markWatched(before, at), at);
      }
      return { key, events, rows: written };
    }

    const imported = new Set<string>();
    let last = 0;
    for (const mark of group) {
      last = Math.max(last, mark.at);
      const before =
        rows.episode(ref, mark.season!, mark.episode!) ??
        blankEpisode(ref, mark.season!, mark.episode!);
      // Left as the library has it, which says itself whether the episode is seen (`seenHere`): un-seen since
      // Netflix, it doesn't count towards the series being finished.
      if (before.progress.at[0] >= mark.at) continue;
      imported.add(`${mark.season}:${mark.episode}`);
      const at = stamp(mark.at);
      journal(before, markEpisode(before, true, at), at);
    }

    const show = shows[ref.id];
    const title = rows.title(ref) ?? blankTitle(ref, last);
    if (show && finished(show, (s, e) => imported.has(`${s}:${e}`) || seenHere(rows, ref, s, e))) {
      if (title.status.at[0] < last) {
        const at = stamp(last);
        journal(title, markWatched(title, at), at);
      }
    } else if (now - last > STALE_MS && title.dismissed.at[0] <= last) {
      written.push(dismissFromContinueWatching(title, stamp(last + 1)));
    }
    return { key, events, rows: written };
  });
}

/** Every aired episode of the regular seasons is seen; a series listing none is not finished by anything. */
function finished(show: Show, seen: (season: number, episode: number) => boolean): boolean {
  let any = false;
  for (const [season, count] of show.counts) {
    if (season <= 0) continue;
    for (let episode = 1; episode <= count; episode++) {
      if (!isAired({ season, episode }, show.lastAired)) continue;
      any = true;
      if (!seen(season, episode)) return false;
    }
  }
  return any;
}

const seenHere = (rows: Rows, ref: { type: string; id: number }, season: number, episode: number) =>
  (rows.episode(ref, season, episode)?.progress.value ?? 0) >= WATCHED;
