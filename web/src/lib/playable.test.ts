import { describe, expect, it } from 'vitest';
import { playable, withoutRefused, type Probe } from './playable';

/** A browser that plays the codec strings `yes` accepts. */
const browser = (
  yes: (codec: string) => boolean,
  decodes?: Probe['decodes'],
  decodesAudio?: Probe['decodesAudio'],
): Probe => ({
  supports: (type) => yes(/codecs="([^"]+)"/.exec(type)![1]!),
  decodes,
  decodesAudio,
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
      async () => true,
    );
    expect(await playable(android)).toEqual({
      h264: 0x33,
      h264High10: 0x33,
      hevcMain: 153,
      hevcMain10: 153,
      hevcHighTier: 153,
      hdr: true,
      eac3: true,
      aacMultichannel: true,
      dolbyVision: { p5: true, p8: true },
      av1: 13,
      av1Main10: 13,
      av1Hdr: true,
      flac: true,
      aac71: true,
      vp9: true,
      vp9Profile2: true,
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

  it('offers Apple’s stack the High tier when its own decoder takes it', async () => {
    const iphone: Probe = {
      ...browser(
        () => true,
        async () => true,
      ),
      apple: true,
    };
    // Refused outright until 2026-09-16, whatever the browser said, on the evidence of one UHD remux an iPhone
    // would not play — a refusal later traced to a slow initialization segment and to colour tags read from a
    // container that named none, both fixed in den-remux. Measured since at 20, 40 and 60 Mbit/s on an iPhone
    // and on macOS Safari: 2160p High tier plays in every path (oxyc/den#36). Media Capabilities still has the
    // last word, here as on any other stack — this probe answers yes to it.
    expect(await playable(iphone)).toMatchObject({ hevcMain10: 153, hevcHighTier: 153, hdr: true });
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
      aacMultichannel: false,
      dolbyVision: { p5: false, p8: false },
      av1: 0,
      av1Main10: 0,
      av1Hdr: false,
      flac: false,
      aac71: false,
      vp9: false,
      vp9Profile2: false,
    });
  });

  it('asks Media Capabilities about 5.1 AAC, and takes stereo where it can’t ask or it fails', async () => {
    const asked: AudioConfiguration[] = [];
    const chrome = browser(
      () => true,
      async () => true,
      async (audio) => {
        asked.push(audio);
        return true;
      },
    );
    expect((await playable(chrome)).aacMultichannel).toBe(true);
    expect(asked).toEqual([
      { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: '6', samplerate: 48000 },
      { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: '8', samplerate: 48000 },
    ]);
    const stereoOnly = browser(
      () => true,
      async () => true,
      async (audio) => audio.channels !== '6',
    );
    expect((await playable(stereoOnly)).aacMultichannel).toBe(false);
    expect((await playable(browser(() => true))).aacMultichannel, 'nothing to ask').toBe(false);
    const broken = browser(
      () => true,
      async () => true,
      async () => Promise.reject(new TypeError('unsupported configuration')),
    );
    expect((await playable(broken)).aacMultichannel).toBe(false);
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

  it('takes the Dolby Digital pair together, because one flag copies both', async () => {
    expect((await playable(browser((codec) => codec === 'ec-3' || codec === 'ac-3'))).eac3).toBe(
      true,
    );
    // A browser with only the newer of the two would be copied an AC-3 track it plays as silence.
    expect((await playable(browser((codec) => codec === 'ec-3'))).eac3).toBe(false);
    expect((await playable(browser((codec) => codec === 'ac-3'))).eac3).toBe(false);
  });

  it('asks Media Capabilities about 7.1 AAC, and folds to 5.1 where it can’t ask', async () => {
    expect((await playable(browser(() => true))).aac71, 'nothing to ask').toBe(false);
    const upTo51 = browser(
      () => true,
      async () => true,
      async (audio) => audio.channels !== '8',
    );
    expect((await playable(upTo51)).aac71).toBe(false);
    expect((await playable(upTo51)).aacMultichannel).toBe(true);
  });

  it('reads FLAC and VP9 off the type checks, and asks VP9 at level 4.0 in both profiles', async () => {
    const asked: string[] = [];
    const chrome = browser((codec) => {
      asked.push(codec);
      return true;
    });
    expect(await playable(chrome)).toMatchObject({ flac: true, vp9: true, vp9Profile2: true });
    expect(asked).toContain('fLaC');
    expect(asked).toContain('vp09.00.40.08');
    expect(asked).toContain('vp09.02.40.10');
    // Apple's stack is not special-cased, unlike the HEVC High tier: its own player and hls.js disagree about VP9,
    // and this report has no way to say "in hls.js only", so den-remux clears the pair for the sessions its own
    // player plays.
    const safari: Probe = {
      ...browser(
        () => true,
        async () => true,
      ),
      apple: true,
    };
    expect(await playable(safari)).toMatchObject({ vp9: true, vp9Profile2: true });
    // A browser with no VP9 decoder says no to the type, and nothing infers it from anything else.
    const noVp9 = browser((codec) => !codec.startsWith('vp09'));
    expect(await playable(noVp9)).toMatchObject({ vp9: false, vp9Profile2: false, flac: true });
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

describe('withoutRefused', () => {
  it('drops every claim a refusal disproved, sound included, and keeps the rest', async () => {
    const iphone: Probe = {
      ...browser(
        () => true,
        async () => true,
      ),
      apple: true,
    };
    const claimed = await playable(iphone);
    expect(claimed).toMatchObject({
      hevcMain10: 153,
      hdr: true,
      dolbyVision: { p5: true, p8: true },
    });

    const cut = withoutRefused(claimed);
    expect(cut).toMatchObject({
      hevcMain: 0,
      hevcMain10: 0,
      hevcHighTier: 0,
      hdr: false,
      dolbyVision: { p5: false, p8: false },
    });
    // H.264 stays, because it is what den-remux converts a refused release into.
    expect(cut.h264).toBe(claimed.h264);
    // E-AC-3 goes with it. An iPhone refused a 4K HDR HEVC copy and then refused the 1080p H.264
    // conversion of it identically, and the one thing both sessions shared was a copied E-AC-3 track — so a
    // refusal cannot be read as being about the picture alone.
    expect(cut.eac3).toBe(false);
    // AAC stays, so that retry is converted rather than downmixed to stereo.
    expect(cut.aacMultichannel).toBe(claimed.aacMultichannel);
    // AV1 too: den-remux only ever copies it, so it is another release's business, not this one's.
    expect(cut.av1).toBe(claimed.av1);
    // VP9 goes the same way as AV1, and for the same reason: nothing on the box converts it either.
    expect(cut.vp9).toBe(claimed.vp9);
    expect(cut.vp9Profile2).toBe(claimed.vp9Profile2);
    // FLAC goes with E-AC-3: both rest on a bare type check, and the refusal named no track.
    expect(cut.flac).toBe(false);
    // 7.1 AAC stays for the reason 5.1 does — Media Capabilities was asked about it properly.
    expect(cut.aac71).toBe(claimed.aac71);

    // The claims themselves are untouched, so the next title is still asked as the browser it really is.
    expect(claimed.hevcMain10).toBe(153);
    expect(claimed.hdr).toBe(true);
  });
});
