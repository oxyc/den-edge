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

  it('buffers two minutes ahead, within a browser’s SourceBuffer quota, and a minute behind', () => {
    const config = hlsConfig();
    expect(config.maxBufferLength).toBe(120);
    // Half a minute of lost connection at 5 Mbit/s is what this has to ride out.
    expect(config.maxBufferLength! - 30).toBeGreaterThanOrEqual(60);
    expect(config.maxBufferSize).toBeLessThanOrEqual(150 * 1000 * 1000);
    expect(config.backBufferLength).toBe(60);
  });

  it('asks a Cast receiver for a buffer its memory holds', () => {
    const receiver = hlsConfig(undefined, 'receiver');
    expect(receiver.maxBufferLength).toBe(60);
    expect(receiver.maxBufferSize).toBe(50 * 1000 * 1000);
    expect(receiver.backBufferLength).toBe(10);
    expect(receiver.fragLoadPolicy).toEqual(hlsConfig().fragLoadPolicy);
  });

  it('keeps hls.js off a worker, which the player and the cast page both rely on', () => {
    expect(hlsConfig().enableWorker).toBe(false);
  });
});
