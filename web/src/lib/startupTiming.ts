// Always-on startup breadcrumbs: one `den: startup` console line per milestone, each with the milliseconds since
// navigation start, so a slow start shows where it waited. Milestones only: never a key, token, library id, title
// or row, and nothing per row. Both the page and the library Worker log here.

import type { LibrarySelection } from './libraryServiceProtocol';

const STALL_MS = 15_000;

const inWorker = typeof document === 'undefined';

/**
 * Milliseconds since navigation start. A Worker has a clock of its own, so the page hands it its time origin as the
 * Worker's `name` (`startupWorkerName`); without one the Worker reports its own uptime.
 */
function sinceNavigation(): number {
  if (inWorker) {
    const origin = Number((globalThis as { name?: unknown }).name);
    if (Number.isFinite(origin) && origin > 0)
      return Math.round(performance.timeOrigin + performance.now() - origin);
  }
  return Math.round(performance.now());
}

/** The `name` for a production Worker: this page's time origin, which `sinceNavigation` reads back. */
export const startupWorkerName = (): string => String(performance.timeOrigin);

let last: { event: string; at: number } | undefined;
/**
 * Each milestone's first time on this page, for its one load report (`loadReport.ts`). A Worker keeps its own, and
 * relays each one to the page (`relay`), where it is kept as `worker <event>`.
 */
const firsts = new Map<string, number>();
/**
 * Each milestone's latest time: a page with two library Workers waits for the slower, and `firsts` only ever showed
 * the quicker one.
 */
const lasts = new Map<string, number>();
/** How often each counted thing happened (`startupCount`), the page's and its Workers' together. */
const counts = new Map<string, number>();
let workers = 0;
let stall: ReturnType<typeof setTimeout> | undefined;
let handedOver = false;

/**
 * A finished request, as its resource timing entry has it. The sizes, `workerStart` and `deliveryType` say whether it
 * came from a cache (`fileTally`, `loadReport.ts`); an engine without them leaves them out.
 */
export interface StartupResource {
  name: string;
  initiatorType: string;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  workerStart?: number;
  deliveryType?: string;
}

const resourceOf = (entry: StartupResource): StartupResource => ({
  name: entry.name,
  initiatorType: entry.initiatorType,
  duration: entry.duration,
  transferSize: entry.transferSize,
  encodedBodySize: entry.encodedBodySize,
  decodedBodySize: entry.decodedBodySize,
  workerStart: entry.workerStart,
  deliveryType: entry.deliveryType,
});

/**
 * Workers' milestones and finished requests reach the page on this channel: its load report is sent as the page
 * hides, too late to ask them. Each message carries the page's time origin (a Worker's `name`), so a second tab's
 * Workers are not counted here. An engine without `BroadcastChannel` (Tizen 3) reports the page's side only.
 */
const ORIGIN = inWorker
  ? String((globalThis as { name?: unknown }).name ?? '')
  : String(performance.timeOrigin);
const channel = (() => {
  if (inWorker && !(Number(ORIGIN) > 0)) return undefined;
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel('den-startup') : undefined;
  } catch {
    return undefined;
  }
})();
/**
 * Which library a library Worker serves, by its wire: a profile household's own (wire 5), whose profile directory the
 * handover waits on, or a library's (wire 4): a profile's, or that of a household without profiles.
 */
export type LibraryWorkerRole = 'household' | 'profile';
/** How a Worker opened its library: from the views it saved, from its fact store without them, or as the whole log. */
export type LibraryWorkerViews = 'saved' | 'facts' | 'miss';
/** The kinds of reason a Worker opens its whole library after all (`FinishedLibraryViewAuthority#promote`). */
export type LibraryPromotion =
  | 'cache'
  | 'selection'
  | 'command'
  | 'edit'
  | 'query'
  | 'task'
  | 'observation'
  | 'import'
  | 'continue'
  | 'reconcile'
  | 'content'
  | 'layout';
/** Every selection kind, so a promotion's names one only from this set. */
const SELECTION_KINDS: Record<LibrarySelection['kind'], true> = {
  overview: true,
  watchlist: true,
  recommendations: true,
  continue: true,
  history: true,
  title: true,
  presence: true,
  settings: true,
  devices: true,
  connections: true,
  simkl: true,
  recovery: true,
  runtime: true,
  profiles: true,
  downloads: true,
};
/** What one library Worker's open did, for the load report: each the first this page heard for its role. */
export interface LibraryWorkerStartup {
  views?: LibraryWorkerViews;
  promoted?: LibraryPromotion;
  /** The selection a `selection` promotion was for. */
  selection?: LibrarySelection['kind'];
  coreRequestedMs?: number;
}
const CORE_REQUESTED = 'den-core requested';

type Relayed =
  | { origin: string; kind: 'mark'; event: string; at: number }
  | { origin: string; kind: 'count'; name: string }
  | ({ origin: string; kind: 'resource' } & StartupResource)
  | ({ origin: string; kind: 'library'; role: LibraryWorkerRole } & LibraryWorkerStartup);
const relay = (message: Relayed) => {
  try {
    channel?.postMessage(message);
  } catch {
    // The page's own report still carries the page's side.
  }
};
const workerResources: StartupResource[] = [];
/** Requests a Worker made before its first `resource` entry was relayed, bounded like the page's own buffer. */
const MAX_WORKER_RESOURCES = 2_000;
/** What each library Worker's open did (`LibraryWorkerStartup`), by the role it serves; on the page only. */
const libraryWorkers: Partial<Record<LibraryWorkerRole, LibraryWorkerStartup>> = {};
/** The library this Worker serves, once its library is opened (`startupLibraryWorker`); in a Worker only. */
let libraryRole: LibraryWorkerRole | undefined;

function keepLibraryNote(role: LibraryWorkerRole, note: LibraryWorkerStartup): void {
  const held = (libraryWorkers[role] ??= {});
  for (const [field, value] of Object.entries(note) as [keyof LibraryWorkerStartup, never][])
    if (value !== undefined && held[field] === undefined) held[field] = value;
}

/** Tell the page what this Worker's library open did. */
function noteLibrary(note: LibraryWorkerStartup): void {
  if (inWorker && libraryRole)
    relay({ origin: ORIGIN, kind: 'library', role: libraryRole, ...note });
}
/** The page's main thread blocked for 50 ms or more at a time (`longtask`): how often, how long in all, the longest. */
const longTasks = { count: 0, ms: 0, longest: 0 };
export const STARTUP_LONG_TASK_PHASES = [
  'bootstrap',
  'app_import',
  'app_mount',
  'screen_preload',
  'tv_css',
  'tv_search',
  'viewport_measure',
  'home_shelves',
  'home_metadata',
  'home_hero',
  'other',
] as const;
export type StartupLongTaskPhase = (typeof STARTUP_LONG_TASK_PHASES)[number];
type LongTaskTally = [count: number, milliseconds: number, longest: number];
type LongTaskEntry = { start: number; rounded: number };
const longTaskPhases = new Map<StartupLongTaskPhase, LongTaskTally>();
const longTaskEntries: LongTaskEntry[] = [];
// A 180-second report can contain at most 3,600 non-overlapping 50ms tasks; keep the stage dimension complete.
const MAX_LONG_TASK_ENTRIES = 4_096;
const phaseWindows: Array<{
  phase: Exclude<StartupLongTaskPhase, 'other'>;
  start: number;
  end?: number;
}> = [];

/** Open one fixed, privacy-safe phase and return a close which includes its next paint. */
export function beginStartupRenderPhase(phase: Exclude<StartupLongTaskPhase, 'other'>): () => void {
  if (inWorker || typeof requestAnimationFrame !== 'function') return () => {};
  if (phaseWindows.some((window) => window.phase === phase && window.end === undefined))
    return () => {};
  const window = { phase, start: performance.now(), end: undefined as number | undefined };
  phaseWindows.push(window);
  if (phaseWindows.length > 32) phaseWindows.shift();
  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    // Background pages have no rendering opportunity. Their import evaluation is complete at this point, and
    // waiting for throttled frames would incorrectly make later work look like bootstrap.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      window.end = performance.now();
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.end = performance.now();
      }),
    );
  };
}

/** Attribute a bounded synchronous state transition through its next paint. */
export function startupRenderPhase(phase: Exclude<StartupLongTaskPhase, 'other'>): void {
  beginStartupRenderPhase(phase)();
}

if (channel && !inWorker)
  channel.onmessage = ({ data: message }: MessageEvent<Relayed>) => {
    if (message?.origin !== ORIGIN) return;
    if (message.kind === 'mark') {
      const event = `worker ${message.event}`;
      if (!firsts.has(event)) firsts.set(event, message.at);
      lasts.set(event, Math.max(lasts.get(event) ?? 0, message.at));
    } else if (message.kind === 'count')
      counts.set(message.name, (counts.get(message.name) ?? 0) + 1);
    else if (message.kind === 'library') {
      const { origin: _origin, kind: _kind, role, ...note } = message;
      keepLibraryNote(role, note);
    } else if (workerResources.length < MAX_WORKER_RESOURCES)
      workerResources.push(resourceOf(message));
  };

const observe = (type: string, each: (entry: PerformanceEntry) => void) => {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    const observer = new PerformanceObserver((list) => list.getEntries().forEach(each));
    observer.observe({
      type,
      buffered: true,
    });
    return observer;
  } catch {
    // An engine without this entry type reports without it.
  }
};
let longTaskObserver: PerformanceObserver | undefined;
const noteLongTask = ({ startTime, duration }: PerformanceEntry) => {
  longTasks.count++;
  const rounded = Math.round(duration);
  longTasks.ms += rounded;
  longTasks.longest = Math.max(longTasks.longest, rounded);
  if (longTaskEntries.length < MAX_LONG_TASK_ENTRIES)
    longTaskEntries.push({ start: startTime, rounded });
  const ended = startTime + duration;
  const owner =
    phaseWindows
      // The Long Tasks API cannot split one browser task. A phase opened partway through it must not claim the
      // whole duration (for example, TV capability setup used to claim the entire entry-module evaluation).
      .filter((window) => window.start <= startTime)
      .map((window) => ({
        phase: window.phase,
        start: window.start,
        overlap:
          Math.min(ended, window.end ?? performance.now()) - Math.max(startTime, window.start),
      }))
      .filter(({ overlap }) => overlap > 0)
      // Prefer the phase covering most of the task. A nested, more specific phase wins an exact tie.
      .sort((left, right) => right.overlap - left.overlap || right.start - left.start)[0]?.phase ??
    'other';
  const tally = longTaskPhases.get(owner) ?? [0, 0, 0];
  tally[0]++;
  tally[1] += rounded;
  tally[2] = Math.max(tally[2], rounded);
  longTaskPhases.set(owner, tally);
};

if (typeof PerformanceObserver === 'function') {
  if (channel && inWorker)
    observe('resource', (entry) =>
      relay({
        origin: ORIGIN,
        kind: 'resource',
        ...resourceOf(entry as PerformanceResourceTiming & { deliveryType?: string }),
      }),
    );
  if (!inWorker) longTaskObserver = observe('longtask', noteLongTask);
}

/** Include records queued by the browser but not yet delivered to the observer callback. */
function drainLongTasks(): void {
  longTaskObserver?.takeRecords?.().forEach(noteLongTask);
}

/** The page's Workers' finished requests so far. */
export const startupWorkerResources = (): readonly StartupResource[] => workerResources;

/** Count one `name` for this page's load report, from the page or a Worker. Names only: never a title or a URL. */
export function startupCount(name: string): void {
  if (inWorker) relay({ origin: ORIGIN, kind: 'count', name });
  else counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** How often each counted thing has happened on this page so far. */
export const startupCounts = (): ReadonlyMap<string, number> => counts;

/** When `event` last happened on this page, or in the last of its Workers to reach it. */
export const startupMilestoneLast = (event: string): number | undefined => lasts.get(event);

/** The page's long tasks so far: `[count, milliseconds in all, longest]`. */
export const startupLongTasks = (): [number, number, number] => {
  drainLongTasks();
  return [longTasks.count, longTasks.ms, longTasks.longest];
};

/** Long tasks grouped by the fixed startup phase that caused their task/render flush. */
export const startupLongTaskPhases = (): ReadonlyMap<StartupLongTaskPhase, LongTaskTally> => {
  drainLongTasks();
  return longTaskPhases;
};

export const STARTUP_LONG_TASK_STAGES = [
  'pre_app',
  'app_import',
  'app_mount',
  'before_shelves',
  'shelves_to_billboard',
  'billboard_to_handover',
  'handover_to_poster',
  'after_poster',
] as const;
export type StartupLongTaskStage = (typeof STARTUP_LONG_TASK_STAGES)[number];

/**
 * Every long task in exactly one coarse milestone interval. Unlike render phases, these cover the whole load, so
 * an unattributed `other` task still says where it blocked without carrying a route, title or other personal data.
 */
export function startupLongTaskStages(): ReadonlyMap<StartupLongTaskStage, LongTaskTally> {
  drainLongTasks();
  const boundaries: Array<[number | undefined, StartupLongTaskStage]> = [
    [firsts.get('app module requested'), 'app_import'],
    [firsts.get('app module evaluated'), 'app_mount'],
    [firsts.get('app mounted'), 'before_shelves'],
    [firsts.get('shelves ready'), 'shelves_to_billboard'],
    [firsts.get('billboard detail'), 'billboard_to_handover'],
    [firsts.get('handover'), 'handover_to_poster'],
    [firsts.get('first poster'), 'after_poster'],
  ];
  const stages = new Map<StartupLongTaskStage, LongTaskTally>();
  for (const entry of longTaskEntries) {
    let stage: StartupLongTaskStage = 'pre_app';
    for (const [at, next] of boundaries) {
      if (at !== undefined && entry.start >= at) stage = next;
    }
    const tally = stages.get(stage) ?? [0, 0, 0];
    tally[0]++;
    tally[1] += entry.rounded;
    tally[2] = Math.max(tally[2], entry.rounded);
    stages.set(stage, tally);
  }
  return stages;
}

/** A failure reduced to its code and a bounded message; never the request, url or payload behind it. */
export function startupFailure(error: unknown): string {
  const failure =
    typeof error === 'object' && error !== null && 'failure' in error
      ? (error as { failure?: { code?: unknown; message?: unknown } }).failure
      : undefined;
  const code = typeof failure?.code === 'string' ? `${failure.code}: ` : '';
  const message =
    typeof failure?.message === 'string'
      ? failure.message
      : error instanceof Error
        ? error.message
        : 'unknown error';
  return `${code}${message}`.slice(0, 160);
}

export function startupMark(event: string, detail?: string): void {
  const at = sinceNavigation();
  if (!inWorker) {
    last = { event, at };
    if (!firsts.has(event)) firsts.set(event, at);
    lasts.set(event, at);
  } else if (!firsts.has(event)) {
    firsts.set(event, at);
    relay({ origin: ORIGIN, kind: 'mark', event, at });
    if (event === CORE_REQUESTED) noteLibrary({ coreRequestedMs: at });
  }
  console.info(
    `den: startup${inWorker ? ' [worker]' : ''} +${at}ms ${event}${detail ? ` (${detail})` : ''}`,
  );
}

/** When `event` first happened on this page, in milliseconds since navigation start; undefined if it has not. */
export const startupMilestone = (event: string): number | undefined => firsts.get(event);

/** How many Workers this page has started. */
export const startupWorkers = (): number => workers;

/** Mark `event` only the first time it happens on this page: a milestone, not a stream of them. */
export function startupMarkOnce(event: string, detail?: string): void {
  if (!firsts.has(event)) startupMark(event, detail);
}

/**
 * This Worker opens a library serving `role` and found `views` for it. A den-core it requested before is that
 * library's too: the open is the Worker's first work.
 */
export function startupLibraryWorker(role: LibraryWorkerRole, views: LibraryWorkerViews): void {
  libraryRole = role;
  noteLibrary({ views, coreRequestedMs: firsts.get(CORE_REQUESTED) });
}

/** This Worker's library opened the whole log after all, for `reason` (`FinishedLibraryViewAuthority#promote`). */
export function startupLibraryPromoted(reason: `${LibraryPromotion}:${string}`): void {
  const split = reason.indexOf(':');
  const promoted = reason.slice(0, split) as LibraryPromotion;
  const kind = reason.slice(split + 1);
  noteLibrary({
    promoted,
    ...(promoted === 'selection' && Object.hasOwn(SELECTION_KINDS, kind)
      ? { selection: kind as LibrarySelection['kind'] }
      : {}),
  });
}

/** What each library Worker's open did, by the library it serves, as this page heard it. */
export const startupLibraryWorkers = (): Partial<Record<LibraryWorkerRole, LibraryWorkerStartup>> =>
  libraryWorkers;

/** One line per Worker the page starts, numbered across the whole page so a burst of them is visible. */
export function startupWorkerCreated(reason: string): void {
  workers++;
  startupMark('worker created', `#${workers}, ${reason}`);
}

/** Begin waiting for the optimistic frame to be replaced; if it is not within 15 s of boot, say where it stopped. */
export function watchStartupHandover(): void {
  if (stall !== undefined || handedOver) return;
  stall = setTimeout(
    () => {
      stall = undefined;
      console.warn(
        `den: startup stalled +${sinceNavigation()}ms, no handover; last milestone "${last?.event ?? 'none'}" at +${last?.at ?? 0}ms, workers created ${workers}`,
      );
    },
    Math.max(0, STALL_MS - sinceNavigation()),
  );
}

/** The optimistic frame has been replaced (or dropped); stop the stall watch. */
export function startupHandedOver(detail?: string): void {
  handedOver = true;
  if (stall !== undefined) clearTimeout(stall);
  stall = undefined;
  startupMark('handover', detail);
}
