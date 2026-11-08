import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_ATTEMPTS_MAX,
  FAILURE_TTL_MS,
  FAILURE_QUEUE_MAX,
  FAILURE_REQUESTS_PER_MINUTE,
  FailureReporter,
} from './failureReport';

const base = {
  operation: 'session' as const,
  kind: 'http' as const,
  outcome: 'terminal' as const,
  route: 'remux_session' as const,
  status: 400,
};

function target() {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  return {
    listeners,
    value: {
      addEventListener: vi.fn((_name: string, listener: EventListenerOrEventListenerObject) =>
        listeners.add(listener),
      ),
      removeEventListener: vi.fn((_name: string, listener: EventListenerOrEventListenerObject) =>
        listeners.delete(listener),
      ),
    } as unknown as Window,
  };
}

const correlation = () => '0123456789abcdef';

describe('FailureReporter production transport', () => {
  it('sends with the page’s own fetch, which refuses any other receiver as browsers do', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', function (this: unknown, input: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      sent.push(input);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    try {
      new FailureReporter({ correlation }).report(base);
      await vi.waitFor(() => expect(sent).toEqual(['/diagnostics/failure']));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('copies only allowlisted fields and drops unsafe text rather than trying to scrub it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({ fetchImpl, correlation });
    reporter.report({
      ...base,
      release: 'release?token=secret',
      frame: '/Users/me/private.ts',
      authorization: 'Bearer secret',
      responseBody: 'private response',
      sourceUrl: 'https://media.example/private.m3u8?token=x',
    } as never);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      platform: 'web',
      operation: 'session',
      kind: 'http',
      outcome: 'terminal',
      correlation: '0123456789abcdef',
      route: 'remux_session',
      status: 400,
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|private|media\.example|authorization/i);
  });

  it('keeps only bounded source recovery facts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({ fetchImpl, correlation });
    reporter.report({
      operation: 'source_lookup',
      kind: 'timeout',
      outcome: 'terminal',
      route: 'content_service',
      durationBucket: 'deadline',
      priorList: true,
      title: 'Private title',
      imdbId: 'tt-secret',
      sourceUrl: 'https://media.example/private.m3u8?token=x',
    } as never);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      platform: 'web',
      operation: 'source_lookup',
      kind: 'timeout',
      outcome: 'terminal',
      correlation: '0123456789abcdef',
      route: 'content_service',
      durationBucket: 'deadline',
      priorList: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/Private title|tt-secret|media\.example|token/i);
  });

  it('queues while offline, drains on reconnect, then removes its only online listener', async () => {
    let online = false;
    const events = target();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({
      fetchImpl,
      correlation,
      online: () => online,
      target: events.value,
    });
    reporter.report(base);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reporter.queued).toBe(1);
    expect(events.listeners.size).toBe(1);

    online = true;
    const listener = [...events.listeners][0]!;
    if (typeof listener === 'function') listener(new Event('online'));
    else listener.handleEvent(new Event('online'));
    await vi.waitFor(() => expect(reporter.queued).toBe(0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.listeners.size).toBe(0);
  });

  it('expires an offline queue and its listener without waiting forever for reconnect', async () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const events = target();
    const reporter = new FailureReporter({
      correlation,
      now: () => now,
      online: () => false,
      target: events.value,
      setTimer: ((fn: TimerHandler) => {
        timers.push(fn as () => void);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });
    reporter.report(base);
    expect(reporter.queued).toBe(1);
    expect(events.listeners.size).toBe(1);

    now = FAILURE_TTL_MS;
    timers.at(-1)!();
    await vi.waitFor(() => expect(reporter.queued).toBe(0));
    expect(events.listeners.size).toBe(0);
  });

  it('deduplicates a logical failure across retry correlation and attempt metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({ fetchImpl, correlation });
    reporter.report({ ...base, correlation: '0000000000000000', attempt: 1 });
    reporter.report({ ...base, correlation: '1111111111111111', attempt: 2 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it('aborts an in-flight stale generation and never requeues it', async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('stale', 'AbortError')),
            {
              once: true,
            },
          ),
        ),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const reporter = new FailureReporter({ fetchImpl, correlation });
    reporter.report({ ...base, generation: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    reporter.replace('session', 2);
    await vi.waitFor(() => expect(reporter.queued).toBe(0));
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('retries a transient delivery only once and never storms', async () => {
    const timers: Array<() => void> = [];
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const reporter = new FailureReporter({
      fetchImpl,
      correlation,
      setTimer: ((fn: TimerHandler) => {
        timers.push(fn as () => void);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });
    reporter.report(base);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // The request timeout and the retry are both cancellable timers; run the last scheduled retry only.
    timers.at(-1)!();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(FAILURE_ATTEMPTS_MAX));
    expect(reporter.queued).toBe(0);
  });

  it('bounds the offline queue', () => {
    const online = false;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({ fetchImpl, correlation, online: () => online });
    for (let generation = 0; generation < FAILURE_QUEUE_MAX + 5; generation += 1)
      reporter.report({ ...base, generation });
    expect(reporter.queued).toBe(FAILURE_QUEUE_MAX);
  });

  it('defers the next online request until the rate window opens', async () => {
    let now = 0;
    const timers: Array<{ run: () => void; delay: number }> = [];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new FailureReporter({
      fetchImpl,
      correlation,
      now: () => now,
      setTimer: ((fn: TimerHandler, delay?: number) => {
        timers.push({ run: fn as () => void, delay: delay ?? 0 });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });
    for (let generation = 0; generation < FAILURE_REQUESTS_PER_MINUTE; generation += 1) {
      reporter.report({ ...base, generation });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(generation + 1));
    }
    reporter.report({ ...base, generation: FAILURE_REQUESTS_PER_MINUTE });
    await vi.waitFor(() => expect(reporter.queued).toBe(1));
    expect(fetchImpl).toHaveBeenCalledTimes(FAILURE_REQUESTS_PER_MINUTE);
    expect(timers.at(-1)!.delay).toBe(60_000);

    now = 60_000;
    timers.at(-1)!.run();
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledTimes(FAILURE_REQUESTS_PER_MINUTE + 1),
    );
  });
});
