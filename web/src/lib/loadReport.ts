// One page load's timing, sent once to den-edge (`POST /playback/load`, `diagnostics.rs`) and logged there as one
// line, so a page that is slow on one device can be read from the box's log rather than reproduced. Milestones
// (`startupTiming.ts`) in milliseconds since navigation start, the kind of page, and the kind of device and engine:
// never a title, an id, a URL or anything a person typed.

import { currentRelease, reportUrl } from './diagnosticsReport';
import { parseRoute } from './route';
import {
  startupCounts,
  startupLongTasks,
  startupMilestone,
  startupMilestoneLast,
  startupWorkerResources,
  startupWorkers,
} from './startupTiming';

/**
 * The latest a load reports: long enough for an old TV's first library read and first rows. A load reports as soon
 * as its content is drawn, and a page hidden or left before either reports what it reached.
 */
export const REPORT_AFTER_MS = 180_000;
const CHECK_MS = 1_000;

export type LoadRoute = 'home' | 'movies' | 'series' | 'watchlist' | 'title' | 'settings' | 'other';
export type DeviceClass = 'phone' | 'tablet' | 'desktop' | 'tv';
export type BrowserEngine = 'webkit' | 'blink' | 'gecko' | 'other';

/**
 * The milestones a report carries, by the `startupMark` event that sets each, in the order a load reaches them. A
 * `worker …` event is the first library Worker's, relayed to the page (`startupTiming.ts`).
 */
export const MILESTONES = {
  pageBootMs: 'page boot',
  appModuleMs: 'app module requested',
  appEvaluatedMs: 'app module evaluated',
  appMountedMs: 'app mounted',
  workerStartedMs: 'library worker started',
  workerScriptMs: 'worker script evaluated',
  /** A session took a library Worker (`startupWorkerCreated`): one started at page boot, or a new one. */
  sessionWorkerMs: 'worker created',
  coreCompileStartMs: 'den-core compile started',
  coreCompiledMs: 'den-core compiled',
  workerCoreRequestedMs: 'worker den-core requested',
  workerCoreReadyMs: 'worker den-core ready',
  workerReadyMs: 'worker ready',
  capabilityMs: 'capability answered',
  bootstrapMs: 'supervisor household bootstrap',
  workerLogRequestedMs: 'worker log open requested',
  workerLogOpenedMs: 'worker log opened',
  directoryMs: 'profile directory lease value',
  handoverMs: 'handover',
  billboardDetailMs: 'billboard detail',
  shelvesMs: 'shelves ready',
  posterMs: 'first poster',
  episodesMs: 'episodes shown',
  importStartMs: 'library import started',
  importMs: 'library import finished',
} as const;

/**
 * The same steps as the last library Worker reached them: a household with profiles opens two, the handover waits
 * for both, and the first one's times hid the second's. `worker ready` is the page's, once per Worker.
 */
export const LAST_MILESTONES = {
  workerScriptLastMs: 'worker script evaluated',
  workerCoreReadyLastMs: 'worker den-core ready',
  workerReadyLastMs: 'worker ready',
  workerLogOpenedLastMs: 'worker log opened',
} as const;

/**
 * What the TMDB cache (`tmdbCache.ts`) did for this load, by outcome: answered from what it kept (fresh, or stale and
 * refreshed behind), asked while the caller waited (nothing kept, or kept too long ago), or failed to read or keep.
 */
export const TMDB_CACHE = {
  fresh: 'tmdb fresh',
  stale: 'tmdb stale',
  brief_fresh: 'tmdb brief fresh',
  brief_stale: 'tmdb brief stale',
  missing: 'tmdb missing',
  too_old: 'tmdb too old',
  read_failed: 'tmdb read failed',
  write_failed: 'tmdb write failed',
  no_store: 'tmdb no store',
} as const;
export type TmdbCacheOutcome = keyof typeof TMDB_CACHE;

/**
 * Requests by what they are for, each as `[count, milliseconds summed]`, so a slow load says whether it waited on
 * the network and on what: the page's own (`net`), and its Workers' (`workerNet`), which make the library's and most
 * metadata requests.
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
  -readonly [K in keyof typeof MILESTONES | keyof typeof LAST_MILESTONES]?: number;
} & {
  tmdbCache?: Partial<Record<TmdbCacheOutcome, number>>;
  workers: number;
  hidden?: true;
  entry?: LoadEntry;
  release?: string;
  net?: NetTally;
  workerNet?: NetTally;
  /** The page's main thread blocked 50 ms or more at a time: `[count, milliseconds in all, longest]`. */
  longTasks?: [number, number, number];
};

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
  for (const [field, event] of Object.entries(LAST_MILESTONES) as [
    keyof typeof LAST_MILESTONES,
    string,
  ][]) {
    const at = startupMilestoneLast(event);
    if (at !== undefined) report[field] = at;
  }
  const counted = startupCounts();
  const tmdbCache: Partial<Record<TmdbCacheOutcome, number>> = {};
  for (const [outcome, name] of Object.entries(TMDB_CACHE) as [TmdbCacheOutcome, string][]) {
    const count = counted.get(name);
    if (count) tmdbCache[outcome] = count;
  }
  if (Object.keys(tmdbCache).length) report.tmdbCache = tmdbCache;
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
  const workerNet = netTally(startupWorkerResources());
  if (Object.keys(workerNet).length) report.workerNet = workerNet;
  const longTasks = startupLongTasks();
  if (longTasks[0]) report.longTasks = longTasks;
  return report;
}

/**
 * The load's content is drawn, and a first library read it started has finished. Home's content is its shelves too:
 * its first poster can draw seconds before them, and a report sent then said nothing of the wait for them. A Home
 * without a library never readies shelves, and reports when hidden or after `REPORT_AFTER_MS`.
 */
export function loadSettled(
  milestone: (event: string) => number | undefined,
  route?: LoadRoute,
): boolean {
  const drawn =
    milestone(MILESTONES.posterMs) !== undefined || milestone(MILESTONES.episodesMs) !== undefined;
  const shelved = route !== 'home' || milestone(MILESTONES.shelvesMs) !== undefined;
  const importing =
    milestone(MILESTONES.importStartMs) !== undefined &&
    milestone(MILESTONES.importMs) === undefined;
  return drawn && shelved && !importing;
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
    if (loadSettled(startupMilestone, route) || performance.now() - started >= REPORT_AFTER_MS)
      send();
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
