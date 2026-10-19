// One page load's timing, sent once to den-edge (`POST /playback/load`, `diagnostics.rs`) and logged there as one
// line, so a page that is slow on one device can be read from the box's log rather than reproduced. Milestones
// (`startupTiming.ts`) in milliseconds since navigation start, the kind of page, and the kind of device and engine:
// never a title, an id, a URL or anything a person typed.

import { currentRelease } from './diagnosticsReport';
import { parseRoute } from './route';
import { startupMilestone, startupWorkers } from './startupTiming';

/** Long enough for a slow phone's first rows; a page hidden or left before then reports what it reached. */
export const REPORT_AFTER_MS = 30_000;

export type LoadRoute = 'home' | 'movies' | 'series' | 'watchlist' | 'title' | 'settings' | 'other';
export type DeviceClass = 'phone' | 'tablet' | 'desktop';
export type BrowserEngine = 'webkit' | 'blink' | 'gecko' | 'other';

/** The milestones a report carries, by the `startupMark` event that sets each. */
export const MILESTONES = {
  appModuleMs: 'app module requested',
  workerReadyMs: 'worker ready',
  handoverMs: 'handover',
  billboardDetailMs: 'billboard detail',
  shelvesMs: 'shelves ready',
  posterMs: 'first poster',
  episodesMs: 'episodes shown',
} as const;

/** How the page was entered; `swap` is Den's own load onto a newer release (`release.ts`, under `den-retry`). */
export type LoadEntry = 'navigate' | 'reload' | 'back_forward' | 'swap';

export type LoadReport = { route: LoadRoute; device: DeviceClass; engine: BrowserEngine } & {
  -readonly [K in keyof typeof MILESTONES]?: number;
} & { workers: number; hidden?: true; entry?: LoadEntry; release?: string };

/**
 * Read from the navigation timing entry, whose `name` is the address as it was loaded: index.html's inline script
 * has already taken `den-retry` out of `location` by the time this runs.
 */
export function entryOf(navigation?: { type: string; name: string }): LoadEntry | undefined {
  if (!navigation) return undefined;
  try {
    if (new URL(navigation.name).searchParams.has('den-retry')) return 'swap';
  } catch {
    // Not an address: the type alone still says how the page was entered.
  }
  const { type } = navigation;
  return type === 'navigate' || type === 'reload' || type === 'back_forward' ? type : undefined;
}

export function loadRouteOf(path: string): LoadRoute {
  try {
    const page = parseRoute(path).page;
    if (page === 'library') return 'home';
    if (page === 'movies' || page === 'series' || page === 'watchlist') return page;
    if (page === 'title' || page === 'settings') return page;
  } catch {
    // An address the router can't read is still a load to report.
  }
  return 'other';
}

/** Every browser on iOS and iPadOS is WebKit, whatever it calls itself. */
export function deviceOf(
  userAgent: string,
  touchPoints = 0,
): { device: DeviceClass; engine: BrowserEngine } {
  const apple =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
  const device = /iPhone|iPod|Android.+Mobile|Mobile.+Firefox/.test(userAgent)
    ? 'phone'
    : /iPad|Android|Tablet/.test(userAgent) || apple
      ? 'tablet'
      : 'desktop';
  const engine =
    apple || (/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent))
      ? 'webkit'
      : /Chrome|Chromium|Edg\//.test(userAgent)
        ? 'blink'
        : /Firefox|Gecko\//.test(userAgent)
          ? 'gecko'
          : 'other';
  return { device, engine };
}

export function buildLoadReport(route: LoadRoute, hidden: boolean): LoadReport {
  const report: LoadReport = {
    route,
    ...deviceOf(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    workers: startupWorkers(),
  };
  for (const [field, event] of Object.entries(MILESTONES) as [keyof typeof MILESTONES, string][]) {
    const at = startupMilestone(event);
    if (at !== undefined) report[field] = at;
  }
  if (hidden) report.hidden = true;
  const entry = entryOf(
    performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined,
  );
  if (entry) report.entry = entry;
  const release = currentRelease();
  if (release) report.release = release;
  return report;
}

/** Report this load once: after `REPORT_AFTER_MS`, or as the page is hidden or left, whichever comes first. */
export function watchLoadReport(): void {
  const route = loadRouteOf(location.pathname + location.search);
  const hidden = document.visibilityState !== 'visible';
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    const body = JSON.stringify(buildLoadReport(route, hidden));
    if (navigator.sendBeacon?.('/playback/load', body)) return;
    void fetch('/playback/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  };
  setTimeout(send, REPORT_AFTER_MS);
  addEventListener('pagehide', send);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
}
