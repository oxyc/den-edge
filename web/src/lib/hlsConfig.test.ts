import { describe, expect, it } from 'vitest';
import { hlsConfig } from './hlsConfig';

describe('hlsConfig', () => {
  it('starts where told, or lets hls.js use the playlist start', () => {
    expect(hlsConfig(1234).startPosition).toBe(1234);
    expect(hlsConfig().startPosition).toBe(-1);
  });

  it('waits through a slow first segment and retries before calling a session broken', () => {
    const policy = hlsConfig().fragLoadPolicy?.default;
    expect(policy?.maxTimeToFirstByteMs).toBe(30_000);
    expect(policy?.timeoutRetry?.maxNumRetry).toBe(2);
    expect(policy?.errorRetry?.maxNumRetry).toBe(2);
  });

  it('keeps hls.js off a worker, which the player and the cast page both rely on', () => {
    expect(hlsConfig().enableWorker).toBe(false);
  });
});
