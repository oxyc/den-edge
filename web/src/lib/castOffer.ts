// Offering Cast from the plain in-page player.

import { clientFailureErrorClass, reportClientFailure } from './diagnosticsReport';

/**
 * Whether this browser could cast at all. Google's Cast web SDK exists only in desktop and Android Chromium; every
 * iOS browser is WebKit underneath (which has AirPlay instead), and Firefox and Safari have no Cast sender. A browser
 * that passes this can still find no receiver: the cast page's button shows only once it has found one.
 */
export function canOfferCast(ua: string = globalThis.navigator?.userAgent ?? ''): boolean {
  if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return /\b(?:Chrome|Chromium)\//.test(ua);
}

/** How long `/config` may take to name the cast page before casting is taken to be off. */
export const CAST_CONFIG_MS = 6_000;

/**
 * Where Cast stands, as the cast page's SDK says (`CastContext.getCastState`): `none` while no receiver is on the
 * network (and wherever there is no Cast SDK), `available` once one is, then `connecting` and `connected`.
 */
export type CastState = 'none' | 'available' | 'connecting' | 'connected';

export function castStateOf(sdkState: unknown): CastState {
  return sdkState === 'CONNECTED'
    ? 'connected'
    : sdkState === 'CONNECTING'
      ? 'connecting'
      : sdkState === 'NOT_CONNECTED'
        ? 'available'
        : 'none';
}

/**
 * What a Cast session that did not start says, from the SDK's error code (`chrome.cast.ErrorCode`): a receiver that
 * went away between the list and the press, or one that did not answer. Never the code itself.
 */
export function castFailureNotice(code: unknown): string {
  return code === 'receiver_unavailable'
    ? 'No Chromecast found on this network. Check that it is on and on the same Wi-Fi, then press Cast to try again.'
    : 'Couldn’t connect to the Chromecast. Press Cast to try again.';
}

/**
 * How long a session in the cast page may show nothing before the viewer is taken back to the player they left — or,
 * away from home where the cast page is the player, told it failed. Room for what the cast page does before it plays:
 * the home-network check, a link measure (two tries of ten seconds) and the wait after it.
 */
export const CAST_PLAY_MS = 45_000;

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
    const res = await fetchImpl('/config', { signal: AbortSignal.timeout(CAST_CONFIG_MS) });
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
    reportClientFailure({
      operation: 'cast',
      kind: 'transport',
      outcome: 'terminal',
      route: 'cast_config',
      errorClass: clientFailureErrorClass(error),
    });
    return null;
  }
}
