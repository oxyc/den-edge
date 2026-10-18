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
/** Each milestone's first time on this page, for its one load report (`loadReport.ts`). */
const firsts = new Map<string, number>();
let workers = 0;
let stall: ReturnType<typeof setTimeout> | undefined;
let handedOver = false;

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
