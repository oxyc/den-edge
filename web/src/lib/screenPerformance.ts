// How each screen drew, after the page has loaded: main-thread stalls (Long Animation Frames where the engine has
// them, long tasks otherwise) and a requestAnimationFrame frame meter, counted against the screen showing and sent
// as it is left — the tvOS app's `PerformanceAudit` stalls event, field for field, to the same `POST
// /performance/event` (`diagnostics.rs`). A screen that neither stalled nor missed a frame sends nothing, which keeps
// a session inside den-edge's 20-a-minute report limit, as on tvOS.

import { currentRelease, reportUrl } from './diagnosticsReport';
import { currentClientPlatform } from './clientPlatform';
import { retryAfterMs } from './retryAfter';
import type { Route } from './route';

/** The screens den-edge's `PerformanceRoute` names. */
export type ScreenRoute =
  'home' | 'movies' | 'series' | 'watchlist' | 'title' | 'search' | 'settings' | 'player' | 'other';

/** Which screen `route` is: never the title, query or person itself. */
export function screenOf(route: Route): ScreenRoute {
  switch (route.page) {
    case 'library':
      return 'home';
    case 'movies':
    case 'series':
    case 'watchlist':
    case 'settings':
    case 'search':
      return route.page;
    case 'title':
      return route.play ? 'player' : 'title';
    default:
      return 'other';
  }
}

/** How a screen drew: tvOS's `PerformanceAudit.Frames`. */
export interface Frames {
  delivered: number;
  /** Frames that should have been drawn but weren't: one arriving three budgets after the last missed two. */
  missed: number;
  /** Time late frames ran past one budget, summed. */
  hitchMs: number;
  longestMs: number;
  visibleMs: number;
}

/** Frame times into `Frames`, one requestAnimationFrame callback at a time (tvOS's `FrameMeter`). */
export class FrameMeter {
  #last: number | undefined;
  #delivered = 0;
  #missed = 0;
  #hitch = 0;
  #longest = 0;
  #visible = 0;

  /** A frame at `at` ms, on a display drawing one every `budget` ms. */
  frame(at: number, budget: number): void {
    const last = this.#last;
    this.#last = at;
    if (last === undefined || budget <= 0) return;
    const interval = at - last;
    if (interval <= 0) return;
    this.#delivered++;
    this.#visible += interval;
    this.#longest = Math.max(this.#longest, interval);
    // Half a budget of slack, so callback jitter is not counted as a missed frame.
    if (interval <= budget * 1.5) return;
    this.#hitch += interval - budget;
    this.#missed += Math.round(interval / budget) - 1;
  }

  /** Frames stopped (the page hid, the player covered it): the gap until they resume is not a frame. */
  pause(): void {
    this.#last = undefined;
  }

  /** What was drawn since the last drain, or nothing when nothing was. */
  drain(): Frames | undefined {
    if (!this.#delivered) return undefined;
    const frames = {
      delivered: this.#delivered,
      missed: this.#missed,
      hitchMs: Math.round(this.#hitch),
      longestMs: Math.round(this.#longest),
      visibleMs: Math.round(this.#visible),
    };
    this.#delivered = this.#missed = this.#hitch = this.#longest = this.#visible = 0;
    return frames;
  }
}

/** One troubled screen, as it is sent. */
export interface ScreenStalls {
  route: ScreenRoute;
  /** `[count, total ms, longest ms]`, absent when the main thread never stalled. */
  stalls?: [number, number, number];
  frames?: Frames;
}

/** Stalls and frames by the screen showing while they happened (tvOS's `StallLedger`). */
export class StallLedger {
  #route: ScreenRoute | undefined;
  #stalls = 0;
  #total = 0;
  #longest = 0;
  #frames: Frames = { delivered: 0, missed: 0, hitchMs: 0, longestMs: 0, visibleMs: 0 };

  stall(ms: number): void {
    if (!(ms > 0)) return;
    this.#stalls++;
    this.#total += Math.round(ms);
    this.#longest = Math.max(this.#longest, Math.round(ms));
  }

  drew(frames: Frames | undefined): void {
    if (!frames) return;
    this.#frames = {
      delivered: this.#frames.delivered + frames.delivered,
      missed: this.#frames.missed + frames.missed,
      hitchMs: this.#frames.hitchMs + frames.hitchMs,
      longestMs: Math.max(this.#frames.longestMs, frames.longestMs),
      visibleMs: this.#frames.visibleMs + frames.visibleMs,
    };
  }

  /** A new screen: what the last one stalled, if it was troubled, to be sent against it. */
  enter(next: ScreenRoute): ScreenStalls | undefined {
    if (next === this.#route) return undefined;
    const flushed = this.flush();
    this.#route = next;
    return flushed;
  }

  /** What the current screen stalled and drew so far, leaving it current; nothing for a smooth one. */
  flush(): ScreenStalls | undefined {
    const route = this.#route;
    const stalls = this.#stalls;
    const frames = this.#frames;
    const troubled = stalls > 0 || frames.missed > 0;
    const flushed: ScreenStalls | undefined =
      route && troubled
        ? {
            route,
            ...(stalls ? { stalls: [stalls, this.#total, this.#longest] } : {}),
            ...(frames.delivered ? { frames } : {}),
          }
        : undefined;
    this.#stalls = this.#total = this.#longest = 0;
    this.#frames = { delivered: 0, missed: 0, hitchMs: 0, longestMs: 0, visibleMs: 0 };
    return flushed;
  }
}

function combined(first: ScreenStalls | undefined, second: ScreenStalls): ScreenStalls {
  if (!first) return second;
  const stalls =
    first.stalls || second.stalls
      ? ([
          (first.stalls?.[0] ?? 0) + (second.stalls?.[0] ?? 0),
          (first.stalls?.[1] ?? 0) + (second.stalls?.[1] ?? 0),
          Math.max(first.stalls?.[2] ?? 0, second.stalls?.[2] ?? 0),
        ] as [number, number, number])
      : undefined;
  const frames =
    first.frames || second.frames
      ? {
          delivered: (first.frames?.delivered ?? 0) + (second.frames?.delivered ?? 0),
          missed: (first.frames?.missed ?? 0) + (second.frames?.missed ?? 0),
          hitchMs: (first.frames?.hitchMs ?? 0) + (second.frames?.hitchMs ?? 0),
          longestMs: Math.max(first.frames?.longestMs ?? 0, second.frames?.longestMs ?? 0),
          visibleMs: (first.frames?.visibleMs ?? 0) + (second.frames?.visibleMs ?? 0),
        }
      : undefined;
  return { route: second.route, ...(stalls ? { stalls } : {}), ...(frames ? { frames } : {}) };
}

const BATCH_MS = 1_000;
const REPORTS_PER_MINUTE = 12;

/**
 * One page's bounded performance transport. Repeated visits to the same screen are folded together, at most one
 * event leaves per batch interval, and a refusal keeps the folded event until the server's Retry-After has passed.
 */
export class ScreenReportBatcher {
  readonly #pending = new Map<ScreenRoute, ScreenStalls>();
  readonly #sentAt: number[] = [];
  #retryAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending = false;

  constructor(
    // Keep the browser fetch receiver: storing an unbound host function on this class and calling it as a method
    // gives older TV engines the batcher as `this`, which they reject as an illegal invocation.
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
    private readonly schedules = true,
    private readonly cap = REPORTS_PER_MINUTE,
  ) {}

  enqueue(screen: ScreenStalls): void {
    this.#pending.set(screen.route, combined(this.#pending.get(screen.route), screen));
    this.#arm(BATCH_MS);
  }

  /** Send one folded route when its local allowance and the server permit it. */
  async flush(): Promise<boolean> {
    if (this.#sending || !this.#pending.size) return false;
    const now = this.now();
    while (this.#sentAt[0] !== undefined && this.#sentAt[0] <= now - 60_000) this.#sentAt.shift();
    const localWait = this.#sentAt.length >= this.cap ? this.#sentAt[0]! + 60_000 - now : 0;
    const wait = Math.max(0, this.#retryAt - now, localWait);
    if (wait > 0) {
      this.#arm(wait);
      return false;
    }

    const next = this.#pending.entries().next().value as [ScreenRoute, ScreenStalls] | undefined;
    if (!next) return false;
    const [route, screen] = next;
    this.#pending.delete(route);
    this.#sentAt.push(now);
    this.#sending = true;
    try {
      const release = currentRelease();
      const response = await this.fetchImpl(reportUrl('/performance/event'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: currentClientPlatform(),
          ...(release ? { release } : {}),
          journey: 'navigation',
          stage: 'stalls',
          ...screen,
          memory: { warnings: 0 },
        }),
        keepalive: true,
      });
      if (response.status === 429) {
        this.#pending.set(route, combined(this.#pending.get(route), screen));
        this.#retryAt = this.now() + retryAfterMs(response, 60_000, this.now);
      }
    } catch {
      // Diagnostics never interfere with the page. A network failure is not retried into a later session.
    } finally {
      this.#sending = false;
      if (this.#pending.size) this.#arm(BATCH_MS);
    }
    return true;
  }

  get pending(): number {
    return this.#pending.size;
  }

  #arm(delay: number): void {
    if (!this.schedules || this.#timer !== undefined) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.flush();
      },
      Math.max(0, delay),
    );
  }
}

const screenReports = new ScreenReportBatcher();

/** Queue a troubled screen into the page's bounded, folding transport. */
export function sendScreenStalls(screen: ScreenStalls): void {
  screenReports.enqueue(screen);
}

/** Flush promptly when the document may be leaving; the request itself uses `keepalive`. */
export function flushScreenStalls(): Promise<boolean> {
  return screenReports.flush();
}

/** A display's frame interval; a faster one only under-counts hitches. */
const FRAME_BUDGET_MS = 1000 / 60;

/**
 * Meter the page from now on. `enter` names the screen now showing; the meter's frame loop runs only while the page
 * is visible and not under the player, whose own video presentation is reported apart (and where a loop would only
 * cost the TV a callback per frame). Returns the stop.
 */
export function meterScreens(send: (screen: ScreenStalls) => void = sendScreenStalls): {
  enter(route: ScreenRoute): void;
  stop(): void;
} {
  const ledger = new StallLedger();
  const meter = new FrameMeter();
  let route: ScreenRoute | undefined;
  let frame = 0;
  const tick = (at: number) => {
    meter.frame(at, FRAME_BUDGET_MS);
    frame = requestAnimationFrame(tick);
  };
  const metering = () => document.visibilityState === 'visible' && route !== 'player';
  const run = () => {
    if (metering() && !frame) frame = requestAnimationFrame(tick);
    if (!metering() && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      meter.pause();
    }
  };
  const flushed = (screen: ScreenStalls | undefined) => {
    if (screen) send(screen);
  };

  // Long Animation Frames where the engine has them (they say what blocked a frame, not only that a task ran
  // long); `longtask` otherwise. Older TV engines have neither, and meter frames alone.
  const kinds =
    typeof PerformanceObserver === 'undefined' ? [] : PerformanceObserver.supportedEntryTypes;
  const kind = kinds?.includes('long-animation-frame')
    ? 'long-animation-frame'
    : kinds?.includes('longtask')
      ? 'longtask'
      : undefined;
  const observer = kind
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) ledger.stall(entry.duration);
      })
    : undefined;
  observer?.observe({ type: kind!, buffered: false });

  const hidden = () => {
    if (document.visibilityState === 'hidden') {
      ledger.drew(meter.drain());
      // The page may never come back to leave this screen: what it stalled so far goes now.
      flushed(ledger.flush());
      void flushScreenStalls();
    }
    run();
  };
  document.addEventListener('visibilitychange', hidden);
  return {
    enter(next) {
      ledger.drew(meter.drain());
      flushed(ledger.enter(next));
      route = next;
      run();
    },
    stop() {
      ledger.drew(meter.drain());
      flushed(ledger.flush());
      void flushScreenStalls();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', hidden);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
