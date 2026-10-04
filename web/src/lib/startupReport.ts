// den-edge#234's step 0: a browser's own record of how long a session took to start, sent once its first frame
// renders — to den-edge (`POST /playback/startup`, same-origin: the page den-edge itself serves), not to
// den-remux, so it lands in a request log an operator can actually read. The body carries durations, a size
// bucket, the codec, whether it was transcoded, the player engine, which kind of address was used, and — gated
// by den-edge's own `LOG_IDENTITY` switch, never asked here — the identity fields (`diagnosticsReport.ts`).

import type { IdentityFields } from './diagnosticsReport';

export interface ServerTiming {
  resolveMs?: number;
  openMs?: number;
  /** How many releases were tried before one opened (`open`'s `desc="<n> tried"`). */
  tried?: number;
  initMs?: number;
}

/**
 * den-remux's `Server-Timing` header on the session POST (`resolve;dur=12,open;dur=34;desc="3 tried",init;dur=56`),
 * read back. Absent fields rather than zeroes for whatever a header doesn't carry — an older den-remux, or no
 * native-player `init` stretch.
 */
export function parseServerTiming(header: string | null | undefined): ServerTiming {
  const out: ServerTiming = {};
  if (!header) return out;
  for (const entry of header.split(',')) {
    const params = entry.split(';').map((p) => p.trim());
    const name = params[0];
    const dur = params.find((p) => p.startsWith('dur='))?.slice('dur='.length);
    const ms = dur !== undefined ? Number(dur) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (name === 'resolve') out.resolveMs = Math.round(ms);
    else if (name === 'open') {
      out.openMs = Math.round(ms);
      const desc = params
        .find((p) => p.startsWith('desc='))
        ?.slice('desc='.length)
        .replace(/^"|"$/g, '');
      const tried = Number(desc?.split(' ')[0]);
      if (Number.isFinite(tried)) out.tried = tried;
    } else if (name === 'init') out.initMs = Math.round(ms);
  }
  return out;
}

export type SizeBucket = 'small' | 'medium' | 'large' | 'xlarge';

/** den-edge#234's buckets: under 5 GB, 5–20, 20–50, 50 and up. Never the release's actual byte count. */
export function sizeBucket(bytes: number | null | undefined): SizeBucket {
  const gb = (bytes ?? 0) / 1024 ** 3;
  if (gb < 5) return 'small';
  if (gb < 20) return 'medium';
  if (gb < 50) return 'large';
  return 'xlarge';
}

export type KnownCodec = 'h264' | 'hevc' | 'av1' | 'vp9';
const KNOWN_CODECS: readonly KnownCodec[] = ['h264', 'hevc', 'av1', 'vp9'];

/** den-remux's own `video.codec`, narrowed to the allowlisted shape den-edge's `startup.rs` requires; anything
 * else it hasn't named yet falls back to `h264` rather than failing to send a report at all. */
export function knownCodec(codec: string | undefined): KnownCodec {
  return KNOWN_CODECS.includes(codec as KnownCodec) ? (codec as KnownCodec) : 'h264';
}

export interface StartupReport extends ServerTiming, IdentityFields {
  sessionMs: number;
  firstSegmentMs: number;
  firstFrameMs: number;
  /** Absent on native HLS: no loader there to read a byte count from. */
  bytesLoaded?: number;
  size: SizeBucket;
  codec: KnownCodec;
  transcoded: boolean;
  player: 'native' | 'hls.js';
  route: 'lan' | 'public' | 'tailnet';
}

/** Fire-and-forget: the next session's report carries whatever this one didn't need retrying for. */
export function sendStartupReport(report: StartupReport, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl('/playback/startup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => undefined);
}
