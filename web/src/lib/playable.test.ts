import { describe, expect, it } from 'vitest';
import { playable, type Probe } from './playable';

/** A browser that plays the codec strings `yes` accepts. */
const browser = (yes: (codec: string) => boolean, decodes?: Probe['decodes']): Probe => ({
  supports: (type) => yes(/codecs="([^"]+)"/.exec(type)![1]!),
  decodes,
});

describe('playable', () => {
  it('finds the highest level of each codec, and asks about the High tier and HDR', async () => {
    const asked: VideoConfiguration[] = [];
    const android = browser(() => true, async (video) => {
      asked.push(video);
      return true;
    });
    expect(await playable(android)).toEqual({ h264: 0x33, hevcMain: 153, hevcMain10: 153, hevcHighTier: 153, hdr: true });
    expect(asked.map((v) => v.contentType)).toEqual([
      'video/mp4; codecs="hvc1.2.4.H153.B0"',
      'video/mp4; codecs="hvc1.2.4.L153.B0"',
    ]);
    expect(asked[1]).toMatchObject({ transferFunction: 'pq', width: 3840 });
  });

  it('gives Apple’s stack no High tier, whatever it answers', async () => {
    const iphone: Probe = { ...browser(() => true, async () => true), apple: true };
    expect(await playable(iphone)).toMatchObject({ hevcMain10: 153, hevcHighTier: 0, hdr: true });
  });

  it('believes Media Capabilities over a type check that takes the High tier', async () => {
    const hopeful = browser(() => true, async (video) => !video.contentType.includes('.H'));
    expect(await playable(hopeful)).toMatchObject({ hevcHighTier: 0, hdr: true });
  });

  it('gives no HEVC, and no HDR, to a browser without it', async () => {
    const firefox = browser((codec) => codec.startsWith('avc1'), async () => true);
    expect(await playable(firefox)).toEqual({ h264: 0x33, hevcMain: 0, hevcMain10: 0, hevcHighTier: 0, hdr: false });
  });

  it('stops at the level the decoder tops out at', async () => {
    const levels = (codec: string) => codec.startsWith('avc1') || /^hvc1\.1\.6\.L(93|120|123)\./.test(codec);
    expect(await playable(browser(levels))).toMatchObject({ hevcMain: 123, hevcMain10: 0, hdr: false });
  });

  it('takes 10-bit HEVC as HDR where it can’t ask, and a failed question as no', async () => {
    expect((await playable(browser(() => true))).hdr).toBe(true);
    const broken = browser(() => true, async () => Promise.reject(new TypeError('unsupported configuration')));
    expect((await playable(broken)).hdr).toBe(false);
  });
});
