import { describe, expect, it, vi } from 'vitest';
import { LibraryServiceError } from './libraryServiceClient';
import type { LibraryServiceErrorCode } from './libraryServiceProtocol';
import { transientServiceFailure, untilServiceSettles } from './serviceSettles';

const failure = (code: LibraryServiceErrorCode, retryable = false) =>
  new LibraryServiceError({ code, message: code, retryable });
const instant = { backoffMs: [1, 1, 1], wait: async () => {} };

describe('untilServiceSettles', () => {
  it('asks again while the service is not ready, reconnecting or its client was closed', async () => {
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure('not-ready', true))
      .mockRejectedValueOnce(failure('cancelled'))
      .mockRejectedValueOnce(failure('unavailable', true))
      .mockResolvedValueOnce('created');
    await expect(untilServiceSettles(work, { ...instant, backoffMs: [1, 1, 1, 1] })).resolves.toBe(
      'created',
    );
    expect(work).toHaveBeenCalledTimes(4);
  });

  it('never asks again after a refusal', async () => {
    for (const code of ['unauthorized', 'refused', 'invalid-request', 'read-only'] as const) {
      const work = vi.fn(() => Promise.reject(failure(code)));
      await expect(untilServiceSettles(work, instant)).rejects.toMatchObject({
        failure: { code },
      });
      expect(work).toHaveBeenCalledOnce();
    }
    const work = vi.fn(() => Promise.reject(new Error('den-core refused')));
    await expect(untilServiceSettles(work, instant)).rejects.toThrow('den-core refused');
    expect(work).toHaveBeenCalledOnce();
  });

  it('gives up after its backoff, with the last failure', async () => {
    const work = vi.fn(() => Promise.reject(failure('not-ready', true)));
    await expect(untilServiceSettles(work, instant)).rejects.toMatchObject({
      failure: { code: 'not-ready' },
    });
    expect(work).toHaveBeenCalledTimes(4);
  });

  it('stops once the page no longer wants it', async () => {
    let live = true;
    const work = vi.fn(() => {
      live = false;
      return Promise.reject(failure('not-ready', true));
    });
    await expect(untilServiceSettles(work, { ...instant, live: () => live })).rejects.toBeTruthy();
    expect(work).toHaveBeenCalledOnce();
  });

  it('waits longer each time', async () => {
    const waits: number[] = [];
    const work = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(failure('not-ready', true))
      .mockRejectedValueOnce(failure('not-ready', true))
      .mockResolvedValueOnce(1);
    await untilServiceSettles(work, { wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([500, 1_000]);
  });

  it('tells transient service failures from answers', () => {
    expect(transientServiceFailure(failure('not-ready', true))).toBe(true);
    expect(transientServiceFailure(failure('storage', true))).toBe(true);
    expect(transientServiceFailure(failure('conflict'))).toBe(false);
    expect(transientServiceFailure(new Error('x'))).toBe(false);
  });
});
