import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetIpv4Hint,
  HINT_TTL_MS,
  ipifyAddress,
  ipv4Hint,
  lookupIpv4,
  retryWithoutHint,
  traceAddress,
} from './ipv4';

const TRACE = 'fl=1\nh=1.1.1.1\nip=198.51.100.7\nts=1\nvisit_scheme=https\n';

afterEach(() => {
  forgetIpv4Hint();
  vi.useRealTimers();
});

describe('traceAddress', () => {
  it('reads the IPv4 address on the trace’s ip= line', () => {
    expect(traceAddress(TRACE)).toBe('198.51.100.7');
    expect(traceAddress('ip=203.0.113.9\r\n')).toBe('203.0.113.9');
  });

  it('takes nothing that is not one bare IPv4 address', () => {
    for (const line of [
      'ip=2001:db8::7',
      'ip=198.51.100.7/32',
      'ip=198.51.100.256',
      'ip=198.051.100.7',
      'ip=',
      'visit_scheme=https',
      'zip=198.51.100.7',
    ])
      expect(traceAddress(line), line).toBeUndefined();
  });
});

describe('ipifyAddress', () => {
  it('reads the ip field when it is IPv4', () => {
    expect(ipifyAddress({ ip: '198.51.100.7' })).toBe('198.51.100.7');
    expect(ipifyAddress({ ip: '2001:db8::7' })).toBeUndefined();
    expect(ipifyAddress({ ip: 7 })).toBeUndefined();
    expect(ipifyAddress(null)).toBeUndefined();
  });
});

describe('lookupIpv4', () => {
  it('asks Cloudflare’s IP-literal trace first, without cookies or a referrer', async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const address = await lookupIpv4(async (input, init) => {
      asked.push([String(input), init]);
      return new Response(TRACE);
    });
    expect(address).toBe('198.51.100.7');
    expect(asked.map(([url]) => url)).toEqual(['https://1.1.1.1/cdn-cgi/trace']);
    expect(asked[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('falls back to ipify when the trace fails or says no IPv4 address', async () => {
    for (const trace of [
      () => Promise.reject(new TypeError('blocked')),
      async () => new Response('ip=2001:db8::7\n'),
      async () => new Response('', { status: 502 }),
    ]) {
      const address = await lookupIpv4(async (input) =>
        String(input).startsWith('https://1.1.1.1/')
          ? trace()
          : new Response(JSON.stringify({ ip: '203.0.113.9' })),
      );
      expect(address).toBe('203.0.113.9');
    }
  });

  it('gives up with no address when neither answers', async () => {
    expect(await lookupIpv4(() => Promise.reject(new TypeError('offline')))).toBeUndefined();
  });

  it('gives up with no address once its time is spent, and aborts what it asked', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const lookup = lookupIpv4((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {}); // never answers, and ignores the abort
    }, 1_500);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await lookup).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});

describe('ipv4Hint', () => {
  it('reuses a looked-up address for two minutes, then looks it up again', async () => {
    const fetchImpl = vi.fn(async () => new Response(TRACE));
    expect(await ipv4Hint(fetchImpl, 0)).toBe('198.51.100.7');
    expect(await ipv4Hint(fetchImpl, HINT_TTL_MS - 1)).toBe('198.51.100.7');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(HINT_TTL_MS).toBe(2 * 60_000);
    expect(await ipv4Hint(fetchImpl, HINT_TTL_MS)).toBe('198.51.100.7');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps no failed lookup, so the next play asks again', async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError('offline')));
    expect(await ipv4Hint(offline, 0)).toBeUndefined();
    const fetchImpl = vi.fn(async () => new Response(TRACE));
    expect(await ipv4Hint(fetchImpl, 1)).toBe('198.51.100.7');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('retryWithoutHint', () => {
  it('retries a hinted session that never played, once', () => {
    expect(retryWithoutHint({ hinted: true }, false, false)).toBe(true);
    // Already retried: what fails now is not the hint, and goes the usual way.
    expect(retryWithoutHint({ hinted: true }, false, true)).toBe(false);
    // Something arrived, so the listener was open for the right address.
    expect(retryWithoutHint({ hinted: true }, true, false)).toBe(false);
    // den-edge used no hint for it: asking again without one would change nothing.
    expect(retryWithoutHint({}, false, false)).toBe(false);
    expect(retryWithoutHint({ hinted: false }, false, false)).toBe(false);
  });
});
