// What this browser can decode, sent with every session so den-remux can tell whether a release plays here as it is
// or needs converting (oxyc/den-remux `playable`): the highest level it takes of H.264 (8-bit and High 10), 8-bit and
// 10-bit HEVC and 8-bit and 10-bit AV1, whether it decodes HDR (PQ) in HEVC and in AV1 and Dolby Vision, whether it
// plays Dolby Digital and FLAC audio as they are, whether it plays 5.1 and 7.1 AAC, and whether it decodes VP9.

export interface Playable {
  /** H.264's highest `level_idc` (0x33 is 5.1); 0 for none. */
  h264: number;
  /** H.264 High 10's highest `level_idc`, the 10-bit profile some anime encodes use; 0 for none. */
  h264High10: number;
  /** 8-bit HEVC's highest `general_level_idc` (level × 30: 153 is 5.1); 0 for none. */
  hevcMain: number;
  /** 10-bit HEVC's, which every HDR release is. */
  hevcMain10: number;
  /** HEVC's High tier, which a UHD Blu-ray remux often is. */
  hevcHighTier: number;
  hdr: boolean;
  /** Whether Dolby Digital Plus (E-AC-3) plays here. */
  eac3: boolean;
  /**
   * Whether 6-channel AAC-LC plays here, so den-remux converts a 5.1 or 7.1 track to AAC 5.1 rather than to stereo.
   * The browser downmixes it for stereo output, so saying yes costs a laptop's speakers nothing.
   */
  aacMultichannel: boolean;
  /**
   * Dolby Vision profiles: 5 has no HDR10 base layer, so a player without it shows wrong colours; 8 falls back to
   * HDR10 where it isn't decoded.
   */
  dolbyVision: { p5: boolean; p8: boolean };
  /**
   * 8-bit AV1's highest `seq_level_idx` at Main profile and tier (8 is level 4.0, 13 is 5.1); 0 for none. den-remux
   * only ever copies AV1, so a release beyond this isn't tried at all.
   */
  av1: number;
  /** 10-bit AV1's. */
  av1Main10: number;
  /** Whether 10-bit AV1 decodes in PQ. */
  av1Hdr: boolean;
  /** Whether FLAC plays here, so den-remux copies such a track instead of converting it to AAC. */
  flac: boolean;
  /**
   * Whether 8-channel AAC-LC plays here, so a converted track of eight channels or more stays 7.1 rather than
   * folding down to 5.1.
   */
  aac71: boolean;
  /**
   * Whether VP9 profile 0 (8-bit) decodes here. A boolean, not a level, because no service downstream has a level
   * field for VP9 — so a browser whose decoder tops out below a release's size still says yes, and den-remux copies
   * it (nothing on the box converts VP9). Asked at level 4.0, which any VP9 decoder answers for.
   */
  vp9: boolean;
  /** Whether VP9 profile 2 (10-bit) decodes here. */
  vp9Profile2: boolean;
}

/**
 * The same browser, less everything a refused session rested on: no HEVC at any tier, no HDR, no Dolby
 * Vision and no E-AC-3. What is left is H.264, SDR and AAC, which den-remux can always make of a release.
 *
 * A browser may claim a codec, take the playlist, and then refuse the very first segment — an iPhone does
 * exactly that. den-remux keeps a release the player can't take as the fallback it converts on the GPU, so
 * claiming less is what asks for that conversion.
 *
 * The sound goes with the picture because the error names neither. A `MediaError 3` on an initialization
 * segment says only that the player gave up, not which track it gave up on, so a refusal cannot be read as
 * being about the video alone and the retry must carry none of it forward. `eac3` and `flac` are the least
 * trustworthy claims of the set in any case: both come from a bare type check, and a type check says yes more
 * readily than a decoder does. `aacMultichannel` and `aac71` stay, because Media Capabilities was asked about
 * those properly — so the retry is converted rather than downmixed.
 *
 * VP9 stays for the same reason AV1 does: nothing on the box converts either, so a VP9 release is another
 * release's business rather than something this retry can ask for differently.
 *
 * Read a refusal on Apple's native player as weak evidence, though, and do not add guesses on the strength
 * of one. The failure that prompted this was not a decode failure at all: Apple's player abandons a slow
 * initialization segment after about five seconds and reports exactly this error, and den-remux was taking
 * six to produce one (`CoreMediaErrorDomain -12927`, `-12889 "No response for map"`). hls.js waits longer,
 * which is why the same release played in Chrome. This reducer is for genuine decode failures.
 */
export function withoutRefused(can: Playable): Playable {
  return {
    ...can,
    hevcMain: 0,
    hevcMain10: 0,
    hevcHighTier: 0,
    hdr: false,
    dolbyVision: { p5: false, p8: false },
    eac3: false,
    flac: false,
  };
}

/** Levels 3.1, 4.0, 4.1, 5.0 and 5.1: 720p up to 4K. */
const H264_LEVELS = [0x1f, 0x28, 0x29, 0x32, 0x33];
const HEVC_LEVELS = [93, 120, 123, 150, 153];
/** The High tier starts at level 4. */
const HEVC_HIGH_LEVELS = [120, 123, 150, 153];
/** AV1's `seq_level_idx` for levels 4.0, 4.1, 5.0 and 5.1: 1080p up to 4K. */
const AV1_LEVELS = [8, 9, 12, 13];
/** From 5.0 (`seq_level_idx` 12) a level holds 4K. */
const AV1_UHD_LEVEL = 12;
/**
 * VP9 at level 4.0 (1080p24) in profile 0 (8-bit) and profile 2 (10-bit). A VP9 codec string must name a level, and
 * what is reported is a boolean, so this asks at the lowest level worth playing rather than at the highest one.
 */
const VP9_PROFILE0 = 'vp09.00.40.08';
const VP9_PROFILE2 = 'vp09.02.40.10';

export interface Probe {
  /** Whether a `video/mp4; codecs=…` or `audio/mp4; codecs=…` type plays here. */
  supports: (type: string) => boolean;
  /** Media Capabilities' answer for a video configuration; absent where the browser has none. */
  decodes?: (video: VideoConfiguration) => Promise<boolean>;
  /** Its answer for an audio configuration; absent where the browser has none. */
  decodesAudio?: (audio: AudioConfiguration) => Promise<boolean>;
  /**
   * Apple's media stack: Safari, and every browser on an iPhone or iPad, which all run on WebKit and say so in
   * `navigator.vendor`. Its decoders refuse HEVC's High tier however the questions above are answered (The Hobbit's
   * remux failed to decode on an iPhone).
   */
  apple?: boolean;
}

export function browserProbe(): Probe {
  const element = document.createElement('video');
  const source =
    globalThis.MediaSource ??
    (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const capabilities = globalThis.navigator?.mediaCapabilities;
  const type = source ? 'media-source' : 'file';
  return {
    supports: (type) =>
      (source?.isTypeSupported(type) ?? false) || element.canPlayType(type) !== '',
    decodes: capabilities
      ? async (video) => (await capabilities.decodingInfo({ type, video })).supported
      : undefined,
    decodesAudio: capabilities
      ? async (audio) => (await capabilities.decodingInfo({ type, audio })).supported
      : undefined,
    apple: globalThis.navigator?.vendor?.startsWith('Apple') ?? false,
  };
}

export async function playable(probe: Probe = browserProbe()): Promise<Playable> {
  const highest = (levels: number[], codec: (level: number) => string) =>
    levels.filter((level) => probe.supports(`video/mp4; codecs="${codec(level)}"`)).at(-1) ?? 0;
  const hevcMain10 = highest(HEVC_LEVELS, (level) => `hvc1.2.4.L${level}.B0`);
  // A type check says yes to a High tier string more readily than a decoder does, so Media Capabilities still has
  // the last word below — but it is asked on Apple's stack now like anywhere else.
  //
  // This used to be a flat `probe.apple ? 0 : …`: no High tier for Safari or for any browser on iOS, whatever the
  // browser said. It was added for one release, a ~24 GB UHD remux an iPhone refused — and that refusal turned out
  // to be neither the tier nor the bitrate. den-remux was taking 4.1–6.6 s to write `init.mp4` and Apple's player
  // abandons one that slow, reporting it as a decode error (fixed in 0.19.0), and an HDR10 file whose container
  // named no colours was probed as SDR so the variant contradicted its own SPS (fixed in 0.20.0). The same title
  // then played on macOS Safari with its High-tier copy untouched.
  //
  // Measured since, with clips built for it (codec lab, 2026-09-16): 2160p High tier at 20, 40 and 60 Mbit/s
  // played in every path — file, Apple's own HLS player and hls.js — on an iPhone (iOS 18.7) and on macOS Safari
  // 18.6, nothing above 3.8% frames dropped. No ceiling was found, so there is no honest number to put here.
  // Sixty megabits is not eighty and six seconds is not a feature, so if a real remux still fails, the answer is
  // the retry that asks for less (oxyc/den#38) rather than refusing every High-tier release in advance.
  const highTier = highest(HEVC_HIGH_LEVELS, (level) => `hvc1.2.4.H${level}.B0`);
  const uhd = { width: 3840, height: 2160, bitrate: 40_000_000, framerate: 24 };
  const tierCodec = `video/mp4; codecs="hvc1.2.4.H${highTier}.B0"`;
  const hevcHighTier =
    highTier > 0 && (await decodes(probe, { contentType: tierCodec, ...uhd })) ? highTier : 0;
  const hdr =
    hevcMain10 > 0 &&
    (await decodes(probe, {
      contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
      ...uhd,
      transferFunction: 'pq',
      colorGamut: 'rec2020',
      hdrMetadataType: 'smpteSt2086',
    }));
  // AV1 comes from the type checks alone: a browser without a decoder for it (Safari on hardware that has none) says
  // no there. PQ is asked of Media Capabilities, at the size the highest 10-bit level holds and under the codec
  // string den-remux names an HDR10 release by.
  const av1Level = (level: number) => level.toString().padStart(2, '0');
  const av1 = highest(AV1_LEVELS, (level) => `av01.0.${av1Level(level)}M.08`);
  const av1Main10 = highest(AV1_LEVELS, (level) => `av01.0.${av1Level(level)}M.10`);
  const av1Size =
    av1Main10 >= AV1_UHD_LEVEL
      ? uhd
      : { width: 1920, height: 1080, bitrate: 10_000_000, framerate: 24 };
  const av1Hdr =
    av1Main10 > 0 &&
    (await decodes(probe, {
      contentType: `video/mp4; codecs="av01.0.${av1Level(av1Main10)}M.10.0.110.09.16.09.0"`,
      ...av1Size,
      transferFunction: 'pq',
      colorGamut: 'rec2020',
      hdrMetadataType: 'smpteSt2086',
    }));
  // Dolby Vision rides on 10-bit HEVC. Chrome says no to the type outright; where a browser says yes, Media
  // Capabilities is asked too, as it is for the High tier. Level 06 is 4K at 24 frames.
  const dolby = async (profile: string) => {
    const contentType = `video/mp4; codecs="dvh1.${profile}.06"`;
    return (
      hevcMain10 > 0 &&
      probe.supports(contentType) &&
      (await decodes(probe, { contentType, ...uhd }))
    );
  };
  return {
    h264: highest(H264_LEVELS, (level) => `avc1.6400${level.toString(16)}`),
    h264High10: highest(H264_LEVELS, (level) => `avc1.6E00${level.toString(16)}`),
    hevcMain: highest(HEVC_LEVELS, (level) => `hvc1.1.6.L${level}.B0`),
    hevcMain10,
    hevcHighTier,
    hdr,
    // One flag covers the Dolby Digital pair, because den-remux copies an AC-3 track on the strength of it just as it
    // copies an E-AC-3 one. A browser that takes only the newer of the two would be sent a track it plays as silence,
    // so both are asked and the flag means both.
    eac3: probe.supports('audio/mp4; codecs="ec-3"') && probe.supports('audio/mp4; codecs="ac-3"'),
    aacMultichannel: await decodesAudio(probe, {
      contentType: 'audio/mp4; codecs="mp4a.40.2"',
      channels: '6',
      samplerate: 48000,
    }),
    dolbyVision: { p5: await dolby('05'), p8: await dolby('08') },
    av1,
    av1Main10,
    av1Hdr,
    flac: probe.supports('audio/mp4; codecs="fLaC"'),
    aac71: await decodesAudio(probe, {
      contentType: 'audio/mp4; codecs="mp4a.40.2"',
      channels: '8',
      samplerate: 48000,
    }),
    // VP9 comes from the type checks alone, as AV1 does. Apple's stack is not special-cased here even though its own
    // player and hls.js disagree about VP9: den-remux knows which player a session uses and clears what that one
    // can't take, and this report has no way to say "in hls.js only".
    vp9: probe.supports(`video/mp4; codecs="${VP9_PROFILE0}"`),
    vp9Profile2: probe.supports(`video/mp4; codecs="${VP9_PROFILE2}"`),
  };
}

/** Media Capabilities' answer. A browser that can't be asked is taken at its type check's word. */
async function decodes(probe: Probe, video: VideoConfiguration): Promise<boolean> {
  if (!probe.decodes) return true;
  try {
    return await probe.decodes(video);
  } catch {
    return false;
  }
}

/**
 * Media Capabilities' answer for audio. Unlike video there is no type check to fall back on — every browser says yes
 * to `mp4a.40.2` whatever its channels — so a browser that can't be asked gets stereo.
 */
async function decodesAudio(probe: Probe, audio: AudioConfiguration): Promise<boolean> {
  if (!probe.decodesAudio) return false;
  try {
    return await probe.decodesAudio(audio);
  } catch {
    return false;
  }
}
