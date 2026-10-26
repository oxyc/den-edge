import { describe, expect, it, vi } from 'vitest';
import { lastPromiseCache } from './lastPromiseCache';

describe('lastPromiseCache', () => {
  it('shares one in-flight or settled read for the same key', async () => {
    const cache = lastPromiseCache<string, number>();
    const load = vi.fn(async () => 7);
    const first = cache.read('personal', load);
    expect(cache.read('personal', load)).toBe(first);
    await expect(first).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('isolates keys and makes a failed latest read retryable', async () => {
    const cache = lastPromiseCache<string, number>();
    await expect(
      cache.read('personal', async () => Promise.reject(new Error('offline'))),
    ).rejects.toThrow('offline');
    await expect(cache.read('shared', async () => 2)).resolves.toBe(2);
    await expect(cache.read('personal', async () => 3)).resolves.toBe(3);
  });

  it('forgets only the matching scope after a successful write', async () => {
    const cache = lastPromiseCache<string, number>();
    const personal = vi.fn(async () => 1);
    await cache.read('personal', personal);
    cache.forget('shared');
    await cache.read('personal', personal);
    expect(personal).toHaveBeenCalledTimes(1);
    cache.forget('personal');
    await cache.read('personal', personal);
    expect(personal).toHaveBeenCalledTimes(2);
  });
});
