// hls.js's fragment loader for a den-remux session, built to ride out a dropped connection: the bytes of a segment
// already received are kept, the rest is asked for with a `Range` when the line comes back, and a segment is asked for
// again for as long as den-remux keeps the session rather than for the ten seconds hls.js's own retries last.

import type {
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderStats,
} from 'hls.js';

type LoaderContext = FragmentLoaderContext;
import { retryAfterMs } from './retryAfter';

/**
 * How long a segment is asked for with nothing arriving before playback gives up on it: den-remux's own idle limit
 * (`SESSION_IDLE_SECS`, ten minutes). Past it the session is gone anyway, and asking on only delays saying so.
 */
export const OUTAGE_MS = 10 * 60_000;
/** Waits between attempts while the connection is down: quick at first, then every few seconds. */
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000];
/**
 * An open transfer that has gone this long without a byte is a dead connection, not a slow one: a line that went to
 * nothing often says nothing either, and a request left hanging would wait for the browser's own minutes-long timeout.
 */
const SILENT_MS = 10_000;
/** How often den-remux may answer an error (a 5xx, or 503 while it makes the segment) before hls.js is told. */
const SERVER_RETRIES = 2;

/**
 * The connection as the segments see it, shared by every loader of one player: whether fragments have stopped
 * arriving, and since when. The player shows it ("Reconnecting…") and keeps its watchdogs off it; the loaders wait on
 * it, and are woken early when the browser says it is online again.
 */
export class Link {
  /** `performance.now()` when a segment request first failed for want of a connection; null while bytes flow. */
  downSince: number | null = null;
  /**
   * Asked before each retry while down: re-asserts whatever lets this browser reach the media (the public listener's
   * grant for an address that may have changed). Never throws.
   */
  beforeRetry?: () => Promise<void>;
  private listeners = new Set<(down: boolean) => void>();
  private waiting = new Set<() => void>();

  constructor(
    private readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  ) {
    target.addEventListener('online', this.wake);
  }

  /** Stop listening for the browser's `online`; the player's session is over. */
  dispose(): void {
    this.target.removeEventListener('online', this.wake);
    this.wake();
    this.listeners.clear();
  }

  get down(): boolean {
    return this.downSince !== null;
  }

  /** Call `listener` whenever the link goes down or comes back. */
  subscribe(listener: (down: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  failed(now: number): void {
    if (this.downSince !== null) return;
    this.downSince = now;
    for (const listener of this.listeners) listener(true);
  }

  flowing(): void {
    if (this.downSince === null) return;
    this.downSince = null;
    for (const listener of this.listeners) listener(false);
  }

  /** Resolve after `ms`, or sooner if the browser comes back online. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiting.add(done);
    });
  }

  /** Every waiting retry, now: the browser says it is online again. */
  readonly wake = (): void => {
    for (const done of [...this.waiting]) done();
  };
}

const interrupted = new WeakSet<LoaderStats>();

/**
 * Whether a finished fragment's transfer was broken and resumed. Its time from first byte to last spans the outage,
 * so it says nothing about the link's rate.
 */
export function wasInterrupted(stats: LoaderStats): boolean {
  return interrupted.has(stats);
}

/** The `start` of a `Content-Range: bytes start-end/total`, or null. */
function rangeStart(header: string | null): number | null {
  const match = header?.match(/^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/);
  return match ? Number(match[1]) : null;
}

function newStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

/** Put the kept pieces of a segment back together. */
function joined(chunks: Uint8Array[], length: number): ArrayBuffer {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * A fragment loader class for hls.js's `fLoader`, sharing `link` across the loaders one player makes.
 *
 * Each attempt streams the body and keeps what arrives. A transfer that breaks — a network error, or `SILENT_MS` with
 * no byte — is tried again after a short wait, asking only for the rest (`Range: bytes=<kept>-`) with `If-Range`
 * naming the ETag it came with, so a segment den-remux has since made again (and whose bytes may differ) comes back
 * whole instead of being spliced. A den-remux that names no ETag (one that predates ranges) is asked for the whole.
 * Waiting goes on until `OUTAGE_MS` has passed with nothing arriving, and the browser's `online` cuts a wait short.
 *
 * hls.js hears only the end: the joined segment, or an error — 410 when den-remux has ended the session, and code 0
 * once the connection stayed away for `OUTAGE_MS`. A 5xx is den-remux answering, so it is tried again only
 * `SERVER_RETRIES` times, as hls.js did. Its own retries are off (`hlsConfig`): this is where they are.
 */
export function resumingLoader(link: Link): new (config: HlsConfig) => Loader<LoaderContext> {
  return class ResumingLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = newStats();
    private callbacks: LoaderCallbacks<LoaderContext> | null = null;
    private controller: AbortController | null = null;
    private etag: string | null = null;
    private chunks: Uint8Array[] = [];
    private have = 0;
    private done = false;

    constructor(_config: HlsConfig) {}

    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.context = context;
      this.callbacks = callbacks;
      this.stats.loading.start = performance.now();
      void this.run(config.loadPolicy.maxTimeToFirstByteMs || SILENT_MS);
    }

    abort(): void {
      if (this.done) return;
      this.done = true;
      this.stats.aborted = true;
      this.controller?.abort();
      const { callbacks, context } = this;
      if (context) callbacks?.onAbort?.(this.stats, context, null);
    }

    destroy(): void {
      this.done = true;
      this.controller?.abort();
      this.callbacks = null;
      this.context = null;
      this.chunks = [];
    }

    getCacheAge(): number | null {
      return null;
    }

    getResponseHeader(): string | null {
      return null;
    }

    private async run(firstByteMs: number): Promise<void> {
      let backoff = 0;
      let serverErrors = 0;
      let downSince: number | null = null;
      while (!this.done) {
        const outcome = await this.attempt(firstByteMs);
        if (this.done) return;
        if (outcome.kind === 'complete') {
          link.flowing();
          this.succeed(outcome.status);
          return;
        }
        if (outcome.kind === 'final') {
          if (outcome.status !== 0) link.flowing();
          return this.fail(outcome.status, outcome.text);
        }
        const now = performance.now();
        if (outcome.kind === 'server') {
          // den-remux answered: the connection is there, and the error is its to say again.
          link.flowing();
          downSince = null;
          if (++serverErrors > SERVER_RETRIES) return this.fail(outcome.status, outcome.text);
          await link.sleep(outcome.retryMs ?? Math.min(1_000 * 2 ** (serverErrors - 1), 8_000));
          continue;
        }
        // Bytes arrived in this attempt: the connection was there until it broke, so the wait starts over.
        if (outcome.progressed) {
          downSince = now;
          backoff = 0;
        }
        downSince ??= now;
        link.failed(now);
        this.stats.retry += 1;
        interrupted.add(this.stats);
        if (now - downSince >= OUTAGE_MS) return this.fail(0, 'connection lost');
        await link.sleep(BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)] ?? 5_000);
        if (this.done) return;
        await link.beforeRetry?.();
      }
    }

    /** One request for what is still missing, streamed into `chunks`. */
    private async attempt(
      firstByteMs: number,
    ): Promise<
      | { kind: 'complete'; status: number }
      | { kind: 'final'; status: number; text: string }
      | { kind: 'server'; status: number; text: string; retryMs?: number }
      | { kind: 'broken'; progressed: boolean }
    > {
      const context = this.context;
      if (!context) return { kind: 'final', status: 0, text: 'destroyed' };
      const controller = (this.controller = new AbortController());
      const resuming = this.have > 0 && this.etag !== null;
      if (this.have > 0 && !resuming) {
        this.chunks = [];
        this.have = 0;
      }
      const headers: Record<string, string> = {};
      if (resuming) {
        headers.Range = `bytes=${this.have}-`;
        headers['If-Range'] = this.etag!;
      }
      let silent: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const quiet = (ms: number) => {
        clearTimeout(silent);
        silent = setTimeout(() => {
          timedOut = true;
          controller.abort();
          void reader?.cancel().catch(() => undefined);
        }, ms);
      };
      let progressed = false;
      try {
        quiet(firstByteMs);
        const response = await fetch(context.url, {
          headers,
          signal: controller.signal,
          // A resumed piece is one request's tail, not something to keep; the first is kept as den-remux says.
          cache: resuming ? 'no-store' : 'default',
        });
        if (response.status === 410) return { kind: 'final', status: 410, text: 'session ended' };
        if (response.status === 416) {
          // What was kept no longer fits what den-remux has: the whole segment again, now.
          this.chunks = [];
          this.have = 0;
          this.etag = null;
          return { kind: 'broken', progressed: true };
        }
        if (response.status >= 500)
          return {
            kind: 'server',
            status: response.status,
            text: response.statusText,
            retryMs: retryAfterMs(response, 0) || undefined,
          };
        if (response.status !== 200 && response.status !== 206)
          return { kind: 'final', status: response.status, text: response.statusText };
        const start =
          response.status === 206 ? rangeStart(response.headers.get('content-range')) : 0;
        if (start !== this.have) {
          // The whole segment (a changed ETag, or a server that ignored the range), or a piece that isn't the one
          // asked for: start over from what this answer is.
          this.chunks = [];
          this.have = 0;
          if (start !== 0) {
            this.etag = null;
            return { kind: 'broken', progressed: true };
          }
        }
        this.etag = response.headers.get('etag');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 0) this.stats.total = this.have + length;
        reader = response.body?.getReader();
        if (!reader) return { kind: 'broken', progressed };
        for (;;) {
          quiet(SILENT_MS);
          const { done, value } = await reader.read();
          if (done) break;
          if (this.done) return { kind: 'final', status: 0, text: 'aborted' };
          if (!this.stats.loading.first) this.stats.loading.first = performance.now();
          if (!progressed) link.flowing();
          progressed = true;
          this.chunks.push(value);
          this.have += value.byteLength;
          this.stats.loaded = this.have;
          this.stats.chunkCount += 1;
        }
        if (timedOut || (this.stats.total && this.have < this.stats.total))
          return { kind: 'broken', progressed };
        return { kind: 'complete', status: response.status };
      } catch {
        // A network error, or `quiet` giving up on a silent one: kept what came, and tried again.
        if (this.done && !timedOut) return { kind: 'final', status: 0, text: 'aborted' };
        return { kind: 'broken', progressed };
      } finally {
        clearTimeout(silent);
        if (this.controller === controller) this.controller = null;
      }
    }

    private succeed(status: number): void {
      const { callbacks, context } = this;
      if (!callbacks || !context || this.done) return;
      this.done = true;
      const stats = this.stats;
      stats.loading.end = Math.max(performance.now(), stats.loading.first);
      stats.loaded = stats.total = this.have;
      const span = stats.loading.end - stats.loading.first;
      stats.bwEstimate = span > 0 ? (this.have * 8000) / span : 0;
      const buffer = joined(this.chunks, this.have);
      this.chunks = [];
      const data = context.responseType === 'text' ? new TextDecoder().decode(buffer) : buffer;
      callbacks.onSuccess(
        { url: context.url, data, code: status === 206 ? 200 : status },
        stats,
        context,
        null,
      );
    }

    private fail(code: number, text: string): void {
      const { callbacks, context } = this;
      if (!callbacks || !context || this.done) return;
      this.done = true;
      this.chunks = [];
      callbacks.onError({ code, text }, context, null, this.stats);
    }
  };
}
