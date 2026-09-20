// How hls.js is set up for a den-remux session, shared by the player and by the cast page's own player so the two
// tolerate the same things.

import type { HlsConfig } from 'hls.js';

/**
 * `startPosition` is where playback begins, in seconds; undefined lets hls.js use the playlist's start, or the
 * beginning (-1 is its own default).
 *
 * den-remux converts on the GPU as the player asks for segments, so the first one of a transcoded release can take
 * far longer to answer than a copied one. hls.js gives up on a segment about ten seconds late and by default doesn't
 * retry a timeout at all, which turns a slow conversion into a dead session. Wait through it instead, and retry twice
 * before calling it broken.
 */
export function hlsConfig(startPosition?: number): Partial<HlsConfig> {
  return {
    enableWorker: false,
    startPosition: startPosition ?? -1,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 30_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 2, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
      },
    },
  };
}
