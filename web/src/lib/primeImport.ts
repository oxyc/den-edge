// Prime's privacy export describes one history in two files. Watch Events has the canonical viewing date and
// cumulative watch time; Viewing History has repeated playback sessions and the movie/episode identity Prime omitted
// from Watch Events. This module reads and joins those files without retaining their device or location telemetry.

import { csvRecords } from './viewingImportCsv';
import { normalizeViewingName } from './viewingImport';

const WATCH_HEADERS = [
  'Deleted from Watch History',
  'Most Recent Watch Date',
  'Seconds Watched',
  'Title Description',
  'Title Name',
] as const;
const HISTORY_HEADERS = [
  'Material Type Description',
  'Playback Start Datetime (UTC)',
  'Seconds Viewed',
  'Title',
] as const;
const CLOSE_MS = 36 * 60 * 60 * 1000;

export type PrimeFileKind = 'watchEvents' | 'viewingHistory';

export interface PrimeSourceFile {
  name: string;
  text: string;
}

interface WatchEvent {
  title: string;
  description: string;
  at: number;
  watchedSeconds: number;
  deleted: boolean;
}

interface PlaybackSession {
  rawTitle: string;
  material: 'Feature' | 'Full';
  at: number;
  viewedSeconds: number;
  durationSeconds?: number;
}

export interface PrimeViewing {
  kind: 'movie' | 'episode';
  title: string;
  description: string;
  rawTitle: string;
  watchedAt: number;
  watchedSeconds: number;
  durationSeconds?: number;
  show?: string;
  season?: number;
}

export interface PrimeImportSource {
  viewings: PrimeViewing[];
  diagnostics: {
    events: number;
    deleted: number;
    invalid: number;
    unmatched: string[];
    ambiguous: string[];
  };
}

/** Identify either Prime file from its schema, regardless of the filename selected by the viewer. */
export function primeFileKind(text: string): PrimeFileKind | null {
  const [record] = csvRecords(text);
  const keys = new Set(Object.keys(record ?? {}));
  if (WATCH_HEADERS.every((header) => keys.has(header))) return 'watchEvents';
  if (HISTORY_HEADERS.every((header) => keys.has(header))) return 'viewingHistory';
  return null;
}

/**
 * Parse and join one Watch Events file and one Viewing History file. Only import-relevant fields cross this boundary;
 * Prime's city, ISP, ZIP code, device, network and playback telemetry are never represented in the returned value.
 */
export function parsePrimeFiles(files: readonly PrimeSourceFile[]): PrimeImportSource {
  const found = new Map<PrimeFileKind, PrimeSourceFile>();
  for (const file of files) {
    const kind = primeFileKind(file.text);
    if (!kind) throw new Error(`${file.name} is not a Prime Video viewing-history file`);
    if (found.has(kind)) throw new Error(`More than one ${label(kind)} file was selected`);
    found.set(kind, file);
  }
  const watch = found.get('watchEvents');
  const history = found.get('viewingHistory');
  if (!watch || !history) throw new Error('Choose both Watch Events.csv and Viewing History.csv');

  let invalid = 0;
  const events = csvRecords(watch.text).flatMap((record): WatchEvent[] => {
    const at = Date.parse(primeText(record['Most Recent Watch Date']));
    const watchedSeconds = number(primeText(record['Seconds Watched']));
    const title = primeText(record['Title Name']);
    if (!title || !Number.isFinite(at) || watchedSeconds === undefined) {
      invalid++;
      return [];
    }
    return [
      {
        title,
        description: primeText(record['Title Description']),
        at,
        watchedSeconds,
        deleted: /^yes$/i.test(primeText(record['Deleted from Watch History'])),
      },
    ];
  });
  const sessions = csvRecords(history.text).flatMap((record): PlaybackSession[] => {
    const material = primeText(record['Material Type Description']);
    if (material !== 'Feature' && material !== 'Full') return [];
    const at = Date.parse(primeText(record['Playback Start Datetime (UTC)']));
    const rawTitle = primeText(record.Title);
    const viewedSeconds = number(primeText(record['Seconds Viewed']));
    if (!rawTitle || !Number.isFinite(at) || viewedSeconds === undefined) {
      invalid++;
      return [];
    }
    const durations = Object.entries(record).flatMap(([header, value]) => {
      if (!header.startsWith('Video Duration in')) return [];
      const milliseconds = number(primeText(value));
      return milliseconds !== undefined && milliseconds > 0 ? [milliseconds / 1000] : [];
    });
    return [
      {
        rawTitle,
        material,
        at,
        viewedSeconds,
        ...(durations.length ? { durationSeconds: Math.max(...durations) } : {}),
      },
    ];
  });

  const byFirstWord = new Map<string, PlaybackSession[]>();
  for (const session of sessions) {
    const first = normalizeViewingName(session.rawTitle).split(' ')[0] ?? '';
    byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), session]);
  }
  const viewings: PrimeViewing[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  let deleted = 0;
  for (const event of events) {
    if (event.deleted) {
      deleted++;
      continue;
    }
    const wanted = normalizeViewingName(event.title);
    const candidates = (byFirstWord.get(wanted.split(' ')[0] ?? '') ?? []).filter((session) => {
      const raw = normalizeViewingName(session.rawTitle);
      return raw === wanted || raw.startsWith(`${wanted} `);
    });
    const nearby = candidates.filter((session) => Math.abs(session.at - event.at) <= CLOSE_MS);
    const rawTitles = distinctRawTitles(nearby.length ? nearby : candidates);
    if (!rawTitles.length) {
      unmatched.push(event.title);
      continue;
    }
    if (rawTitles.length !== 1) {
      ambiguous.push(event.title);
      continue;
    }
    const rawTitle = rawTitles[0]!;
    const sameTitle = sessions.filter((session) => session.rawTitle === rawTitle);
    const material = sameTitle[0]!.material;
    const durations = sameTitle.flatMap((session) =>
      session.durationSeconds === undefined ? [] : [session.durationSeconds],
    );
    const episode = material === 'Full' ? primeEpisodeHint(event.title, rawTitle) : undefined;
    viewings.push({
      kind: material === 'Feature' ? 'movie' : 'episode',
      title: event.title,
      description: event.description,
      rawTitle,
      watchedAt: event.at,
      watchedSeconds: event.watchedSeconds,
      ...(durations.length ? { durationSeconds: Math.max(...durations) } : {}),
      ...(episode?.show ? { show: episode.show } : {}),
      ...(episode?.season !== undefined ? { season: episode.season } : {}),
    });
  }
  return {
    viewings,
    diagnostics: { events: events.length, deleted, invalid, unmatched, ambiguous },
  };
}

/** Prime usually writes `Episode title-Show name - Season 3`; return only evidence present in that composite. */
export function primeEpisodeHint(
  episodeTitle: string,
  rawTitle: string,
): { show?: string; season?: number } {
  const rest = rawTitle
    .slice(episodeTitle.length)
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
  if (!rest) return {};
  const season = /^(.*?)(?:\s+-\s+|\s+)(?:season|series|temporada)\s+(\d+)$/i.exec(rest);
  if (!season) return { show: rest };
  return { show: season[1]!.trim(), season: Number(season[2]) };
}

function distinctRawTitles(sessions: readonly PlaybackSession[]): string[] {
  return [...new Set(sessions.map((session) => session.rawTitle))];
}

function primeText(value: string | undefined): string {
  let text = value?.trim() ?? '';
  while (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
    text = text.slice(1, -1).replace(/""/g, '"').trim();
  return text;
}

function number(value: string): number | undefined {
  if (!value || /^not available$/i.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const label = (kind: PrimeFileKind) =>
  kind === 'watchEvents' ? 'Watch Events' : 'Viewing History';
