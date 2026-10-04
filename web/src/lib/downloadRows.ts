// The download queue Den Web and the TV share (den-spec library-v4 §17): one `set:download:<content>` settings row per
// download, sealed in the library like every setting. What a row means — its merge, a poll answer, a fallback, a
// prune and which release a download starts with — is den-core's (`syncPolicy`); this file only reads and builds rows.

import { syncPolicy } from './syncCore';
import type { ConfigValue, Row, SettingsRow, Stamp, Stamped } from './wire';

/** The release a download is fetching. `url` is the writer's play ticket, which another device may not reach. */
export interface DownloadRelease {
  identity: string;
  label: string;
  url: string;
  sizeBytes?: number;
  cached?: boolean;
}

/** What a download is of, and what to show for it. */
export interface DownloadTitle {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  title: string;
  posterPath?: string;
  stillPath?: string;
  originalLanguage?: string;
  preferredLanguage?: string;
}

/** A live download row, read. */
export interface Download {
  /** The row's settings name, `download:<content>`. */
  name: string;
  content: string;
  release: DownloadRelease;
  title: DownloadTitle;
  queuedAt: number;
  /** The device that queued it: the device of `queuedAt`'s stamp. */
  queuedBy: string;
  tried: string[];
  candidates?: number;
  exhausted: boolean;
  announced: boolean;
  reported: boolean;
  reannounced: boolean;
  resumeAt?: number;
  progress?: StallClock;
  row: SettingsRow;
  /** The seq den-edge gave the row as read: a holder's write is compare-and-set on it. 0 where unknown. */
  seq: number;
}

/** `download_status`'s stall clock. */
export interface StallClock {
  lastProgress: number;
  progressAt: number;
}

export const LEASE_ROW = 'download-lease';
const PREFIX = 'download:';

/** `<type>:<id>:<season or -1>:<episode or -1>`, the TV's `DeadStreamStore.contentKey`. */
export function contentKey(type: 'movie' | 'tv', id: number, season?: number, episode?: number) {
  return `${type}:${id}:${season ?? -1}:${episode ?? -1}`;
}

export const downloadName = (content: string) => `${PREFIX}${content}`;

/**
 * What makes a release this release, most stable first (the TV's `DeadStreamStore.identity`): an info-hash as a whole
 * path segment, then the release file name, then the URL itself. A ticket URL is minted per resolve; the file name
 * survives that.
 */
export function releaseIdentity(url: string, filename?: string): string {
  let segments: string[] = [];
  try {
    segments = new URL(url, 'https://den.invalid').pathname.split('/');
  } catch {
    // Not a URL: only the file name or the text itself can name it.
  }
  const hash = segments.find((s) => s.length === 40 && /^[0-9a-f]+$/i.test(s));
  if (hash) return hash.toLowerCase();
  if (filename) return filename.toLowerCase();
  return url;
}

const json = (value: Stamped<ConfigValue | null> | undefined): Record<string, unknown> | null => {
  const text = value?.value && 'string' in value.value ? value.value.string : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const int = (value: Stamped<ConfigValue | null> | undefined) =>
  value?.value && 'int' in value.value ? value.value.int : undefined;
const flag = (value: Stamped<ConfigValue | null> | undefined) =>
  !!(value?.value && 'bool' in value.value && value.value.bool);

/** A download row as its values say, or null for a tombstone, a row of another kind, or one too malformed to show. */
export function readDownload(row: Row): Download | null {
  if (row.kind !== 'set' || !row.name.startsWith(PREFIX)) return null;
  const values = row.values;
  const release = json(values.release);
  const title = json(values.title);
  const queuedAt = int(values.queuedAt);
  if (
    !release ||
    !title ||
    queuedAt === undefined ||
    typeof release.identity !== 'string' ||
    typeof release.url !== 'string' ||
    (title.mediaType !== 'movie' && title.mediaType !== 'tv') ||
    typeof title.mediaId !== 'number'
  )
    return null;
  const progress = json(values.progress);
  const tried = values.tried?.value;
  return {
    name: row.name,
    content: row.name.slice(PREFIX.length),
    release: release as unknown as DownloadRelease,
    title: {
      ...(title as unknown as DownloadTitle),
      title: typeof title.title === 'string' ? title.title : '',
    },
    queuedAt,
    queuedBy: values.queuedAt!.at[2],
    tried: tried && 'strings' in tried ? tried.strings : [],
    candidates: int(values.candidates),
    exhausted: flag(values.exhausted),
    announced: flag(values.announced),
    reported: flag(values.reported),
    reannounced: flag(values.reannounced),
    resumeAt: int(values.resumeAt),
    progress:
      progress &&
      typeof progress.lastProgress === 'number' &&
      typeof progress.progressAt === 'number'
        ? { lastProgress: progress.lastProgress, progressAt: progress.progressAt }
        : undefined,
    row,
    seq: 0,
  };
}

/** Every live download the rows hold, newest first. */
export function readDownloads(rows: Row[]): Download[] {
  return rows.flatMap((row) => readDownload(row) ?? []).sort((a, b) => b.queuedAt - a.queuedAt);
}

/** JSON of `value` with its keys sorted and its undefined members left out, as the TV writes these values. */
function canonical(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    if (value[key] !== undefined && value[key] !== null) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

export const releaseValue = (release: DownloadRelease): ConfigValue => ({
  string: canonical({ ...release }),
});
export const titleValue = (title: DownloadTitle): ConfigValue => ({
  string: canonical({ ...title }),
});
export const clockValue = (clock: StallClock): ConfigValue => ({
  string: canonical({ ...clock }),
});

export const emptyRow = (name: string): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name,
  values: {},
});

/** `row` with `values` set, each at its stamp, merged by den-core as every write of the row is. */
export function withValues(
  row: SettingsRow,
  values: Record<string, Stamped<ConfigValue | null>>,
): SettingsRow {
  return syncPolicy<SettingsRow>({
    op: 'download_merge',
    a: row,
    b: { ...row, values },
  });
}

export interface Start {
  release: DownloadRelease;
  title: DownloadTitle;
  /** How many releases the list it was picked from offered. */
  candidates?: number;
}

/**
 * The row a press of Download writes (§17 *Starting*): the same release still live gets a fresh `queuedAt` and is
 * asked for again; anything else — no row, a tombstone, another release, one that ran out of releases — starts over
 * with a removal stamped before every value.
 */
export function startRow(
  existing: SettingsRow | undefined,
  start: Start,
  issue: () => Stamp,
  now = Date.now(),
): SettingsRow {
  const current = existing ? readDownload(existing) : null;
  const base = existing ?? emptyRow(downloadName(contentKeyOf(start.title)));
  if (current && current.release.identity === start.release.identity && !current.exhausted)
    return withValues(base, { queuedAt: { value: { int: now }, at: issue() } });
  const values: Record<string, Stamped<ConfigValue | null>> = {};
  if (existing) values.removed = { value: { bool: true }, at: issue() };
  const at = issue();
  values.release = { value: releaseValue(start.release), at };
  values.title = { value: titleValue(start.title), at };
  values.queuedAt = { value: { int: now }, at };
  if (start.candidates !== undefined) values.candidates = { value: { int: start.candidates }, at };
  return withValues(base, values);
}

/** The tombstone a cancel, a Remove or a prune writes. */
export function removedRow(existing: SettingsRow, at: Stamp): SettingsRow {
  return withValues(existing, { removed: { value: { bool: true }, at } });
}

export const contentKeyOf = (title: DownloadTitle) =>
  contentKey(title.mediaType, title.mediaId, title.season, title.episode);

/** "Chrome on iPhone": what a device calls itself in `set:devices`, or nothing when it never said. */
export function deviceName(devices: SettingsRow | undefined, device: string): string | undefined {
  const value = devices?.values[`${device}.name`]?.value;
  return value && 'string' in value && value.string ? value.string : undefined;
}

/** "S2 · E4", or nothing for a movie. */
export function coordinate(title: DownloadTitle): string | undefined {
  return title.season !== undefined && title.episode !== undefined
    ? `S${title.season} · E${title.episode}`
    : undefined;
}
