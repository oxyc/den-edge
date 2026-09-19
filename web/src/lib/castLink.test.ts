import { describe, expect, it } from 'vitest';
import { signedLinkLimit, usableLinkLimit } from '../../cast/src/link';

describe('signed public link measurement', () => {
  it('downloads only the supplied signed probe and keeps headroom', async () => {
    const asked: string[] = [];
    const chunks = [new Uint8Array(100_000), new Uint8Array(100_000), new Uint8Array(100_000)];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        }),
      );
    };
    const times = [0, 200, 400];
    const result = await signedLinkLimit(
      'https://203.0.113.7/remux/s/a/b/speed',
      fetchImpl,
      () => times.shift() ?? 400,
    );
    expect(asked).toEqual(['https://203.0.113.7/remux/s/a/b/speed?bytes=2097152']);
    expect(result).toBe(2_800_000);
  });

  it('returns no cap when the signed probe cannot be read', async () => {
    expect(
      await signedLinkLimit('https://203.0.113.7/remux/s/a/b/speed', async () => {
        throw new TypeError('offline');
      }),
    ).toBeUndefined();
  });

  it('does not suspend playback for a sample below the parent player floor', () => {
    expect(usableLinkLimit(63_999)).toBeUndefined();
    expect(usableLinkLimit(64_000)).toBe(64_000);
  });
});
