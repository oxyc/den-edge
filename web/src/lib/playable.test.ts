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
    const android = browser(
      () => true,
      async (video) => {
        asked.push(video);
        return true;
      },
    );
    expect(await playable(android)).toEqual({
      h264: 0x33,
      h264High10: 0x33,
      hevcMain: 153,
      hevcMain10: 153,
      hevcHighTier: 153,
      hdr: true,
      eac3: true,
      dolbyVision: { p5: true, p8: true },
      av1: 13,
      av1Main10: 13,
      av1Hdr: true,
    });
    expect(asked.map((v) => v.contentType)).toEqual([
      'video/mp4; codecs="hvc1.2.4.H153.B0"',
      'video/mp4; codecs="hvc1.2.4.L153.B0"',
      'video/mp4; codecs="av01.0.13M.10.0.110.09.16.09.0"',
      'video/mp4; codecs="dvh1.05.06"',
      'video/mp4; codecs="dvh1.08.06"',
    ]);
    expect(asked[1]).toMatchObject({ transferFunction: 'pq', width: 3840 });
  });

  it('gives Apple’s stack no High tier, whatever it answers', async () => {
    const iphone: Probe = {
      ...browser(
        () => true,
        async () => true,
      ),
      apple: true,
    };
    expect(await playable(iphone)).toMatchObject({ hevcMain10: 153, hevcHighTier: 0, hdr: true });
  });

  it('believes Media Capabilities over a type check that takes the High tier', async () => {
    const hopeful = browser(
      () => true,
      async (video) => !video.contentType.includes('.H'),
    );
    expect(await playable(hopeful)).toMatchObject({ hevcHighTier: 0, hdr: true });
  });

  it('gives no HEVC, and no HDR, to a browser without it', async () => {
    const firefox = browser(
      (codec) => codec.startsWith('avc1'),
      async () => true,
    );
    expect(await playable(firefox)).toEqual({
      h264: 0x33,
      h264High10: 0x33,
      hevcMain: 0,
      hevcMain10: 0,
      hevcHighTier: 0,
      hdr: false,
      eac3: false,
      dolbyVision: { p5: false, p8: false },
      av1: 0,
      av1Main10: 0,
      av1Hdr: false,
    });
  });

  it('finds AV1 as Chrome, Firefox and Safari answer, and asks Media Capabilities about PQ', async () => {
    const asked: VideoConfiguration[] = [];
    const chrome = browser(
      (codec) => codec.startsWith('avc1') || codec.startsWith('av01'),
      async (video) => {
        asked.push(video);
        return true;
      },
    );
    expect(await playable(chrome)).toMatchObject({ av1: 13, av1Main10: 13, av1Hdr: true });
    expect(asked.find((v) => v.contentType.includes('av01'))).toMatchObject({
      contentType: 'video/mp4; codecs="av01.0.13M.10.0.110.09.16.09.0"',
      transferFunction: 'pq',
      width: 3840,
      height: 2160,
    });
    // Firefox decodes AV1 and says no to PQ.
    const firefox = browser(
      (codec) => codec.startsWith('avc1.64') || codec.startsWith('av01'),
      async (video) => video.transferFunction !== 'pq',
    );
    expect(await playable(firefox)).toMatchObject({ av1: 13, av1Main10: 13, av1Hdr: false });
    // Safari on hardware without an AV1 decoder says no to the type, so nothing about it is asked.
    const safariAsked: VideoConfiguration[] = [];
    const oldSafari: Probe = {
      ...browser(
        (codec) => !codec.startsWith('av01') && !codec.startsWith('avc1.6E'),
        async (video) => {
          safariAsked.push(video);
          return true;
        },
      ),
      apple: true,
    };
    expect(await playable(oldSafari)).toMatchObject({ av1: 0, av1Main10: 0, av1Hdr: false });
    expect(safariAsked.some((v) => v.contentType.includes('av01'))).toBe(false);
    // Safari on hardware with one: its own answers, levels and all.
    const newSafari: Probe = {
      ...browser(
        (codec) => !codec.startsWith('avc1.6E') && !/^av01\.0\.13M/.test(codec),
        async () => true,
      ),
      apple: true,
    };
    expect(await playable(newSafari)).toMatchObject({ av1: 12, av1Main10: 12, av1Hdr: true });
  });

  it('asks about AV1 PQ at 1080p where 10-bit AV1 tops out there', async () => {
    const asked: VideoConfiguration[] = [];
    const phone = browser(
      (codec) => codec.startsWith('avc1') || /^av01\.0\.0[89]M/.test(codec),
      async (video) => {
        asked.push(video);
        return true;
      },
    );
    expect(await playable(phone)).toMatchObject({ av1: 9, av1Main10: 9, av1Hdr: true });
    expect(asked.find((v) => v.contentType.includes('av01'))).toMatchObject({
      contentType: 'video/mp4; codecs="av01.0.09M.10.0.110.09.16.09.0"',
      width: 1920,
      height: 1080,
    });
  });

  it('finds H.264 High 10, E-AC-3 and Dolby Vision as Safari, Chrome and Firefox answer', async () => {
    const safari: Probe = {
      ...browser(
        (codec) => !codec.startsWith('avc1.6E'),
        async () => true,
      ),
      apple: true,
    };
    expect(await playable(safari)).toMatchObject({
      h264: 0x33,
      h264High10: 0,
      eac3: true,
      dolbyVision: { p5: true, p8: true },
    });
    const chrome = browser(
      (codec) => codec.startsWith('avc1') || codec.startsWith('hvc1'),
      async () => true,
    );
    expect(await playable(chrome)).toMatchObject({
      h264High10: 0x33,
      hevcMain10: 153,
      eac3: false,
      dolbyVision: { p5: false, p8: false },
    });
    const firefox = browser(
      (codec) => codec.startsWith('avc1.64') || codec === 'mp4a.40.2',
      async () => true,
    );
    expect(await playable(firefox)).toMatchObject({
      h264: 0x33,
      h264High10: 0,
      eac3: false,
      dolbyVision: { p5: false, p8: false },
    });
  });

  it('believes Media Capabilities over a Dolby Vision type check, profile by profile', async () => {
    const hopeful = browser(
      () => true,
      async (video) => !video.contentType.includes('dvh1.05'),
    );
    expect((await playable(hopeful)).dolbyVision).toEqual({ p5: false, p8: true });
  });

  it('stops at the level the decoder tops out at', async () => {
    const levels = (codec: string) =>
      codec.startsWith('avc1') || /^hvc1\.1\.6\.L(93|120|123)\./.test(codec);
    expect(await playable(browser(levels))).toMatchObject({
      hevcMain: 123,
      hevcMain10: 0,
      hdr: false,
    });
  });

  it('takes 10-bit HEVC as HDR where it can’t ask, and a failed question as no', async () => {
    expect((await playable(browser(() => true))).hdr).toBe(true);
    const broken = browser(
      () => true,
      async () => Promise.reject(new TypeError('unsupported configuration')),
    );
    expect((await playable(broken)).hdr).toBe(false);
  });
});
