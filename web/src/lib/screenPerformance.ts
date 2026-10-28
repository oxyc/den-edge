// How each screen drew, after the page has loaded: main-thread stalls (Long Animation Frames where the engine has
// them, long tasks otherwise) and a requestAnimationFrame frame meter, counted against the screen showing and sent
// as it is left — the tvOS app's `PerformanceAudit` stalls event, field for field, to the same `POST
// /performance/event` (`diagnostics.rs`). A screen that neither stalled nor missed a frame sends nothing, which keeps
// a session inside den-edge's 20-a-minute report limit, as on tvOS.

import { currentRelease, reportUrl } from './diagnosticsReport';
import { currentClientPlatform } from './clientPlatform';
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

/** `sendBeacon` first: a screen is often left by the page hiding or unloading. */
export function sendScreenStalls(screen: ScreenStalls, fetchImpl: typeof fetch = fetch): void {
  const release = currentRelease();
  const body = JSON.stringify({
    platform: currentClientPlatform(),
    ...(release ? { release } : {}),
    journey: 'navigation',
    stage: 'stalls',
    ...screen,
    // A browser has no memory warnings; the field is required of every event.
    memory: { warnings: 0 },
  });
  const url = reportUrl('/performance/event');
  if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, body)) return;
  void fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
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
      observer?.disconnect();
      document.removeEventListener('visibilitychange', hidden);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
