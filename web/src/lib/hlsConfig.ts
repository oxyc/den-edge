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
 *
 * The buffer is deep enough to ride out a connection that drops for half a minute: two minutes ahead, where hls.js
 * holds thirty by default. Its size cap is Chromium's own for one video SourceBuffer, 150 MB — asking for more only
 * ends in a `bufferFullError` — which is two minutes of a 10 Mbit/s film. A minute behind the play head is kept for a
 * seek back and then let go. Only desktop and Android browsers take this path: Apple's play HLS natively
 * (`nativeHls`), so no phone short of memory is asked to hold it. A Cast receiver (`receiver`) is: a Chromecast has
 * a few hundred MB for everything, so it holds a minute or 50 MB ahead and ten seconds behind. den-remux weighs a
 * release against the same numbers for each (`buffer_of`), so change them together.
 */
export function hlsConfig(
  startPosition?: number,
  player: 'page' | 'receiver' = 'page',
): Partial<HlsConfig> {
  const receiver = player === 'receiver';
  return {
    enableWorker: false,
    startPosition: startPosition ?? -1,
    maxBufferLength: receiver ? 60 : 120,
    maxBufferSize: (receiver ? 50 : 150) * 1000 * 1000,
    backBufferLength: receiver ? 10 : 60,
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
