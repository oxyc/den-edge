import { describe, expect, it, vi } from 'vitest';
import { lanReachable } from '../../cast/src/lan';

describe('the home-network probe', () => {
  it('is reachable when the home-network address answers at all, even opaquely', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    expect(
      await lanReachable('https://lan.media.example:8449/remux/s/a/b/master.m3u8', fetchImpl),
    ).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://lan.media.example:8449/remux/health');
    expect(init.mode).toBe('no-cors');
  });

  it('is not reachable when the request fails (no route, or a certificate that is not ours)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed');
    });
    expect(await lanReachable('https://lan.media.example:8449/x', fetchImpl)).toBe(false);
  });

  it('gives up after the timeout instead of holding playback back', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const probe = lanReachable(
        'https://lan.media.example:8449/x',
        fetchImpl as unknown as typeof fetch,
        1_000,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await probe).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has nothing to probe when the session carries no home-network address', async () => {
    const fetchImpl = vi.fn();
    expect(await lanReachable(undefined, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
