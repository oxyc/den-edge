import { describe, expect, it } from 'vitest';
import { sourceWait } from './sourceDiscoveryPolicy';

describe('source discovery policy binding', () => {
  it('returns den-core phases and the one bounded connectivity retry without local rules', async () => {
    await expect(sourceWait({ elapsedMs: 4_999, attempt: 0, jitter: 0.5 })).resolves.toEqual({
      phase: 'loading',
      nextMs: 1,
      retryInMs: null,
    });
    await expect(
      sourceWait({
        elapsedMs: 21_000,
        attempt: 0,
        onlineRestored: true,
        jitter: 0.25,
      }),
    ).resolves.toEqual({ phase: 'deadline', nextMs: null, retryInMs: 1_000 });
    await expect(
      sourceWait({
        elapsedMs: 3_000,
        attempt: 1,
        onlineRestored: true,
        jitter: 0.25,
      }),
    ).resolves.toEqual({ phase: 'loading', nextMs: 2_000, retryInMs: null });
  });
});
