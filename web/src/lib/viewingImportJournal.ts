// A provider import becomes the library's current rows, not tracker events: the original viewing timestamps resolve
// conflicts and are later eligible for the Apple TV's tracker catch-up. Re-importing the same history is idempotent.

import {
  blankEpisode,
  blankTitle,
  dismissFromContinueWatching,
  markEpisode,
  markWatched,
  WATCHED,
} from './actions';
import { isAired } from './library';
import type { ImportShow, ViewingMark } from './viewingImport';
import type { EpisodeRow, Row, Stamp, TitleRow } from './wire';

export interface ImportRows {
  title(ref: { type: string; id: number }): TitleRow | undefined;
  episode(
    ref: { type: string; id: number },
    season: number,
    episode: number,
  ): EpisodeRow | undefined;
}

/** One film or series of writes, keyed so the preview can exclude it whole. */
export interface ImportWrites {
  key: string;
  rows: Row[];
}

export interface ImportRowWriter {
  refusal: string | null;
  writeRows(rows: Row[]): Promise<boolean>;
}

export type ImportBatchResult =
  | { complete: true; written: number; total: number }
  | { complete: false; written: number; total: number; refusal: string | null };

/** An unfinished series last watched this long before the import stays off Continue Watching. */
export const STALE_MS = 182 * 86_400_000;
export const importKey = (mark: { type: string; id: number }) => `${mark.type}:${mark.id}`;

/** Convert resolved provider marks into conflict-safe Library v3 rows, grouped for preview exclusion. */
export function importWrites(
  marks: readonly ViewingMark[],
  shows: Readonly<Record<number, ImportShow>>,
  rows: ImportRows,
  device: string,
  now: number,
): ImportWrites[] {
  let counter = 0;
  const stamp = (at: number): Stamp => [at, counter++, device];
  const byTitle = new Map<string, ViewingMark[]>();
  for (const mark of marks) {
    const key = importKey(mark);
    byTitle.set(key, [...(byTitle.get(key) ?? []), mark]);
  }

  return [...byTitle].map(([key, group]) => {
    const ref = { type: group[0]!.type, id: group[0]!.id };
    const written: Row[] = [];

    if (ref.type === 'movie') {
      const mark = group[0]!;
      const before = rows.title(ref) ?? blankTitle(ref, mark.at);
      if (before.status.at[0] < mark.at) written.push(markWatched(before, stamp(mark.at)));
      return { key, rows: written };
    }

    const imported = new Set<string>();
    let last = 0;
    for (const mark of group) {
      last = Math.max(last, mark.at);
      const before =
        rows.episode(ref, mark.season!, mark.episode!) ??
        blankEpisode(ref, mark.season!, mark.episode!);
      if (before.progress.at[0] >= mark.at) continue;
      imported.add(`${mark.season}:${mark.episode}`);
      written.push(markEpisode(before, true, stamp(mark.at)));
    }

    const show = shows[ref.id];
    const title = rows.title(ref) ?? blankTitle(ref, last);
    if (
      show &&
      finished(
        show,
        (season, episode) =>
          imported.has(`${season}:${episode}`) || seenHere(rows, ref, season, episode),
      )
    ) {
      if (title.status.at[0] < last) written.push(markWatched(title, stamp(last)));
    } else if (now - last > STALE_MS && title.dismissed.at[0] <= last) {
      written.push(dismissFromContinueWatching(title, stamp(last + 1)));
    }
    return { key, rows: written };
  });
}

/** Write selected titles in bounded batches and report exactly where a retry should resume. */
export async function writeImportBatches(
  writes: readonly ImportWrites[],
  writer: ImportRowWriter,
  progress?: (written: number, total: number) => void,
  batchSize = 250,
): Promise<ImportBatchResult> {
  const rows = writes.flatMap((entry) => entry.rows);
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    writer.refusal = null;
    if (!(await writer.writeRows(batch)))
      return { complete: false, written: start, total: rows.length, refusal: writer.refusal };
    progress?.(start + batch.length, rows.length);
  }
  return { complete: true, written: rows.length, total: rows.length };
}

function finished(show: ImportShow, seen: (season: number, episode: number) => boolean): boolean {
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

const seenHere = (
  rows: ImportRows,
  ref: { type: string; id: number },
  season: number,
  episode: number,
) => (rows.episode(ref, season, episode)?.progress.value ?? 0) >= WATCHED;
