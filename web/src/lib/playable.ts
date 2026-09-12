// What this browser can decode, sent with every session so den-remux can tell whether a release plays here as it is
// or needs converting (oxyc/den-remux `playable`): the highest level it takes of H.264, 8-bit and 10-bit HEVC, and
// whether it decodes HDR (PQ).

export interface Playable {
  /** H.264's highest `level_idc` (0x33 is 5.1); 0 for none. */
  h264: number;
  /** 8-bit HEVC's highest `general_level_idc` (level × 30: 153 is 5.1); 0 for none. */
  hevcMain: number;
  /** 10-bit HEVC's, which every HDR release is. */
  hevcMain10: number;
  /** HEVC's High tier, which a UHD Blu-ray remux often is. */
  hevcHighTier: number;
  hdr: boolean;
}

/** Levels 3.1, 4.0, 4.1, 5.0 and 5.1: 720p up to 4K. */
const H264_LEVELS = [0x1f, 0x28, 0x29, 0x32, 0x33];
const HEVC_LEVELS = [93, 120, 123, 150, 153];
/** The High tier starts at level 4. */
const HEVC_HIGH_LEVELS = [120, 123, 150, 153];

export interface Probe {
  /** Whether a `video/mp4; codecs=…` type plays here. */
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
  return {
    h264: highest(H264_LEVELS, (level) => `avc1.6400${level.toString(16)}`),
    hevcMain: highest(HEVC_LEVELS, (level) => `hvc1.1.6.L${level}.B0`),
    hevcMain10,
    hevcHighTier:
      highTier > 0 && (await decodes(probe, { contentType: tierCodec, ...uhd })) ? highTier : 0,
    hdr:
      hevcMain10 > 0 &&
      (await decodes(probe, {
        contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
        ...uhd,
        transferFunction: 'pq',
        colorGamut: 'rec2020',
        hdrMetadataType: 'smpteSt2086',
      })),
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
