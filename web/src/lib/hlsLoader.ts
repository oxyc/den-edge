// The one hls.js module load shared by strong intent and the trailer that follows it.
//
// Keeping this behind a function preserves the route split: Home startup and hover import no playback code.
// A title pointerdown is strong enough intent to start the chunk, and the detail hero joins the same promise.

import { nativeHls } from './reel';

type HlsModule = typeof import('hls.js');

let loading: Promise<HlsModule> | undefined;

/** Load hls.js once. A failed speculative load may be tried again by the surface that actually needs it. */
export function loadHls(): Promise<HlsModule> {
  if (loading) return loading;
  const started = import('hls.js');
  loading = started;
  void started.catch(() => {
    if (loading === started) loading = undefined;
  });
  return started;
}

/** Start the split chunk on strong intent, only in browsers whose element cannot play HLS itself. */
export function warmHls(): void {
  if (nativeHls()) return;
  // Warming is optional. DetailMedia reports a failure if it still cannot load the module when needed.
  void loadHls().catch(() => {});
}
