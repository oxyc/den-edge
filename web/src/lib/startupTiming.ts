// Always-on startup breadcrumbs: one `den: startup` console line per milestone, each with the milliseconds since
// navigation start, so a slow start shows where it waited. Milestones only: never a key, token, library id, title
// or row, and nothing per row. Both the page and the library Worker log here.

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
type Relayed =
  | { origin: string; kind: 'mark'; event: string; at: number }
  | { origin: string; kind: 'count'; name: string }
  | ({ origin: string; kind: 'resource' } & StartupResource);
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
/** The page's main thread blocked for 50 ms or more at a time (`longtask`): how often, how long in all, the longest. */
const longTasks = { count: 0, ms: 0, longest: 0 };

if (channel && !inWorker)
  channel.onmessage = ({ data: message }: MessageEvent<Relayed>) => {
    if (message?.origin !== ORIGIN) return;
    if (message.kind === 'mark') {
      const event = `worker ${message.event}`;
      if (!firsts.has(event)) firsts.set(event, message.at);
      lasts.set(event, Math.max(lasts.get(event) ?? 0, message.at));
    } else if (message.kind === 'count')
      counts.set(message.name, (counts.get(message.name) ?? 0) + 1);
    else if (workerResources.length < MAX_WORKER_RESOURCES)
      workerResources.push(resourceOf(message));
  };

const observe = (type: string, each: (entry: PerformanceEntry) => void) => {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    new PerformanceObserver((list) => list.getEntries().forEach(each)).observe({
      type,
      buffered: true,
    });
  } catch {
    // An engine without this entry type reports without it.
  }
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
  if (!inWorker)
    observe('longtask', ({ duration }) => {
      longTasks.count++;
      longTasks.ms += Math.round(duration);
      longTasks.longest = Math.max(longTasks.longest, Math.round(duration));
    });
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
export const startupLongTasks = (): [number, number, number] => [
  longTasks.count,
  longTasks.ms,
  longTasks.longest,
];

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
