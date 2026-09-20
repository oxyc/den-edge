// Offering Cast from the plain in-page player.

/**
 * Whether this browser could cast at all. Google's Cast web SDK exists only in desktop and Android Chromium; every
 * iOS browser is WebKit underneath (which has AirPlay instead), and Firefox and Safari have no Cast sender. A browser
 * that passes this can still find no receiver, which the cast page reports once it has looked.
 */
export function canOfferCast(ua: string = globalThis.navigator?.userAgent ?? ''): boolean {
  if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return /\b(?:Chrome|Chromium)\//.test(ua);
}

/** How long the cast page has to say a receiver is on the network before it is taken that none is. */
export const CAST_DISCOVERY_MS = 6_000;
