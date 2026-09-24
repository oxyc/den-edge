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

/**
 * How long a session in the cast page may show nothing before the viewer is taken back to the player they left — or,
 * away from home where the cast page is the player, told it failed. Room for what the cast page does before it plays:
 * the home-network check, a link measure (two tries of ten seconds) and the wait after it.
 */
export const CAST_PLAY_MS = 45_000;

/**
 * Where a press of Cast stands: `idle` before one and once a receiver was found, `looking` while the cast page looks
 * for a receiver (the video in the page plays on meanwhile), `none` when it found none in time.
 */
export type CastOffer = 'idle' | 'looking' | 'none';

export type CastLook =
  /** The cast page's answer: whether the Cast SDK sees a receiver right now. */
  | { kind: 'availability'; available: boolean }
  /** CAST_DISCOVERY_MS passed with no receiver seen. */
  | { kind: 'deadline' }
  /** There is no cast page to ask: casting is off on this box, or `/config` could not be read. */
  | { kind: 'no-cast-page' };

/**
 * What a step of the look for a receiver comes to, and whether playback moves to the cast page now.
 *
 * Only a receiver seen moves anything. "No devices" is not final while looking: the Cast SDK starts out saying so
 * and changes its mind once discovery has run, so a no is only taken at the deadline.
 */
export function castLook(offer: CastOffer, event: CastLook): { offer: CastOffer; move: boolean } {
  if (offer !== 'looking') return { offer, move: false };
  if (event.kind === 'availability')
    return event.available ? { offer: 'idle', move: true } : { offer, move: false };
  return { offer: 'none', move: false };
}

/**
 * Whether a cast-page session that failed takes the viewer back to the player they left, rather than being retried
 * there as a conversion: when playback was moved there to cast (`offered`) and no receiver is playing it. A receiver's
 * own failure keeps its one conservative retry.
 */
export function returnsFromCast(offered: boolean, castMode: boolean): boolean {
  return offered && !castMode;
}

/** The cast page's origin from den-edge's `/config`: a bare https origin, or null where casting is off. */
export async function fetchCastOrigin(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/config', { signal: AbortSignal.timeout(CAST_DISCOVERY_MS) });
    if (!res.ok) {
      console.warn(`Cast: /config answered ${res.status}`);
      return null;
    }
    const origin = ((await res.json()) as { castOrigin?: unknown }).castOrigin;
    if (typeof origin !== 'string') return null;
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin ? origin : null;
  } catch (error) {
    console.warn('Cast: the cast page could not be found', error);
    return null;
  }
}
