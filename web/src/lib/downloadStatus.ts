// How a download is described, wherever it is shown (the TV's `DownloadQueue+Detail` and `TitleDownloadsNote`): one
// set of sentences for the Downloads page, Home's row, a title's sources and its note, so they can't drift apart.

import { coordinate, type Download } from './downloadRows';
import { inFlight, type DownloadState } from './downloadQueue.svelte';
import type { Preparation } from './titleSources';

const SERVICES: Record<string, string> = {
  torbox: 'TorBox',
  realdebrid: 'Real-Debrid',
  premiumize: 'Premiumize',
};
const serviceName = (id?: string) => (id ? (SERVICES[id] ?? id) : undefined);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** An ETA a debrid reports for a torrent going nowhere (TorBox answers 8,640,000 s) is no estimate. */
export function plausibleEta(seconds?: number): number | undefined {
  return seconds !== undefined && seconds > 0 && seconds <= 2 * 86_400 ? seconds : undefined;
}

export function rateText(bytesPerSecond: number): string {
  const mbps = (bytesPerSecond * 8) / 1_000_000;
  return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

export function sizeText(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function etaText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `About ${hours} hr ${minutes % 60} min left`;
}

const percent = (progress?: number) =>
  progress !== undefined && progress > 0
    ? `${Math.floor(Math.min(progress, 1) * 100)}%`
    : undefined;

/** The state alone, short: what a card or a source row says beside its other figures. */
export function stateLabel(status: DownloadState): string {
  switch (status.state) {
    case 'fetching':
      return 'Downloading';
    case 'not_started':
      return 'Not started yet';
    case 'refused':
      return `${serviceName(status.service) ?? 'The debrid'} refused it`;
    case 'paused':
      return status.until ? `Paused until ${clock(status.until)}` : 'Paused';
    case 'unreachable':
      return 'Can’t reach the addon';
    case 'release_gone':
      return 'Release no longer listed';
    case 'no_working_release':
      return 'No working release found';
    case 'ready':
      return 'Ready to play';
    default:
      return 'Starting…';
  }
}

/**
 * "Downloading 12% · 4.0 Mbps · About 5 min left", "Queued at TorBox", "Waiting for peers (0 seeds)", "Failed at
 * TorBox" — or the state's own label when the debrid isn't fetching it.
 */
export function headline(status: DownloadState, answer?: Preparation): string {
  if (status.state !== 'fetching' || answer?.state !== 'preparing') return stateLabel(status);
  const fetch = answer.fetch;
  const service = serviceName(fetch?.service) ?? 'the debrid';
  switch (fetch?.state) {
    case 'queued':
      return `Queued at ${service}`;
    case 'fetching':
      return `Finding the torrent at ${service}`;
    case 'stalled':
      return fetch.seeds === undefined
        ? 'Waiting for peers'
        : `Waiting for peers (${plural(fetch.seeds, 'seed')})`;
    case 'failed':
      return `Failed at ${service}`;
    default: {
      const parts = [
        `Downloading${percent(answer.progress) ? ` ${percent(answer.progress)}` : ''}`,
      ];
      if (answer.bytesPerSecond && answer.bytesPerSecond > 0)
        parts.push(rateText(answer.bytesPerSecond));
      const eta = plausibleEta(answer.etaSeconds);
      if (eta !== undefined) parts.push(etaText(eta));
      return parts.join(' · ');
    }
  }
}

/** "No progress for 14 min", while the debrid is meant to be fetching and nothing has moved for a minute or more. */
function noProgress(status: DownloadState, answer: Preparation | undefined, now: number) {
  if (status.state !== 'fetching' || answer?.fetch?.state === 'failed') return undefined;
  const fetch = answer?.fetch;
  const empty =
    (fetch?.seeds !== undefined || fetch?.peers !== undefined) &&
    !(fetch?.seeds ?? 0) &&
    !(fetch?.peers ?? 0);
  const deadSwarm = fetch?.state === 'stalled' && empty;
  if (!deadSwarm && (answer?.bytesPerSecond ?? 0) !== 0) return undefined;
  const minutes = Math.floor((now - status.clock.progressAt) / 60_000);
  if (minutes < 1) return undefined;
  return `No progress for ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`}`;
}

/** "Release 2 of 9 tried", or "Tried 2 releases" without a count. */
function triedText(download: Download, status: DownloadState): string | undefined {
  const tried = new Set([...download.tried, download.release.identity]).size;
  if (download.candidates && download.candidates > 0)
    return `Release ${tried} of ${Math.max(download.candidates, tried)} tried`;
  const earlier = download.tried.length;
  return earlier > 0 && inFlight(status.state) ? `Tried ${plural(earlier, 'release')}` : undefined;
}

/** "2 peers · 1.4 GB of 6.3 GB · No progress for 14 min · Release 2 of 9 tried", each only with a figure behind it. */
export function facts(
  download: Download,
  status: DownloadState,
  answer: Preparation | undefined,
  now = Date.now(),
): string[] {
  const parts: string[] = [];
  const fetch = answer?.state === 'preparing' ? answer.fetch : undefined;
  if (status.state === 'fetching' && fetch) {
    if (fetch.seeds !== undefined && fetch.state !== 'stalled')
      parts.push(plural(fetch.seeds, 'seed'));
    if (fetch.peers !== undefined) parts.push(plural(fetch.peers, 'peer'));
  }
  const progress = answer?.state === 'preparing' ? answer.progress : undefined;
  const bytes = download.release.sizeBytes;
  if (bytes && bytes > 0) {
    parts.push(
      progress && progress > 0
        ? `${sizeText(Math.floor(bytes * Math.min(progress, 1)))} of ${sizeText(bytes)}`
        : sizeText(bytes),
    );
  }
  const still = noProgress(status, answer, now);
  if (still) parts.push(still);
  const tried = triedText(download, status);
  if (tried) parts.push(tried);
  return parts;
}

/** "4K • REMUX • Atmos • 55 GB · Not cached": which release, and whether the debrid already held it. */
export function releaseLine(download: Download): string | undefined {
  const cached =
    download.release.cached === undefined
      ? undefined
      : download.release.cached
        ? 'Cached'
        : 'Not cached';
  const parts = [download.release.label, cached].filter((s): s is string => !!s);
  return parts.length ? parts.join(' · ') : undefined;
}

export type DownloadPhase = 'queued' | 'downloading' | 'trouble' | 'ready';

/**
 * The four states a download card's own badge draws an icon for — queued or pending, downloading, stalled or
 * failed, and downloaded or ready — never the library's watched checkmark, which says nothing about a download
 * (`PosterCard`'s `standing` is a different, unrelated badge).
 */
export function phase(status: DownloadState, answer?: Preparation): DownloadPhase {
  if (isTrouble(status, answer)) return 'trouble';
  if (status.state === 'ready') return 'ready';
  if (status.state === 'fetching') return 'downloading';
  return 'queued';
}

/** Whether this reads as trouble rather than a wait: what turns the line orange. */
export function isTrouble(status: DownloadState, answer?: Preparation): boolean {
  switch (status.state) {
    case 'refused':
    case 'unreachable':
    case 'release_gone':
    case 'no_working_release':
      return true;
    case 'fetching':
      return answer?.fetch?.state === 'failed' || answer?.fetch?.state === 'stalled';
    default:
      return false;
  }
}

/**
 * Home's Downloading/Downloads row (den-spec library-v4 §17): in flight first, then ready-and-unwatched. A
 * ready row has no lifetime of its own until its own title is watched (den-core `download_prune` keeps it,
 * then two more days once it is), so a `ready` download still live in `items` already means not yet watched
 * — nothing here re-checks that. Refused, not-started, unreachable, gone or no-working-release downloads stay
 * off Home; they're still on /downloads.
 */
export function homeRow(items: { download: Download; status: DownloadState }[]): {
  heading: string;
  downloads: Download[];
} {
  const active = items
    .filter(({ status }) => inFlight(status.state))
    .map(({ download }) => download);
  const ready = items
    .filter(({ status }) => status.state === 'ready')
    .map(({ download }) => download);
  return { heading: active.length ? 'Downloading' : 'Downloads', downloads: [...active, ...ready] };
}

/** "Queued from Chrome on iPhone", for a download another device queued; nothing for this browser's own. */
export function queuedFrom(
  download: Download,
  device: string | undefined,
  names: (device: string) => string | undefined,
) {
  if (!device || download.queuedBy === device) return undefined;
  return `Queued from ${names(download.queuedBy) ?? 'another device'}`;
}

/**
 * The title page's line (the TV's `TitleDownloadsNote.summary`): what this title has downloading. Counts, not a list,
 * and trouble never folded into the total.
 */
export function titleSummary(items: { download: Download; status: DownloadState }[]): string {
  let moving = 0,
    ready = 0,
    stuck = 0,
    gone = 0;
  for (const { status } of items) {
    if (inFlight(status.state)) moving++;
    else if (status.state === 'ready') ready++;
    else if (status.state === 'release_gone') gone++;
    else if (status.state !== 'no_working_release') stuck++;
  }
  const clauses: string[] = [];
  if (moving) clauses.push(`Downloading ${moving} — you can close Den, it keeps going.`);
  if (ready) clauses.push(`${ready} ready to play.`);
  if (stuck) clauses.push(`${stuck} couldn’t be started.`);
  if (gone) clauses.push(`${gone} no longer listed.`);
  const switched = items.filter(
    ({ download, status }) => download.tried.length > 0 && inFlight(status.state),
  );
  if (switched.length === 1) {
    const { download } = switched[0]!;
    const where = coordinate(download.title);
    const note = `Tried ${plural(download.tried.length, 'release')}, now downloading ${download.release.label}`;
    clauses.push(`${where ? `${where}: ` : ''}${note}.`);
  } else if (switched.length > 1)
    clauses.push(`${switched.length} moved to another release after stalling.`);
  const exhausted = items.filter(({ status }) => status.state === 'no_working_release');
  if (exhausted.length === 1) {
    const where = coordinate(exhausted[0]!.download.title);
    clauses.push(`No working release found${where ? ` for ${where}` : ''}.`);
  } else if (exhausted.length > 1)
    clauses.push(`No working release found for ${exhausted.length} episodes.`);
  return clauses.join(' ');
}
