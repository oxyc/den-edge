import { describe, expect, it, vi } from 'vitest';
import {
  knownCodec,
  parseServerTiming,
  sendStartupReport,
  sizeBucket,
  type StartupReport,
} from './startupReport';

describe('parseServerTiming', () => {
  it('reads resolve, open (with how many were tried) and init', () => {
    expect(parseServerTiming('resolve;dur=12,open;dur=34;desc="3 tried",init;dur=56')).toEqual({
      resolveMs: 12,
      openMs: 34,
      tried: 3,
      initMs: 56,
    });
  });

  it('leaves out whatever the header did not carry, rather than zeroing it', () => {
    expect(parseServerTiming('resolve;dur=5,open;dur=9;desc="1 tried"')).toEqual({
      resolveMs: 5,
      openMs: 9,
      tried: 1,
    });
  });

  it('is empty for no header, or one with nothing it recognizes', () => {
    expect(parseServerTiming(undefined)).toEqual({});
    expect(parseServerTiming(null)).toEqual({});
    expect(parseServerTiming('')).toEqual({});
    expect(parseServerTiming('cache;dur=3')).toEqual({});
  });
});

describe('sizeBucket', () => {
  it('buckets by GB, never passing the exact size through', () => {
    expect(sizeBucket(4 * 1024 ** 3)).toBe('small');
    expect(sizeBucket(5 * 1024 ** 3)).toBe('medium');
    expect(sizeBucket(19.9 * 1024 ** 3)).toBe('medium');
    expect(sizeBucket(20 * 1024 ** 3)).toBe('large');
    expect(sizeBucket(49 * 1024 ** 3)).toBe('large');
    expect(sizeBucket(58 * 1024 ** 3)).toBe('xlarge');
    expect(sizeBucket(null)).toBe('small');
    expect(sizeBucket(undefined)).toBe('small');
  });
});

describe('knownCodec', () => {
  it('passes through every codec den-remux names', () => {
    expect(knownCodec('h264')).toBe('h264');
    expect(knownCodec('hevc')).toBe('hevc');
    expect(knownCodec('av1')).toBe('av1');
    expect(knownCodec('vp9')).toBe('vp9');
  });

  it('falls back to h264 for anything not yet named, rather than failing to send a report', () => {
    expect(knownCodec('vvc')).toBe('h264');
    expect(knownCodec(undefined)).toBe('h264');
  });
});

describe('sendStartupReport', () => {
  const report: StartupReport = {
    sessionMs: 1234,
    firstSegmentMs: 2200,
    firstFrameMs: 9800,
    bytesLoaded: 12_345_678,
    size: 'large',
    codec: 'hevc',
    transcoded: false,
    player: 'hls.js',
    route: 'lan',
  };

  it('posts to den-edge’s own origin, kept alive, with the report as the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    sendStartupReport(report, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledWith('/playback/startup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    });
  });

  it('never throws when the send fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(() => sendStartupReport(report, fetchImpl)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
