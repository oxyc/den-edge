import { playable, type Playable, type Probe } from '../../src/lib/playable';
import type { ReceiverReport } from '../../src/lib/castReceiver';

/**
 * `CastReceiverContext.canDisplayType`, asked with one full type string: the codec, and for a picture the size, frame
 * rate and transfer function (`eotf`), so the answer covers the TV the Chromecast is plugged into, not its decoder
 * alone.
 */
export type CanDisplayType = (type: string) => boolean;

function videoType(video: VideoConfiguration): string {
  const eotf =
    video.transferFunction === 'pq'
      ? '; eotf=smpte2084'
      : video.transferFunction === 'hlg'
        ? '; eotf=arib-std-b67'
        : '';
  return `${video.contentType}; width=${video.width}; height=${video.height}; framerate=${video.framerate}${eotf}`;
}

/**
 * The same questions `playable()` asks a browser, put to the receiver. Media Capabilities' part is canDisplayType with
 * the size and transfer function. There is no audio part, so AAC stays stereo, as Den's model profiles have it.
 */
export function receiverProbe(canDisplayType: CanDisplayType): Probe {
  const ask = (type: string) => {
    try {
      return canDisplayType(type) === true;
    } catch {
      return false;
    }
  };
  return { supports: ask, decodes: (video) => Promise.resolve(ask(videoType(video))) };
}

/**
 * What this receiver's TV plays, as the `playable` a browser reports, so Hearth's receiver filter reads it unchanged.
 * AV1 and VP9 stay off as in the model profiles: the TV taking them says nothing yet of the receiver taking them in
 * Den's HLS/fMP4, which has not been tried on a Chromecast.
 */
export async function receiverReport(canDisplayType: CanDisplayType): Promise<ReceiverReport> {
  const probe = receiverProbe(canDisplayType);
  const can: Playable = await playable(probe);
  const sized = (codec: string, width: number, height: number, framerate: number, eotf = '') =>
    probe.supports(
      `video/mp4; codecs="${codec}"; width=${width}; height=${height}; framerate=${framerate}${eotf}`,
    );
  const uhd = sized('hev1.2.6.L150.B0', 3840, 2160, 30) || sized('avc1.640033', 3840, 2160, 30);
  const height = uhd ? 2160 : sized('avc1.64002A', 1920, 1080, 30) ? 1080 : 720;
  const width = height === 2160 ? 3840 : height === 1080 ? 1920 : 1280;
  return {
    type: 'den-capabilities',
    playable: { ...can, av1: 0, av1Main10: 0, av1Hdr: false, vp9: false, vp9Profile2: false },
    details: {
      maxWidth: width,
      maxHeight: height,
      maxFramerate: sized('avc1.64002A', width, height, 60) ? 60 : 30,
      hdr10: sized('hev1.2.6.L150.B0', 3840, 2160, 30, '; eotf=smpte2084'),
      hlg: sized('hev1.2.6.L150.B0', 3840, 2160, 30, '; eotf=arib-std-b67'),
      ac3: probe.supports('audio/mp4; codecs="ac-3"'),
      eac3: probe.supports('audio/mp4; codecs="ec-3"'),
      av1: can.av1,
      vp9: can.vp9,
    },
  };
}
