import { describe, expect, it } from 'vitest';
import { receiverReport } from '../../cast/src/capabilities';
import { castReceiverOptIn, playableOf } from './castReceiver';

/**
 * A receiver's `canDisplayType`, as a Chromecast answers for its decoder and the TV behind it: `codecs` lists what it
 * decodes (a codec string's prefix, with its highest level), `maxHeight` the TV's size, `pq` whether it takes HDR10.
 */
function receiver({
  h264 = 0x33,
  hevc = 153,
  dolbyVision = false,
  pq = false,
  maxHeight = 2160,
  audio = ['mp4a.40.2'],
  other = [] as string[],
} = {}) {
  const asked: string[] = [];
  const answer = (type: string) => {
    asked.push(type);
    const codec = /codecs="([^"]+)"/.exec(type)?.[1] ?? '';
    const height = Number(/height=(\d+)/.exec(type)?.[1] ?? 0);
    if (height > maxHeight) return false;
    if (/eotf=smpte2084/.test(type) && !pq) return false;
    if (/eotf=arib-std-b67/.test(type)) return false;
    if (type.startsWith('audio/')) return audio.includes(codec);
    const avc = /^avc1\.64(00)([0-9a-f]{2})$/i.exec(codec);
    if (avc) return parseInt(avc[2]!, 16) <= h264;
    const hevcMatch = /^(?:hvc1|hev1)\.[12]\.[46]\.L(\d+)\.B0$/.exec(codec);
    if (hevcMatch) return Number(hevcMatch[1]) <= hevc;
    if (/^dvh1\./.test(codec)) return dolbyVision;
    return other.some((prefix) => codec.startsWith(prefix));
  };
  return { answer, asked };
}

describe('Den’s receiver reports what its TV plays as the browser `playable`', () => {
  it('a 4K Chromecast on an HDR10 TV with Dolby passthrough', async () => {
    const tv = receiver({
      pq: true,
      dolbyVision: true,
      audio: ['mp4a.40.2', 'ec-3', 'ac-3', 'fLaC'],
      other: ['av01', 'vp09'],
    });
    const report = await receiverReport(tv.answer);
    expect(report.type).toBe('den-capabilities');
    expect(report.playable).toEqual({
      h264: 0x33,
      h264High10: 0,
      hevcMain: 153,
      hevcMain10: 153,
      hevcHighTier: 0,
      hdr: true,
      eac3: true,
      aacMultichannel: false,
      dolbyVision: { p5: true, p8: true },
      // The TV decodes AV1 and VP9, but Den's HLS/fMP4 of either is untried on a receiver: still not asked for.
      av1: 0,
      av1Main10: 0,
      av1Hdr: false,
      flac: true,
      aac71: false,
      vp9: false,
      vp9Profile2: false,
    });
    expect(report.details).toMatchObject({
      maxHeight: 2160,
      hdr10: true,
      hlg: false,
      av1: 13,
      vp9: true,
    });
    // HDR is asked of the TV, at 4K, under its transfer function.
    expect(tv.asked).toContain(
      'video/mp4; codecs="hvc1.2.4.L153.B0"; width=3840; height=2160; framerate=24; eotf=smpte2084',
    );
    expect(playableOf(report.playable)).toEqual(report.playable);
  });

  it('an HD Chromecast on an SDR TV: no 4K level, no HDR, no Dolby Vision, AC-3 alone is not Dolby', async () => {
    const report = await receiverReport(
      receiver({
        h264: 0x2a,
        hevc: 123,
        maxHeight: 1080,
        dolbyVision: true,
        audio: ['mp4a.40.2', 'ac-3'],
      }).answer,
    );
    expect(report.playable).toMatchObject({
      h264: 0x29,
      hevcMain: 123,
      hevcMain10: 123,
      hdr: false,
      eac3: false,
      dolbyVision: { p5: false, p8: false },
    });
    expect(report.details).toMatchObject({ maxWidth: 1920, maxHeight: 1080, hdr10: false });
  });

  it('a receiver whose canDisplayType throws reports nothing it can play rather than failing', async () => {
    const report = await receiverReport(() => {
      throw new Error('not started');
    });
    expect(report.playable).toMatchObject({ h264: 0, hevcMain: 0, hdr: false, eac3: false });
  });
});

describe('playableOf', () => {
  const can = {
    h264: 0x33,
    h264High10: 0,
    hevcMain: 153,
    hevcMain10: 153,
    hevcHighTier: 0,
    hdr: true,
    eac3: false,
    aacMultichannel: false,
    dolbyVision: { p5: false, p8: true },
    av1: 0,
    av1Main10: 0,
    av1Hdr: false,
    flac: false,
    aac71: false,
    vp9: false,
    vp9Profile2: false,
  };

  it('keeps exactly the schema’s fields, dropping anything else a receiver sent', () => {
    expect(
      playableOf({ ...can, extra: 'x', dolbyVision: { p5: false, p8: true, p7: true } }),
    ).toEqual(can);
  });

  it('refuses a report that is not one', () => {
    expect(playableOf(null)).toBeNull();
    expect(playableOf('{}')).toBeNull();
    expect(playableOf({ ...can, h264: '51' })).toBeNull();
    expect(playableOf({ ...can, hevcMain: -1 })).toBeNull();
    expect(playableOf({ ...can, hdr: 1 })).toBeNull();
    expect(playableOf({ ...can, dolbyVision: undefined })).toBeNull();
    const { vp9: _vp9, ...missing } = can;
    expect(playableOf(missing)).toBeNull();
  });
});

describe('castReceiverOptIn', () => {
  it('is off until asked, kept once asked, and off again on `default`', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    } as Storage;
    expect(castReceiverOptIn('', storage)).toBe(false);
    expect(castReceiverOptIn('?cast-receiver=den', storage)).toBe(true);
    expect(castReceiverOptIn('?other=1', storage)).toBe(true);
    expect(castReceiverOptIn('?cast-receiver=default', storage)).toBe(false);
    expect(castReceiverOptIn('', storage)).toBe(false);
  });

  it('is off where storage is refused', () => {
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    expect(castReceiverOptIn('?cast-receiver=den', refusing)).toBe(false);
  });
});
