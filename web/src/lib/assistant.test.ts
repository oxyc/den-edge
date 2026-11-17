import { expect, test, vi } from 'vitest';
import {
  drain,
  current as drainCurrent,
  one,
  prepare,
  publish as publishLoop,
  type ApplyOutcome,
  type OtherQueue,
  type QueuedRequest,
} from './assistant';
import {
  forgetLibraryCredential,
  holdLibraryRelayMembership,
  useLibraryCredential,
} from './relayFetch';

const DROPBOX = { kid: '0123456789abcdef0123456789abcdef', public: 'pk-one' };

test('ordinary assistant publisher ticks retain only the current cancellable wait', async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const active = new Set<EventListenerOrEventListenerObject>();
  const add = stop.signal.addEventListener.bind(stop.signal);
  const remove = stop.signal.removeEventListener.bind(stop.signal);
  vi.spyOn(stop.signal, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort') active.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(stop.signal, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort') active.delete(listener);
    remove(type, listener, options);
  });
  const publish = vi.fn(async () => {});
  const running = publishLoop({ id: 'listener-cleanup', run: publish }, stop.signal);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  expect(publish).toHaveBeenLastCalledWith(stop.signal);
  expect(active.size).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  expect(active.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);

  stop.abort();
  await running;
  expect(active.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test('stopping a publisher aborts a held publish and releases its loop promptly', async () => {
  const stop = new AbortController();
  let started!: () => void;
  const held = new Promise<void>((resolve) => (started = resolve));
  const publish = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const running = publishLoop({ id: 'held-publish', run: publish }, stop.signal);
  await held;

  stop.abort();

  await expect(running).resolves.toBeUndefined();
  expect(publish).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledWith(stop.signal);
});

test('managed playback receipt preparation is lazy, retryable, and cached only after success', async () => {
  const signal = new AbortController().signal;
  const ensurePlaybackReceipts = vi
    .fn<(signal?: AbortSignal) => Promise<typeof DROPBOX | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(DROPBOX);
  const authority = { ensurePlaybackReceipts };

  await expect(prepare(authority, signal)).resolves.toBe(false);
  await expect(prepare(authority, signal)).resolves.toBe(true);
  await expect(prepare(authority, signal)).resolves.toBe(true);
  expect(ensurePlaybackReceipts).toHaveBeenCalledTimes(2);
  expect(ensurePlaybackReceipts).toHaveBeenCalledWith(signal);
});

/** A den-edge whose queue answers `drains` in turn, then holds empty until the test stops the loop. */
function edge(drains: QueuedRequest[][]) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (path.startsWith('/assistant/drain')) {
      const next = drains.shift();
      if (!next) {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener('abort', () => resolve()),
        );
        throw new DOMException('aborted', 'AbortError');
      }
      return Response.json({ messages: next });
    }
    if (path.startsWith('/assistant/ack')) return Response.json({ removed: 1 });
    return new Response(null, { status: 204 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function run(
  drains: QueuedRequest[][],
  apply: (messages: QueuedRequest[]) => Promise<ApplyOutcome>,
  queue?: OtherQueue,
) {
  const answered = drains.length;
  const { calls, fetchImpl } = edge(drains);
  const applied = vi.fn();
  const stop = new AbortController();
  const sleeps: number[] = [];
  const done = drain(
    {
      id: 'lib',
      ...(queue ? { queue } : {}),
      run: apply,
      done: applied,
      fetch: fetchImpl,
      wait: async (ms) => void sleeps.push(ms),
    },
    stop.signal,
  );
  // Every scripted answer handled, and the loop back waiting on den-edge.
  await vi.waitFor(() =>
    expect(calls.filter((c) => c.path.startsWith('/assistant/drain')).length).toBeGreaterThan(
      answered,
    ),
  );
  stop.abort();
  await done;
  return { calls, applied, sleeps };
}

test('a drain is applied, announced, acknowledged, and then held', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const accepted = {
    seq: 1,
    outcome: 'accepted' as const,
    op: 'watchlist_add',
    title: { type: 'movie' as const, id: 603 },
    detail: 'added %s to your watchlist',
  };
  const { calls, applied } = await run(
    [
      [
        { seq: 1, sealed: 'a' },
        { seq: 2, sealed: 'b' },
      ],
    ],
    async (messages) => {
      expect(messages.map((m) => m.seq)).toEqual([1, 2]);
      return {
        results: [accepted, { seq: 2, outcome: 'rejected', reason: 'revoked' }],
        ack: 2,
        dropbox: DROPBOX,
      };
    },
  );
  expect(applied).toHaveBeenCalledWith(accepted);
  // A refusal is logged by its reason alone, never as a toast.
  expect(info).toHaveBeenCalledWith('asst/refused', 'revoked');
  expect(calls.map((c) => c.path)).toEqual([
    '/assistant/drain',
    '/assistant/dropbox',
    '/assistant/ack',
    '/assistant/drain?wait=25',
  ]);
  expect(calls[1]?.body).toEqual({ pk: DROPBOX.public });
  expect(calls[2]?.body).toEqual({ upTo: 2 });
  info.mockRestore();
});

test("a TV drains and acknowledges its own lane, naming it, and leaves the drop-box key to the library's drain", async () => {
  const id = '579a181ad69c71c579c33c0aac33a1f9';
  const lane = {
    query: `queue=tv&tv=${id}`,
    body: JSON.stringify({ name: 'Living room LG' }),
    key: `.tv.${id}`,
  };
  const play = {
    seq: 3,
    outcome: 'accepted' as const,
    op: 'play',
    title: { type: 'tv' as const, id: 1399 },
    season: 1,
    episode: 2,
    detail: 'started S1 · E2 of %s',
  };
  const { calls, applied } = await run(
    [[{ seq: 3, sealed: 'p' }]],
    async () => ({ results: [play], ack: 3, dropbox: DROPBOX }),
    lane,
  );
  expect(applied).toHaveBeenCalledWith(play);
  expect(calls.map((c) => c.path)).toEqual([
    `/assistant/drain?queue=tv&tv=${id}`,
    `/assistant/ack?queue=tv&tv=${id}`,
    `/assistant/drain?queue=tv&tv=${id}&wait=25`,
  ]);
  expect(calls[0]?.body).toEqual({ name: 'Living room LG' });
  expect(calls[1]?.body).toEqual({ upTo: 3 });
});

test('the drop-box key is given to den-edge again only when the library’s changes', async () => {
  const keys = [DROPBOX, DROPBOX, { ...DROPBOX, public: 'pk-two' }];
  const { calls } = await run([[], [], []], async () => ({
    results: [],
    ack: null,
    dropbox: keys.shift()!,
  }));
  expect(calls.filter((c) => c.path === '/assistant/dropbox').map((c) => c.body)).toEqual([
    { pk: 'pk-one' },
    { pk: 'pk-two' },
  ]);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
});

test('requests left unacknowledged are not drained again at once', async () => {
  const { sleeps, calls } = await run([[{ seq: 4, sealed: 'x' }]], async () => ({
    results: [],
    ack: null,
    dropbox: null,
  }));
  expect(sleeps).toContain(15_000);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
});

test('a library service that fails to apply backs off and acknowledges nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { sleeps, calls } = await run([[{ seq: 1, sealed: 'x' }]], async () => {
    throw new Error('worker gone');
  });
  expect(sleeps).toContain(60_000);
  expect(calls.some((c) => c.path === '/assistant/ack')).toBe(false);
  warn.mockRestore();
});

test('retiring a stalled apply releases its Web Lock without an announcement or ACK', async () => {
  let delivery!: AbortSignal;
  const oldCalls: string[] = [];
  const oldFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    oldCalls.push(path);
    if (oldCalls.length === 1)
      return Response.json({ messages: [{ seq: 12, sealed: 'private-request' }] });
    await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve()));
    throw new DOMException('aborted', 'AbortError');
  }) as unknown as typeof fetch;
  const oldStop = new AbortController();
  const oldApplied = vi.fn();
  const old = drain(
    {
      id: 'replaced-library',
      run: async (_messages, signal) => {
        delivery = signal;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
        throw new Error('unreachable');
      },
      done: oldApplied,
      fetch: oldFetch,
    },
    oldStop.signal,
  );
  await vi.waitFor(() => expect(delivery).toBeInstanceOf(AbortSignal));

  const nextStop = new AbortController();
  const nextFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve()));
    throw new DOMException('aborted', 'AbortError');
  }) as unknown as typeof fetch;
  const next = drain(
    {
      id: 'replaced-library',
      run: async () => ({ results: [], ack: null, dropbox: null }),
      done: vi.fn(),
      fetch: nextFetch,
    },
    nextStop.signal,
  );
  await Promise.resolve();
  expect(nextFetch).not.toHaveBeenCalled();

  oldStop.abort();
  await old;
  await vi.waitFor(() => expect(nextFetch).toHaveBeenCalledOnce());
  expect(delivery.aborted).toBe(true);
  expect(oldApplied).not.toHaveBeenCalled();
  expect(oldCalls.some((path) => path.startsWith('/assistant/ack'))).toBe(false);

  nextStop.abort();
  await next;
});

test('a stalled apply is cancelled at its delivery deadline and remains unacknowledged', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), ms);
    return deadline.signal;
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stop = new AbortController();
  const calls: string[] = [];
  let delivery!: AbortSignal;
  const running = drain(
    {
      id: 'stalled-worker',
      run: async (_messages, signal) => {
        delivery = signal;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
        throw new Error('unreachable');
      },
      done: vi.fn(),
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ messages: [{ seq: 15, sealed: 'private-request' }] });
      }) as unknown as typeof fetch,
      wait: async (ms) => {
        expect(ms).toBe(60_000);
        stop.abort();
      },
    },
    stop.signal,
  );
  await vi.waitFor(() => expect(delivery).toBeInstanceOf(AbortSignal));
  expect(delivery.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  await running;

  expect(delivery.aborted).toBe(true);
  expect(calls).toEqual(['/assistant/drain']);
  expect(warn).toHaveBeenCalledOnce();
  timeout.mockRestore();
  warn.mockRestore();
  vi.useRealTimers();
});

test('retirement after an applied result fences its announcement and ACK', async () => {
  const stop = new AbortController();
  const applied = vi.fn();
  const calls: string[] = [];
  let publishing!: AbortSignal;
  const running = drain(
    {
      id: 'retired-after-result',
      run: async () => ({
        results: [
          {
            seq: 18,
            outcome: 'accepted',
            op: 'seen_set',
            title: { type: 'movie', id: 603 },
            detail: 'marked %s as seen',
          },
        ],
        ack: 18,
        dropbox: DROPBOX,
      }),
      done: applied,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push(path);
        if (path === '/assistant/drain')
          return Response.json({ messages: [{ seq: 18, sealed: 'private-request' }] });
        if (path === '/assistant/dropbox') {
          publishing = init?.signal as AbortSignal;
          await new Promise<void>((_resolve, reject) =>
            publishing.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          );
        }
        throw new Error(`unexpected request: ${path}`);
      }) as unknown as typeof fetch,
    },
    stop.signal,
  );
  await vi.waitFor(() => expect(publishing).toBeInstanceOf(AbortSignal));
  stop.abort();
  await running;

  expect(publishing.aborted).toBe(true);
  expect(applied).not.toHaveBeenCalled();
  expect(calls).toEqual(['/assistant/drain', '/assistant/dropbox']);
});

test('playback receipts share the queue transport but use their own one-shot routes', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return String(input).endsWith('/drain')
      ? Response.json({ messages: [{ seq: 7, sealed: 'receipt' }] })
      : Response.json({ removed: 1 });
  }) as unknown as typeof fetch;
  const apply = vi.fn(async () => ({ ack: 7 }));

  await expect(
    one({ id: 'lib', run: apply, fetch: fetchImpl }, new AbortController().signal),
  ).resolves.toEqual({ outcome: 'completed', applied: 0 });

  expect(apply).toHaveBeenCalledWith([{ seq: 7, sealed: 'receipt' }]);
  expect(calls).toEqual([
    { path: '/playback/receipts/drain', body: undefined },
    { path: '/playback/receipts/ack', body: { upTo: 7 } },
  ]);
});

test('an empty playback receipt lane does not enter the crypto/apply path', async () => {
  const ensure = vi.fn(async () => DROPBOX);
  const fetchImpl = vi.fn(async () => Response.json({ messages: [] })) as unknown as typeof fetch;
  await expect(
    drainCurrent(
      {
        id: 'lib',
        key: ensure,
        lend: async () => null,
        run: async () => ({ ack: null }),
        valid: () => true,
        fetch: fetchImpl,
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ outcome: 'empty' });
  expect(ensure).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('receipt work is fenced after key and profile awaits when authority is replaced', async () => {
  for (const boundary of ['ensure', 'lend'] as const) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let current = true;
    const apply = vi.fn(async () => ({ ack: 7 }));
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/drain')
        ? Response.json({ messages: [{ seq: 7, sealed: 'receipt' }] })
        : Response.json({ removed: 1 }),
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const running = drainCurrent(
      {
        id: `lib-${boundary}`,
        key: async () => {
          if (boundary === 'ensure') await held;
          return DROPBOX;
        },
        lend: async () => {
          if (boundary === 'lend') await held;
          return { profile: 'old' };
        },
        run: apply,
        valid: () => current,
        fetch: fetchImpl,
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    current = false;
    release();
    await expect(running).resolves.toEqual({ outcome: 'retired' });
    expect(apply, boundary).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some(([path]) => String(path).endsWith('/ack'))).toBe(false);
  }
});

test('replacement or abort while receipt apply is pending cannot acknowledge through a new authority', async () => {
  for (const boundary of ['replacement', 'abort'] as const) {
    let finish!: (value: { ack: number | null }) => void;
    const applying = new Promise<{ ack: number | null }>((resolve) => (finish = resolve));
    let current = true;
    const stop = new AbortController();
    const claims: string[] = [];
    const originatingFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      claims.push(`old:${path}`);
      return path.endsWith('/drain')
        ? Response.json({ messages: [{ seq: 8, sealed: 'receipt' }] })
        : Response.json({ removed: 1 });
    }) as unknown as typeof fetch;
    const running = drainCurrent(
      {
        id: `lib-${boundary}`,
        key: async () => DROPBOX,
        lend: async () => ({ profile: 'old' }),
        run: async () => applying,
        valid: () => current,
        fetch: originatingFetch,
      },
      stop.signal,
    );
    await vi.waitFor(() => expect(claims).toEqual(['old:/playback/receipts/drain']));
    if (boundary === 'replacement') current = false;
    else stop.abort();
    finish({ ack: 8 });
    await expect(running).resolves.toEqual({ outcome: 'retired' });
    expect(claims, boundary).toEqual(['old:/playback/receipts/drain']);
  }
});

test('an aborted receipt drain held by relay opening cannot inherit replacement membership', async () => {
  vi.stubGlobal('location', { href: 'https://den.example/library' });
  const claims: Array<string | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      claims.push(new Headers(init?.headers).get('x-den-library-member'));
      return Response.json({ messages: [{ seq: 9, sealed: 'receipt' }] });
    }),
  );
  useLibraryCredential({ id: 'old', member: 'member-a' });
  let opened!: () => void;
  const releaseOpening = holdLibraryRelayMembership(
    new Promise<void>((resolve) => (opened = resolve)),
  );
  let current = true;
  const stop = new AbortController();
  const apply = vi.fn(async () => ({ ack: 9 }));
  const running = drainCurrent(
    {
      id: 'old',
      key: async () => DROPBOX,
      lend: async () => ({ profile: 'old' }),
      run: apply,
      valid: () => current,
    },
    stop.signal,
  );
  await Promise.resolve();
  expect(claims).toEqual([]);

  useLibraryCredential({ id: 'new', member: 'member-b' });
  current = false;
  stop.abort();
  opened();
  await expect(running).resolves.toEqual({ outcome: 'retired' });
  expect(claims).toEqual(['old:member-a']);
  expect(apply).not.toHaveBeenCalled();
  releaseOpening();
  forgetLibraryCredential();
  vi.unstubAllGlobals();
});

test('a failed receipt key publication can be retried without acknowledging the queue', async () => {
  let attempt = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    return path.endsWith('/drain')
      ? Response.json({ messages: [{ seq: 7, sealed: 'receipt' }] })
      : Response.json({ removed: 1 });
  }) as unknown as typeof fetch;
  const options = {
    id: 'lib-retry',
    key: async () => {
      if (attempt++ === 0) throw new Error('key publication failed');
      return DROPBOX;
    },
    lend: async () => null,
    run: async () => ({ ack: 7 }),
    valid: () => true,
    fetch: fetchImpl,
  };
  await expect(drainCurrent(options, new AbortController().signal)).resolves.toEqual({
    outcome: 'failed',
    stage: 'apply',
  });
  expect(calls).toEqual(['/playback/receipts/drain']);
  await expect(drainCurrent(options, new AbortController().signal)).resolves.toEqual({
    outcome: 'completed',
    applied: 0,
  });
  expect(calls).toEqual([
    '/playback/receipts/drain',
    '/playback/receipts/drain',
    '/playback/receipts/ack',
  ]);
});

test('receipt transport, partial application, and acknowledgement failures stay visibly retryable', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const transport = vi.fn(
    async () => new Response(null, { status: 503 }),
  ) as unknown as typeof fetch;
  await expect(
    one(
      { id: 'transport', run: async () => ({ ack: null }), fetch: transport },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ outcome: 'failed', stage: 'drain' });

  const partialFetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).endsWith('/drain')
      ? Response.json({
          messages: [
            { seq: 1, sealed: 'first' },
            { seq: 2, sealed: 'held' },
          ],
        })
      : Response.json({ removed: 1 }),
  );
  const partialFetch = partialFetchSpy as unknown as typeof fetch;
  await expect(
    one(
      {
        id: 'partial',
        run: async () => ({ ack: 1, applied: 1 }),
        fetch: partialFetch,
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ outcome: 'failed', stage: 'apply' });
  expect(partialFetchSpy.mock.calls.map(([path]) => String(path))).toEqual([
    '/playback/receipts/drain',
    '/playback/receipts/ack',
  ]);
  expect(JSON.parse(String(partialFetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ upTo: 1 });

  const ackFetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/drain')
      ? Response.json({ messages: [{ seq: 3, sealed: 'receipt' }] })
      : new Response(null, { status: 503 }),
  ) as unknown as typeof fetch;
  await expect(
    one(
      { id: 'ack', run: async () => ({ ack: 3, applied: 1 }), fetch: ackFetch },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ outcome: 'failed', stage: 'ack' });
  warn.mockRestore();
});
