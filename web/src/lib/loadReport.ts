// One page load's timing, sent once to den-edge (`POST /playback/load`, `diagnostics.rs`) and logged there as one
// line, so a page that is slow on one device can be read from the box's log rather than reproduced. Milestones
// (`startupTiming.ts`) in milliseconds since navigation start, the kind of page, and the kind of device and engine:
// never a title, an id, a URL or anything a person typed.

import { currentRelease, reportUrl } from './diagnosticsReport';
import { parseRoute } from './route';
import { startupMilestone, startupWorkers } from './startupTiming';

/**
 * The latest a load reports: long enough for an old TV's first library read and first rows. A load reports as soon
 * as its content is drawn, and a page hidden or left before either reports what it reached.
 */
export const REPORT_AFTER_MS = 180_000;
const CHECK_MS = 1_000;

export type LoadRoute = 'home' | 'movies' | 'series' | 'watchlist' | 'title' | 'settings' | 'other';
export type DeviceClass = 'phone' | 'tablet' | 'desktop' | 'tv';
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
  importStartMs: 'library import started',
  importMs: 'library import finished',
} as const;

/**
 * The page's own requests by what they are for, each as `[count, milliseconds summed]`, so a slow load says
 * whether it waited on the network and on what. The library Worker's requests are its own and not counted: the
 * import milestones cover them.
 */
export type NetKind = 'lib' | 'tmdb' | 'meta' | 'atlas' | 'image' | 'other';
export type NetTally = Partial<Record<NetKind, [number, number]>>;

export function netKindOf(name: string, initiator: string): NetKind {
  if (initiator === 'img' || initiator === 'image') return 'image';
  let path: string;
  try {
    path = new URL(name).pathname;
  } catch {
    return 'other';
  }
  if (path.startsWith('/lib/')) return 'lib';
  if (path.startsWith('/tmdb/')) return 'tmdb';
  if (/^\/(?:metadata|ratings|warnings|skipdb)\//.test(path)) return 'meta';
  if (path.startsWith('/atlas/')) return 'atlas';
  return 'other';
}

export function netTally(
  entries: readonly { name: string; initiatorType: string; duration: number }[],
) {
  const tally: NetTally = {};
  for (const entry of entries) {
    if (!['fetch', 'xmlhttprequest', 'img', 'image'].includes(entry.initiatorType)) continue;
    const kind = netKindOf(entry.name, entry.initiatorType);
    const [count, ms] = tally[kind] ?? [0, 0];
    tally[kind] = [count + 1, ms + Math.round(entry.duration)];
  }
  return tally;
}

/** How the page was entered; `swap` is Den's own load onto a newer release (`release.ts`, under `den-retry`). */
export type LoadEntry = 'navigate' | 'reload' | 'back_forward' | 'swap';

export type LoadReport = { route: LoadRoute; device: DeviceClass; engine: BrowserEngine } & {
  -readonly [K in keyof typeof MILESTONES]?: number;
} & { workers: number; hidden?: true; entry?: LoadEntry; release?: string; net?: NetTally };

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

/**
 * Every browser on iOS and iPadOS is WebKit, whatever it calls itself. A TV says so in its user agent (an LG's
 * Web0S, a Samsung's Tizen, Den's Android TV shell); without that an LG's Chromium reads as a desktop.
 */
export function deviceOf(
  userAgent: string,
  touchPoints = 0,
): { device: DeviceClass; engine: BrowserEngine } {
  const apple =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
  const device = /Web0S|webOS|Tizen|SMART-TV|SmartTV|DenAndroidTV\//.test(userAgent)
    ? 'tv'
    : /iPhone|iPod|Android.+Mobile|Mobile.+Firefox/.test(userAgent)
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
  const net = netTally(
    (performance.getEntriesByType?.('resource') ?? []) as PerformanceResourceTiming[],
  );
  if (Object.keys(net).length) report.net = net;
  return report;
}

/** The load's content is drawn, and a first library read it started has finished. */
export function loadSettled(milestone: (event: string) => number | undefined): boolean {
  const drawn =
    milestone(MILESTONES.posterMs) !== undefined || milestone(MILESTONES.episodesMs) !== undefined;
  const importing =
    milestone(MILESTONES.importStartMs) !== undefined &&
    milestone(MILESTONES.importMs) === undefined;
  return drawn && !importing;
}

/**
 * Report this load once: when it has settled, after `REPORT_AFTER_MS`, or as the page is hidden or left, whichever
 * comes first.
 */
export function watchLoadReport(): void {
  const route = loadRouteOf(location.pathname + location.search);
  const hidden = document.visibilityState !== 'visible';
  // The default buffer of 250 entries fills before a slow Home has drawn its rows.
  performance.setResourceTimingBufferSize?.(2000);
  const started = performance.now();
  let sent = false;
  const check = setInterval(() => {
    if (loadSettled(startupMilestone) || performance.now() - started >= REPORT_AFTER_MS) send();
  }, CHECK_MS);
  const send = () => {
    if (sent) return;
    sent = true;
    clearInterval(check);
    const body = JSON.stringify(buildLoadReport(route, hidden));
    const url = reportUrl('/playback/load');
    if (navigator.sendBeacon?.(url, body)) return;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  };
  addEventListener('pagehide', send);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
}
