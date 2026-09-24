// Which HLS player plays a den-remux session in this browser: shared by the player and the cast page, which must
// choose alike — the cast page is how a browser away from home plays.

/**
 * Whether to hand a playlist to the `<video>` element itself rather than to hls.js. Apple's WebKit — Safari, and every
 * browser on an iPhone — plays it natively, with AirPlay and picture-in-picture. Chrome answers `canPlayType` for HLS
 * too now (151 says "maybe"), but its own player fetched den-remux's master and media playlists and never asked for a
 * segment, so wherever Media Source Extensions exist outside WebKit, hls.js plays instead.
 */
export function nativeHls(
  element: Pick<HTMLMediaElement, 'canPlayType'>,
  env: { vendor?: string; mse?: boolean } = {
    vendor: globalThis.navigator?.vendor,
    mse: 'MediaSource' in globalThis || 'ManagedMediaSource' in globalThis,
  },
): boolean {
  if (!element.canPlayType('application/vnd.apple.mpegurl')) return false;
  return (env.vendor ?? '').startsWith('Apple') || !env.mse;
}
