// What this browser can decode, sent with every session so den-remux can tell whether a release plays here as it is
// or needs converting (oxyc/den-remux `playable`): the highest level it takes of H.264 (8-bit and High 10), 8-bit and
// 10-bit HEVC and 8-bit and 10-bit AV1, whether it decodes HDR (PQ) in HEVC and in AV1 and Dolby Vision, and whether
// it plays E-AC-3 audio as it is.

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

export interface Probe {
  /** Whether a `video/mp4; codecs=…` or `audio/mp4; codecs=…` type plays here. */
  supports: (type: string) => boolean;
  /** Media Capabilities' answer for a video configuration; absent where the browser has none. */
  decodes?: (video: VideoConfiguration) => Promise<boolean>;
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
  return {
    supports: (type) =>
      (source?.isTypeSupported(type) ?? false) || element.canPlayType(type) !== '',
    decodes: capabilities
      ? async (video) =>
          (await capabilities.decodingInfo({ type: source ? 'media-source' : 'file', video }))
            .supported
      : undefined,
    apple: globalThis.navigator?.vendor?.startsWith('Apple') ?? false,
  };
}

export async function playable(probe: Probe = browserProbe()): Promise<Playable> {
  const highest = (levels: number[], codec: (level: number) => string) =>
    levels.filter((level) => probe.supports(`video/mp4; codecs="${codec(level)}"`)).at(-1) ?? 0;
  const hevcMain10 = highest(HEVC_LEVELS, (level) => `hvc1.2.4.L${level}.B0`);
  // A type check says yes to a High tier string more readily than a decoder does, so Media Capabilities has the
  // last word where there is one — and on Apple's stack the answer is no regardless.
  const highTier = probe.apple ? 0 : highest(HEVC_HIGH_LEVELS, (level) => `hvc1.2.4.H${level}.B0`);
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
    eac3: probe.supports('audio/mp4; codecs="ec-3"'),
    dolbyVision: { p5: await dolby('05'), p8: await dolby('08') },
    av1,
    av1Main10,
    av1Hdr,
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
