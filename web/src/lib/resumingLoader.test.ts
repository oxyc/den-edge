import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FragmentLoaderContext, HlsConfig, LoaderConfiguration, LoaderStats } from 'hls.js';
import { Link, OUTAGE_MS, resumingLoader, wasInterrupted } from './resumingLoader';

const SEGMENT = Uint8Array.from({ length: 64 }, (_, n) => n);
const ETAG = '"run-1"';

/** A body that sends `bytes` and then breaks, as a connection that drops mid-transfer does. */
function breaking(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new TypeError('network error'));
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

interface Asked {
  range: string | null;
  ifRange: string | null;
}

/** A fetch that answers each call with the next of `answers`, and remembers what each asked for. */
function fetching(answers: ((asked: Asked) => Response | Promise<Response>)[]) {
  const asked: Asked[] = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const one = { range: headers.get('range'), ifRange: headers.get('if-range') };
    asked.push(one);
    const answer = answers.shift();
    if (!answer) throw new TypeError('no more answers');
    return answer(one);
  });
  vi.stubGlobal('fetch', impl);
  return asked;
}

function load(link: Link) {
  const Loader = resumingLoader(link);
  const loader = new Loader({} as HlsConfig);
  const context = {
    url: 'https://media.test/remux/s/a/b/seg3.m4s',
    responseType: 'arraybuffer',
  } as FragmentLoaderContext;
  const config = {
    loadPolicy: { maxTimeToFirstByteMs: 30_000, maxLoadTimeMs: 120_000 },
  } as LoaderConfiguration;
  const result = new Promise<
    { ok: true; data: ArrayBuffer; stats: LoaderStats } | { ok: false; code?: number }
  >((resolve) => {
    loader.load(context, config, {
      onSuccess: (response, stats) =>
        resolve({ ok: true, data: response.data as ArrayBuffer, stats }),
      onError: (error) => resolve({ ok: false, code: error.code }),
      onTimeout: () => resolve({ ok: false }),
    });
  });
  return { loader, result };
}

const whole = (headers: Record<string, string> = { etag: ETAG }) =>
  new Response(SEGMENT, {
    status: 200,
    headers: { 'content-length': String(SEGMENT.length), ...headers },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('resumingLoader', () => {
  it('hands hls.js the segment as it came when nothing broke', async () => {
    fetching([() => whole()]);
    const link = new Link(new EventTarget() as unknown as Window);
    const { result } = load(link);
    const got = await result;
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
    expect(got.ok && wasInterrupted(got.stats)).toBe(false);
    expect(link.down).toBe(false);
  });

  it('asks for the rest of a broken segment with its ETag, and joins the two', async () => {
    const asked = fetching([
      () =>
        new Response(breaking(SEGMENT.slice(0, 20)), {
          status: 200,
          headers: { etag: ETAG, 'content-length': String(SEGMENT.length) },
        }),
      () =>
        new Response(SEGMENT.slice(20), {
          status: 206,
          headers: {
            etag: ETAG,
            'content-range': `bytes 20-63/64`,
            'content-length': '44',
          },
        }),
    ]);
    const link = new Link(new EventTarget() as unknown as Window);
    const seen: boolean[] = [];
    link.subscribe((down) => seen.push(down));
    const { result } = load(link);
    const got = await result;
    expect(asked).toEqual([
      { range: null, ifRange: null },
      { range: 'bytes=20-', ifRange: ETAG },
    ]);
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
    expect(got.ok && got.stats.loaded).toBe(SEGMENT.length);
    // Its time spans the break, so the player doesn't read the link's rate from it.
    expect(got.ok && wasInterrupted(got.stats)).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  it('takes the whole segment again when den-remux answers the range with all of it', async () => {
    fetching([
      () =>
        new Response(breaking(SEGMENT.slice(0, 20)), {
          status: 200,
          headers: { etag: ETAG, 'content-length': '64' },
        }),
      // Made again by a later run: the If-Range didn't match, and the answer is the new whole.
      () => whole({ etag: '"run-2"' }),
    ]);
    const { result } = load(new Link(new EventTarget() as unknown as Window));
    const got = await result;
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
  });

  it('asks a den-remux that names no ETag for the whole segment, never a range', async () => {
    const asked = fetching([
      () =>
        new Response(breaking(SEGMENT.slice(0, 20)), {
          status: 200,
          headers: { 'content-length': '64' },
        }),
      () => whole({}),
    ]);
    const { result } = load(new Link(new EventTarget() as unknown as Window));
    const got = await result;
    expect(asked[1]).toEqual({ range: null, ifRange: null });
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
  });

  it('waits out a connection that is gone, retrying at once when the browser is back online', async () => {
    vi.useFakeTimers();
    const window = new EventTarget();
    const link = new Link(window as unknown as Window);
    const regrants = vi.fn(() => Promise.resolve());
    link.beforeRetry = regrants;
    let back = false;
    let asked = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        asked += 1;
        return back ? Promise.resolve(whole()) : Promise.reject(new TypeError('Failed to fetch'));
      }),
    );
    const { result } = load(link);
    let settled = false;
    void result.then(() => (settled = true));
    // Minutes of nothing: still asking every few seconds, and never an error to hls.js.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled).toBe(false);
    expect(link.down).toBe(true);
    expect(asked).toBeGreaterThan(30);
    expect(regrants).toHaveBeenCalled();
    // Back: the browser says so, and the wait in progress is cut short.
    back = true;
    const before = asked;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(before + 1);
    const got = await result;
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
    expect(link.down).toBe(false);
  });

  it('gives up once the connection has been gone as long as den-remux keeps a session', async () => {
    vi.useFakeTimers();
    const link = new Link(new EventTarget() as unknown as Window);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { result } = load(link);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(OUTAGE_MS - 10_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual({ ok: false, code: 0 });
    expect(link.down).toBe(true);
  });

  it('says at once when den-remux has ended the session', async () => {
    fetching([() => new Response('{}', { status: 410 })]);
    const { result } = load(new Link(new EventTarget() as unknown as Window));
    expect(await result).toEqual({ ok: false, code: 410 });
  });

  it('tries a server error again only a couple of times, as hls.js did', async () => {
    vi.useFakeTimers();
    const busy = () => new Response('{}', { status: 503, headers: { 'retry-after': '2' } });
    const asked = fetching([busy, busy, busy, () => whole()]);
    const link = new Link(new EventTarget() as unknown as Window);
    const { result } = load(link);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ ok: false, code: 503 });
    expect(asked).toHaveLength(3);
    expect(link.down, 'den-remux answered: the connection is there').toBe(false);
  });

  it('gives up on a transfer that goes silent, and resumes it', async () => {
    vi.useFakeTimers();
    const asked = fetching([
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(SEGMENT.slice(0, 10));
              // …and then nothing, ever: a line that went to nothing says nothing either.
            },
          }),
          { status: 200, headers: { etag: ETAG, 'content-length': '64' } },
        ),
      () =>
        new Response(SEGMENT.slice(10), {
          status: 206,
          headers: { etag: ETAG, 'content-range': 'bytes 10-63/64' },
        }),
    ]);
    const { result } = load(new Link(new EventTarget() as unknown as Window));
    await vi.advanceTimersByTimeAsync(15_000);
    const got = await result;
    expect(asked[1]?.range).toBe('bytes=10-');
    expect(got.ok && new Uint8Array(got.data)).toEqual(SEGMENT);
  });

  it('tells hls.js of an abort, and asks nothing more', async () => {
    fetching([() => new Promise<Response>(() => undefined)]);
    const Loader = resumingLoader(new Link(new EventTarget() as unknown as Window));
    const loader = new Loader({} as HlsConfig);
    const aborted = vi.fn();
    loader.load(
      { url: 'https://media.test/seg0.m4s', responseType: 'arraybuffer' } as FragmentLoaderContext,
      { loadPolicy: { maxTimeToFirstByteMs: 30_000 } } as LoaderConfiguration,
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: aborted },
    );
    loader.abort();
    expect(aborted).toHaveBeenCalledOnce();
    expect(loader.stats.aborted).toBe(true);
  });
});
