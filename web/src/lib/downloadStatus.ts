import { i18n } from './i18n.svelte';
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

/** The headline in the interface language: static states are catalog phrases, the percentage a parameter message. */
export function viewHeadline(download: DownloadViewItem): string {
  const { status } = download;
  if (status.state === 'ready') return i18n.phrase('Ready to play');
  if (status.fetch?.state === 'failed') return i18n.phrase('Download failed');
  if (status.fetch?.state === 'stalled' || status.stalled) return i18n.phrase('Download stalled');
  if (status.state === 'fetching')
    return status.fraction === undefined
      ? i18n.phrase('Downloading')
      : i18n.format('download.progress', 'Downloading {percent}%', {
          percent: Math.floor(status.fraction * 100),
        });
  if (status.state === 'paused') return i18n.phrase('Download paused');
  if (status.state === 'not-started' || status.state === 'starting') return i18n.phrase('Queued');
  if (status.state === 'refused') return i18n.phrase('Download refused');
  if (status.state === 'unreachable') return i18n.phrase('Service unavailable');
  if (status.state === 'release-gone') return i18n.phrase('Release unavailable');
  if (status.state === 'awaiting-air') return i18n.phrase('Waiting for it to air');
  return download.release
    ? i18n.phrase('No working release yet')
    : i18n.phrase('Searching for a release');
}

/** "14:05", or "Mon 14:05" beyond today: when a wait ends, on the interface language's own clock. */
function clockTime(at: number, now: number): string {
  const locale = i18n.language === 'en' ? undefined : i18n.language;
  const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  return `${new Date(at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function viewTrouble(download: DownloadViewItem): boolean {
  return download.status.phase === 'trouble';
}

export function viewFacts(download: DownloadViewItem, now = Date.now()): string[] {
  const { status } = download;
  const values: string[] = [];
  const service = status.fetch?.service ?? status.service;
  if (service) values.push(service);
  if (status.bytesPerSecond) {
    const rate = status.bytesPerSecond / 1_000_000;
    const figure =
      i18n.language === 'en'
        ? rate.toFixed(1)
        : rate.toLocaleString(i18n.language, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          });
    values.push(`${figure} MB/s`);
  }
  if (
    status.etaSeconds !== undefined &&
    Number.isFinite(status.etaSeconds) &&
    status.etaSeconds >= 0 &&
    status.etaSeconds <= 7 * 24 * 60 * 60
  )
    values.push(
      status.etaSeconds < 60
        ? i18n.format('download.secLeft', '{count} sec left', {
            count: Math.ceil(status.etaSeconds),
          })
        : i18n.format('download.minLeft', '{count} min left', {
            count: Math.ceil(status.etaSeconds / 60),
          }),
    );
  if (status.fetch?.seeds !== undefined)
    values.push(
      status.fetch.seeds === 1
        ? i18n.format('download.seeds.one', '1 seed', { count: 1 })
        : i18n.format('download.seeds.other', '{count} seeds', { count: status.fetch.seeds }),
    );
  if (status.fetch?.peers !== undefined)
    values.push(
      status.fetch.peers === 1
        ? i18n.format('download.peers.one', '1 peer', { count: 1 })
        : i18n.format('download.peers.other', '{count} peers', { count: status.fetch.peers }),
    );
  if (status.stalled && status.progressAt)
    values.push(
      i18n.format('download.noProgress', 'No progress for {count} min', {
        count: Math.max(1, Math.floor((now - status.progressAt) / 60_000)),
      }),
    );
  if (status.state === 'paused' && status.until && status.until > now)
    values.push(
      i18n.format('download.retriesIn', 'Retries in {count} min', {
        count: Math.max(1, Math.ceil((status.until - now) / 60_000)),
      }),
    );
  if (status.state === 'awaiting-air' && status.until)
    values.push(
      i18n.format('download.airs', 'Airs {time}', { time: clockTime(status.until, now) }),
    );
  if (status.state === 'no-working-release' && status.until)
    values.push(
      status.until > now
        ? i18n.format('download.searchingAgain', 'Searching again {time}', {
            time: clockTime(status.until, now),
          })
        : i18n.phrase('Searching now'),
    );
  if (download.candidates && download.tried > 1)
    values.push(
      i18n.format('download.tried', 'Tried {count} of {total}', {
        count: Math.min(download.tried, download.candidates),
        total: download.candidates,
      }),
    );
  return values;
}
