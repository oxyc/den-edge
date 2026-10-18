import type { DownloadViewItem } from './libraryServiceProtocol';

/** Temporary Library.svelte adapter; delete when its Home row consumes DownloadsView. */
export function headline(status: { state: string | null }, answer?: { progress?: number }): string {
  if (status.state === 'ready') return 'Ready to play';
  if (status.state === 'fetching')
    return `Downloading${answer?.progress === undefined ? '' : ` ${Math.floor(answer.progress * 100)}%`}`;
  if (status.state === 'paused') return 'Download paused';
  if (status.state === 'starting' || status.state === 'not_started') return 'Queued';
  if (status.state === 'unreachable') return 'Service unavailable';
  return 'Download unavailable';
}

export function viewHeadline(download: DownloadViewItem): string {
  const { status } = download;
  if (status.state === 'ready') return 'Ready to play';
  if (status.fetch?.state === 'failed') return 'Download failed';
  if (status.fetch?.state === 'stalled' || status.stalled) return 'Download stalled';
  if (status.state === 'fetching')
    return `Downloading${status.fraction === undefined ? '' : ` ${Math.floor(status.fraction * 100)}%`}`;
  if (status.state === 'paused') return 'Download paused';
  if (status.state === 'not-started' || status.state === 'starting') return 'Queued';
  if (status.state === 'refused') return 'Download refused';
  if (status.state === 'unreachable') return 'Service unavailable';
  if (status.state === 'release-gone') return 'Release unavailable';
  if (status.state === 'awaiting-air') return 'Waiting for it to air';
  return download.release ? 'No working release yet' : 'Searching for a release';
}

/** "14:05", or "Mon 14:05" beyond today: when a wait ends. */
function clockTime(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  return `${new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function viewTrouble(download: DownloadViewItem): boolean {
  return download.status.phase === 'trouble';
}

export function viewFacts(download: DownloadViewItem, now = Date.now()): string[] {
  const { status } = download;
  const values: string[] = [];
  const service = status.fetch?.service ?? status.service;
  if (service) values.push(service);
  if (status.bytesPerSecond) values.push(`${(status.bytesPerSecond / 1_000_000).toFixed(1)} MB/s`);
  if (
    status.etaSeconds !== undefined &&
    Number.isFinite(status.etaSeconds) &&
    status.etaSeconds >= 0 &&
    status.etaSeconds <= 7 * 24 * 60 * 60
  )
    values.push(
      status.etaSeconds < 60
        ? `${Math.ceil(status.etaSeconds)} sec left`
        : `${Math.ceil(status.etaSeconds / 60)} min left`,
    );
  if (status.fetch?.seeds !== undefined) values.push(`${status.fetch.seeds} seeds`);
  if (status.fetch?.peers !== undefined) values.push(`${status.fetch.peers} peers`);
  if (status.stalled && status.progressAt)
    values.push(
      `No progress for ${Math.max(1, Math.floor((now - status.progressAt) / 60_000))} min`,
    );
  if (status.state === 'paused' && status.until && status.until > now)
    values.push(`Retries in ${Math.max(1, Math.ceil((status.until - now) / 60_000))} min`);
  if (status.state === 'awaiting-air' && status.until)
    values.push(`Airs ${clockTime(status.until, now)}`);
  if (status.state === 'no-working-release' && status.until)
    values.push(
      status.until > now ? `Searching again ${clockTime(status.until, now)}` : 'Searching now',
    );
  if (download.candidates && download.tried > 1)
    values.push(`Tried ${Math.min(download.tried, download.candidates)} of ${download.candidates}`);
  return values;
}
