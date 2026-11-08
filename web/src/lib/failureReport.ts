// Privacy-minimized terminal client failures for den-edge's existing diagnostics log. This module is loaded only
// after the first failure: ordinary startup, playback and navigation pay no listener, timer or queue cost.

import { currentClientPlatform } from './clientPlatform';
import { apiUrl } from './runtimeUrl';

export type FailureOperation =
  | 'playback'
  | 'session'
  | 'receipt'
  | 'authority'
  | 'persistence'
  | 'recovery'
  | 'uncaught'
  | 'navigation'
  | 'cast'
  | 'source_lookup';
export type FailureKind =
  | 'transport'
  | 'http'
  | 'timeout'
  | 'protocol'
  | 'storage'
  | 'authority'
  | 'cancelled'
  | 'uncaught'
  | 'other';
export type FailureOutcome = 'terminal' | 'recovered' | 'retry_exhausted';
export type FailureDurationBucket = 'fast' | 'slow' | 'deadline';
export type FailureRoute =
  | 'page'
  | 'remux_session'
  | 'remux_grant'
  | 'cast_config'
  | 'cast_receiver'
  | 'receipt_drain'
  | 'receipt_apply'
  | 'receipt_ack'
  | 'content_service';
export type FailureErrorClass =
  | 'type_error'
  | 'reference_error'
  | 'range_error'
  | 'syntax_error'
  | 'dom_exception'
  | 'network_error'
  | 'abort_error'
  | 'media_error'
  | 'decode_error'
  | 'quota_error'
  | 'unknown';
export type FailureModule =
  'app' | 'player' | 'billboard' | 'row' | 'settings' | 'cast' | 'router' | 'other';

export interface ClientFailure {
  operation: FailureOperation;
  kind: FailureKind;
  outcome: FailureOutcome;
  route?: FailureRoute;
  status?: number;
  generation?: number;
  attempt?: number;
  errorClass?: FailureErrorClass;
  module?: FailureModule;
  frame?: string;
  uncaught?: boolean;
  durationBucket?: FailureDurationBucket;
  priorList?: boolean;
  release?: string;
  correlation?: string;
}

interface WireFailure extends ClientFailure {
  platform: ReturnType<typeof currentClientPlatform>;
  correlation: string;
}

interface QueuedFailure {
  report: WireFailure;
  fingerprint: string;
  createdAt: number;
  attempts: number;
}

export const FAILURE_QUEUE_MAX = 16;
export const FAILURE_TTL_MS = 5 * 60_000;
export const FAILURE_DEDUPE_MS = 60_000;
export const FAILURE_ATTEMPTS_MAX = 2;
export const FAILURE_REQUESTS_PER_MINUTE = 20;
export const FAILURE_BODY_MAX = 2048;
const RETRY_MS = 5_000;
const REQUEST_MS = 8_000;

type OnlineTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface FailureReporterOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  online?: () => boolean;
  target?: OnlineTarget;
  correlation?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function randomCorrelation(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function endpoint(): string {
  return __DEN_TV_API_ORIGIN__ ? apiUrl('/diagnostics/failure') : '/diagnostics/failure';
}

function fingerprint(report: ClientFailure): string {
  const { correlation: _correlation, attempt: _attempt, ...stable } = report;
  return JSON.stringify(stable);
}

const OPERATIONS: readonly FailureOperation[] = [
  'playback',
  'session',
  'receipt',
  'authority',
  'persistence',
  'recovery',
  'uncaught',
  'navigation',
  'cast',
  'source_lookup',
];
const KINDS: readonly FailureKind[] = [
  'transport',
  'http',
  'timeout',
  'protocol',
  'storage',
  'authority',
  'cancelled',
  'uncaught',
  'other',
];
const OUTCOMES: readonly FailureOutcome[] = ['terminal', 'recovered', 'retry_exhausted'];
const DURATION_BUCKETS: readonly FailureDurationBucket[] = ['fast', 'slow', 'deadline'];
const ROUTES: readonly FailureRoute[] = [
  'page',
  'remux_session',
  'remux_grant',
  'cast_config',
  'cast_receiver',
  'receipt_drain',
  'receipt_apply',
  'receipt_ack',
  'content_service',
];
const ERROR_CLASSES: readonly FailureErrorClass[] = [
  'type_error',
  'reference_error',
  'range_error',
  'syntax_error',
  'dom_exception',
  'network_error',
  'abort_error',
  'media_error',
  'decode_error',
  'quota_error',
  'unknown',
];
const MODULES: readonly FailureModule[] = [
  'app',
  'player',
  'billboard',
  'row',
  'settings',
  'cast',
  'router',
  'other',
];

function correlation(value: string): boolean {
  return (
    /^[0-9a-f]{16,64}$/.test(value) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  );
}

/** Copy only the wire allowlist. This runtime boundary protects against an `unknown` value or a future caller
 * accidentally spreading a response, URL, console argument or identifier into the typed API. */
function wireFailure(input: ClientFailure, makeCorrelation: () => string): WireFailure | undefined {
  if (
    !OPERATIONS.includes(input.operation) ||
    !KINDS.includes(input.kind) ||
    !OUTCOMES.includes(input.outcome)
  )
    return undefined;
  const id = input.correlation ?? makeCorrelation();
  if (!correlation(id)) return undefined;
  const report: WireFailure = {
    platform: currentClientPlatform(),
    operation: input.operation,
    kind: input.kind,
    outcome: input.outcome,
    correlation: id,
  };
  if (input.release !== undefined && /^[a-z0-9.+-]{1,64}$/.test(input.release))
    report.release = input.release;
  if (input.route !== undefined && ROUTES.includes(input.route)) report.route = input.route;
  if (
    input.status !== undefined &&
    Number.isInteger(input.status) &&
    input.status >= 100 &&
    input.status <= 599
  )
    report.status = input.status;
  if (
    input.generation !== undefined &&
    Number.isInteger(input.generation) &&
    input.generation >= 0 &&
    input.generation <= 0xffffffff
  )
    report.generation = input.generation;
  if (
    input.attempt !== undefined &&
    Number.isInteger(input.attempt) &&
    input.attempt >= 0 &&
    input.attempt <= 0xff
  )
    report.attempt = input.attempt;
  if (input.errorClass !== undefined && ERROR_CLASSES.includes(input.errorClass))
    report.errorClass = input.errorClass;
  if (input.module !== undefined && MODULES.includes(input.module)) report.module = input.module;
  if (input.frame !== undefined && /^[A-Z][A-Za-z0-9]{0,31}$/.test(input.frame))
    report.frame = input.frame;
  if (input.uncaught === true) report.uncaught = true;
  if (input.durationBucket !== undefined && DURATION_BUCKETS.includes(input.durationBucket))
    report.durationBucket = input.durationBucket;
  if (typeof input.priorList === 'boolean') report.priorList = input.priorList;
  return report;
}

export function failureErrorClass(error: unknown): FailureErrorClass {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (error.name === 'AbortError') return 'abort_error';
    if (error.name === 'NetworkError') return 'network_error';
    if (error.name === 'QuotaExceededError') return 'quota_error';
    return 'dom_exception';
  }
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof ReferenceError) return 'reference_error';
  if (error instanceof RangeError) return 'range_error';
  if (error instanceof SyntaxError) return 'syntax_error';
  return 'unknown';
}

/** One in-memory best-effort queue. It never writes identifiers or failure details to persistent storage. */
export class FailureReporter {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #online: () => boolean;
  readonly #target?: OnlineTarget;
  readonly #correlation: () => string;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #queue: QueuedFailure[] = [];
  readonly #seen = new Map<string, number>();
  readonly #requests: number[] = [];
  readonly #generations = new Map<FailureOperation, number>();
  #draining = false;
  #listening = false;
  #retry?: ReturnType<typeof setTimeout>;
  #controller?: { operation: FailureOperation; generation?: number; value: AbortController };

  constructor(options: FailureReporterOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#online = options.online ?? (() => globalThis.navigator?.onLine !== false);
    this.#target = options.target ?? (typeof window === 'undefined' ? undefined : window);
    this.#correlation = options.correlation ?? randomCorrelation;
    // Older WebKit and Chromium require timer functions to be called with their Window receiver. Store wrappers,
    // not the detached native methods, because this lazy reporter first exercises them on a real failure.
    this.#setTimer =
      options.setTimer ??
      (((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        globalThis.setTimeout(handler, timeout, ...args)) as typeof setTimeout);
    this.#clearTimer =
      options.clearTimer ??
      (((timer?: ReturnType<typeof setTimeout>) =>
        globalThis.clearTimeout(timer)) as typeof clearTimeout);
  }

  report(input: ClientFailure): void {
    const now = this.#now();
    const report = wireFailure(input, this.#correlation);
    if (!report) return;
    const key = fingerprint(report);
    const seen = this.#seen.get(key);
    if (seen !== undefined && now - seen < FAILURE_DEDUPE_MS) return;
    this.#seen.set(key, now);
    for (const [fingerprint, at] of this.#seen)
      if (now - at >= FAILURE_DEDUPE_MS) this.#seen.delete(fingerprint);
    if (new TextEncoder().encode(JSON.stringify(report)).byteLength > FAILURE_BODY_MAX) return;
    if (this.#queue.length >= FAILURE_QUEUE_MAX) this.#queue.shift();
    this.#queue.push({ report, fingerprint: key, createdAt: now, attempts: 0 });
    this.#listen();
    void this.flush();
  }

  /** Fence queued and in-flight work from an older lifecycle generation. */
  replace(operation: FailureOperation, generation: number): void {
    const current = this.#generations.get(operation);
    if (current !== undefined && generation <= current) return;
    this.#generations.set(operation, generation);
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const report = this.#queue[index]!.report;
      if (
        report.operation === operation &&
        report.generation !== undefined &&
        report.generation < generation
      )
        this.#queue.splice(index, 1);
    }
    const active = this.#controller;
    if (
      active?.operation === operation &&
      active.generation !== undefined &&
      active.generation < generation
    )
      active.value.abort();
    this.#settleLifetime();
  }

  async flush(): Promise<void> {
    if (this.#draining) return;
    this.#pruneStale();
    if (!this.#queue.length) {
      this.#settleLifetime();
      return;
    }
    if (!this.#online()) {
      this.#scheduleRetry(this.#untilExpiry());
      return;
    }
    this.#draining = true;
    try {
      while (this.#queue.length && this.#online()) {
        const item = this.#queue[0]!;
        if (this.#stale(item)) {
          this.#queue.shift();
          continue;
        }
        const now = this.#now();
        while (this.#requests.length && now - this.#requests[0]! >= 60_000) this.#requests.shift();
        if (this.#requests.length >= FAILURE_REQUESTS_PER_MINUTE) {
          this.#scheduleRetry(Math.max(1, 60_000 - (now - this.#requests[0]!)));
          break;
        }
        item.attempts += 1;
        this.#requests.push(now);
        const controller = new AbortController();
        this.#controller = {
          operation: item.report.operation,
          generation: item.report.generation,
          value: controller,
        };
        const timeout = this.#setTimer(() => controller.abort(), REQUEST_MS);
        let retry = false;
        try {
          const response = await this.#fetch(endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.report),
            keepalive: true,
            signal: controller.signal,
          });
          retry = response.status >= 500;
        } catch {
          retry = true;
        } finally {
          this.#clearTimer(timeout);
          if (this.#controller?.value === controller) this.#controller = undefined;
        }
        if (this.#queue[0] === item) this.#queue.shift();
        if (retry && item.attempts < FAILURE_ATTEMPTS_MAX && !this.#stale(item)) {
          this.#queue.unshift(item);
          this.#scheduleRetry(RETRY_MS);
          break;
        }
      }
    } finally {
      this.#draining = false;
      this.#settleLifetime();
    }
  }

  get queued(): number {
    return this.#queue.length;
  }

  #stale(item: QueuedFailure): boolean {
    if (this.#now() - item.createdAt >= FAILURE_TTL_MS) return true;
    const generation = item.report.generation;
    const current = this.#generations.get(item.report.operation);
    return generation !== undefined && current !== undefined && generation < current;
  }

  #pruneStale(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1)
      if (this.#stale(this.#queue[index]!)) this.#queue.splice(index, 1);
  }

  #untilExpiry(): number {
    return Math.max(1, FAILURE_TTL_MS - (this.#now() - this.#queue[0]!.createdAt));
  }

  #scheduleRetry(delay: number): void {
    if (this.#retry !== undefined) return;
    this.#retry = this.#setTimer(() => {
      this.#retry = undefined;
      void this.flush();
    }, delay);
  }

  #listen(): void {
    if (this.#listening || !this.#target) return;
    this.#target.addEventListener('online', this.#onOnline);
    this.#listening = true;
  }

  #settleLifetime(): void {
    if (this.#queue.length) return;
    if (this.#retry !== undefined) {
      this.#clearTimer(this.#retry);
      this.#retry = undefined;
    }
    if (this.#listening && this.#target) this.#target.removeEventListener('online', this.#onOnline);
    this.#listening = false;
  }

  readonly #onOnline = () => void this.flush();
}

const reporter = new FailureReporter();

export function reportClientFailure(report: ClientFailure): void {
  reporter.report(report);
}

export function replaceFailureGeneration(operation: FailureOperation, generation: number): void {
  reporter.replace(operation, generation);
}
