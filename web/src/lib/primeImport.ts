// Prime's privacy export describes one history in two files. Watch Events has the canonical viewing date and
// cumulative watch time; Viewing History has repeated playback sessions and the movie/episode identity Prime omitted
// from Watch Events. This module reads and joins those files without retaining their device or location telemetry.

import { csvRecords } from './viewingImportCsv';
import { isViewingPreview, normalizeViewingName } from './viewingImport';

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
  keys: string[];
  matchWords: string[];
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
    // Older exports used this value when Amazon no longer retained the otherwise valid content label.
    if (material !== 'Feature' && material !== 'Full' && material !== 'Not available') return [];
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
    const keys = primeTitleKeys(rawTitle);
    return [
      {
        rawTitle,
        keys,
        matchWords: keys.at(-1)!.split(' '),
        at,
        viewedSeconds,
        ...(durations.length ? { durationSeconds: Math.max(...durations) } : {}),
      },
    ];
  });

  const byFirstWord = new Map<string, PlaybackSession[]>();
  for (const session of sessions)
    for (const first of new Set(session.keys.map((key) => key.split(' ')[0] ?? ''))) {
      const bucket = byFirstWord.get(first) ?? [];
      bucket.push(session);
      byFirstWord.set(first, bucket);
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
    if (isViewingPreview(event.title)) continue;
    const wanted = primeTitleKeys(event.title);
    const wantedWords = wanted.at(-1)!.split(' ');
    const likely = new Set(
      wanted.flatMap((name) => byFirstWord.get(name.split(' ')[0] ?? '') ?? []),
    );
    for (const session of sessions)
      if (
        Math.abs(session.at - event.at) <= CLOSE_MS &&
        primeTitleWordsNear(wantedWords, session.matchWords)
      )
        likely.add(session);
    const candidates = [...likely].filter((session) => {
      const raw = session.keys;
      return (
        wanted.some((name) =>
          raw.some((candidate) => candidate === name || candidate.startsWith(`${name} `)),
        ) || primeTitleWordsNear(wantedWords, session.matchWords)
      );
    });
    const nearby = candidates.filter((session) => Math.abs(session.at - event.at) <= CLOSE_MS);
    const identity =
      resolveIdentity(event, nearby) ??
      resolveExactIdentity(event, candidates) ??
      resolveTranslatedMovie(event, sessions);
    if (!identity) {
      const identities = distinctIdentities(nearby);
      if (identities.length) ambiguous.push(event.title);
      else unmatched.push(event.title);
      continue;
    }
    const { rawTitle } = identity;
    const identityKey = normalizeViewingName(rawTitle);
    const sameTitle = sessions.filter((session) => session.keys[0] === identityKey);
    const durations = sameTitle.flatMap((session) =>
      session.durationSeconds === undefined ? [] : [session.durationSeconds],
    );
    // Amazon has used both `Feature` and `Full` for series episodes (and `Full` for films) across export
    // generations. The composite title is the stable type signal: episode title followed by series and season.
    const episode = primeEpisodeHint(event.title, rawTitle);
    viewings.push({
      kind: episode.show ? 'episode' : 'movie',
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
  const eventKeys = new Set(primeTitleKeys(episodeTitle));
  const direct = rawTitle.toLocaleLowerCase().startsWith(episodeTitle.toLocaleLowerCase())
    ? episodeTitle.length
    : undefined;
  const alias = [...rawTitle.matchAll(/[-–—]/g)]
    .map((match) => match.index)
    .filter(
      (index) =>
        primeTitleKeys(rawTitle.slice(0, index)).some((key) => eventKeys.has(key)) ||
        primeTitleNearPrefix(episodeTitle, rawTitle.slice(0, index)),
    )
    .at(0);
  const prefix = direct ?? alias;
  if (prefix === undefined) return {};
  const rest = rawTitle
    .slice(prefix)
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
  if (!rest) return {};
  const clean = rest.replace(/\s*\((?:4k|uhd|hd)[^)]*\)\s*$/i, '').trim();
  const loneSeason = /^(?:season|series|temporada)\s*#?\s*(\d+)$/i.exec(clean);
  if (loneSeason) return { show: clean, season: Number(loneSeason[1]) };
  const wordSeason =
    /^(.*?)\s*:?\s+the complete (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) season$/i.exec(
      clean,
    );
  if (wordSeason)
    return {
      show: cleanPrimeShow(wordSeason[1]!),
      season:
        [
          'first',
          'second',
          'third',
          'fourth',
          'fifth',
          'sixth',
          'seventh',
          'eighth',
          'ninth',
          'tenth',
        ].indexOf(wordSeason[2]!.toLowerCase()) + 1,
    };
  const season = /^(.*?)(?:\s+-\s+|,?\s+)(?:(?:season|series|temporada)\s*#?\s*|s)(\d+)$/i.exec(
    clean,
  );
  if (!season) return { show: cleanPrimeShow(clean) };
  return { show: cleanPrimeShow(season[1]!), season: Number(season[2]) };
}

function cleanPrimeShow(show: string): string {
  return show
    .replace(/\s+s\d+\s*$/i, '')
    .replace(/[\s:–—-]+$/, '')
    .trim();
}

function distinctIdentities(sessions: readonly PlaybackSession[]): { rawTitle: string }[] {
  const found = new Map<string, { rawTitle: string }>();
  for (const { rawTitle, keys } of sessions)
    if (!found.has(keys[0]!)) found.set(keys[0]!, { rawTitle });
  return [...found.values()];
}

function primeTitleKeys(title: string): string[] {
  const originals = [
    title,
    title.replace(/\s+\([^)]*\)\s*$/, ''),
    title.replace(/\s+part\s+\d+\s*$/i, ''),
  ];
  const normalized = originals.map(normalizeViewingName);
  const withoutCode = normalized.map((name) => name.replace(/^ep \d+ /, ''));
  const withoutArticles = [...normalized, ...withoutCode].map((name) =>
    name.replace(/^(?:a|an|the|el|la|los|las|un|una) /, ''),
  );
  const withoutConjunctions = [...withoutCode, ...withoutArticles].map((name) =>
    name
      .split(' ')
      .filter((word) => word !== 'and' && word !== 'y' && word !== 'e')
      .join(' '),
  );
  return [
    ...new Set(
      [...normalized, ...withoutCode, ...withoutArticles, ...withoutConjunctions].filter(Boolean),
    ),
  ];
}

function primeTitleNearPrefix(title: string, rawTitle: string): boolean {
  return primeTitleKeysNear(primeTitleKeys(title), primeTitleKeys(rawTitle));
}

function primeTitleKeysNear(title: readonly string[], rawTitle: readonly string[]): boolean {
  return primeTitleWordsNear(title.at(-1)!.split(' '), rawTitle.at(-1)!.split(' '));
}

function primeTitleWordsNear(words: readonly string[], rawWords: readonly string[]): boolean {
  if (words.length < 3 || rawWords.length < words.length) return false;
  let different = 0;
  for (const [at, word] of words.entries())
    if (word !== rawWords[at] && ++different > 1) return false;
  return true;
}

function resolveExactIdentity(
  event: WatchEvent,
  sessions: readonly PlaybackSession[],
): { rawTitle: string } | undefined {
  const wanted = normalizeViewingName(event.title);
  const exact = distinctIdentities(sessions.filter((session) => session.keys[0] === wanted));
  return exact.length === 1 ? exact[0] : undefined;
}

/** A translated film can have no shared title text. Accept it only when a substantial watch has one very close
 * duration match in the local playback window, and the history identity is not shaped like a series episode. */
function resolveTranslatedMovie(
  event: WatchEvent,
  sessions: readonly PlaybackSession[],
): { rawTitle: string } | undefined {
  if (event.watchedSeconds < 300) return undefined;
  const eligible = sessions.filter(
    (session) =>
      Math.abs(session.at - event.at) <= 14 * 60 * 60 * 1000 &&
      !/[-–—]/.test(session.rawTitle) &&
      !/(?:season|series|temporada)\s*#?\s*\d+|\bs\d+\b/i.test(session.rawTitle),
  );
  const groups = new Map<string, PlaybackSession[]>();
  for (const session of eligible) {
    const key = session.keys[0]!;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  const ranked = [...groups.values()]
    .map((rows) => ({
      rows,
      delta: Math.abs(
        rows.reduce((seconds, row) => seconds + row.viewedSeconds, 0) - event.watchedSeconds,
      ),
    }))
    .sort((left, right) => left.delta - right.delta);
  const [best, second] = ranked;
  if (!best || best.delta > event.watchedSeconds * 0.02) return undefined;
  if (second && best.delta + Math.max(30, event.watchedSeconds * 0.01) >= second.delta)
    return undefined;
  return { rawTitle: best.rows[0]!.rawTitle };
}

/**
 * Prefer an exact raw title over prefix collisions (`After` vs `After We Fell`). For repeated generic episode
 * names, Prime's rounded cumulative watch seconds safely distinguish seasons that occur in the same time window.
 */
function resolveIdentity(
  event: WatchEvent,
  sessions: readonly PlaybackSession[],
): { rawTitle: string } | undefined {
  const groups = new Map<string, PlaybackSession[]>();
  for (const session of sessions) {
    const key = session.keys[0]!;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  if (!groups.size) return undefined;
  const exact = primeTitleKeys(event.title).flatMap((name) => groups.get(name) ?? [])[0];
  if (exact) return { rawTitle: exact.rawTitle };
  if (groups.size === 1) return { rawTitle: groups.values().next().value![0]!.rawTitle };
  if (event.watchedSeconds < 60) return undefined;

  const ranked = [...groups.values()]
    .map((rows) => {
      const sum = rows.reduce((seconds, row) => seconds + row.viewedSeconds, 0);
      const delta = Math.min(
        Math.abs(sum - event.watchedSeconds),
        ...rows.map((row) => Math.abs(row.viewedSeconds - event.watchedSeconds)),
      );
      return { rows, delta };
    })
    .sort((left, right) => left.delta - right.delta);
  const [best, second] = ranked;
  const closeEnough = best!.delta <= Math.max(180, event.watchedSeconds * 0.12);
  const clearLead = best!.delta + Math.max(30, event.watchedSeconds * 0.02) < second!.delta;
  if (closeEnough && clearLead) return { rawTitle: best!.rows[0]!.rawTitle };

  const byTime = ranked
    .map(({ rows, delta }) => ({
      rows,
      delta,
      minutes: Math.min(...rows.map((row) => Math.abs(row.at - event.at))) / 60_000,
    }))
    .sort((left, right) => left.minutes - right.minutes);
  const [nearest, next] = byTime;
  return nearest!.delta <= Math.max(180, event.watchedSeconds * 0.12) &&
    nearest!.minutes <= 12 * 60 &&
    nearest!.minutes + 6 * 60 < next!.minutes
    ? { rawTitle: nearest!.rows[0]!.rawTitle }
    : undefined;
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
