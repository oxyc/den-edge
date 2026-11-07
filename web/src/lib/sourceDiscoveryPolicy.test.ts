import { describe, expect, it } from 'vitest';
import { sourceWait } from './sourceDiscoveryPolicy';

describe('source discovery policy binding', () => {
  it('returns den-core phases and the one bounded connectivity retry without local rules', async () => {
    await expect(sourceWait({ elapsed_ms: 4_999, attempt: 0, jitter: 0.5 })).resolves.toEqual({
      phase: 'loading',
      next_ms: 1,
      retry_in_ms: null,
    });
    await expect(
      sourceWait({
        elapsed_ms: 21_000,
        attempt: 0,
        online_restored: true,
        jitter: 0.25,
      }),
    ).resolves.toEqual({ phase: 'deadline', next_ms: null, retry_in_ms: 1_000 });
    await expect(
      sourceWait({
        elapsed_ms: 3_000,
        attempt: 1,
        online_restored: true,
        jitter: 0.25,
      }),
    ).resolves.toEqual({ phase: 'loading', next_ms: 2_000, retry_in_ms: null });
  });
});
