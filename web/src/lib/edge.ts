// Calls to den-edge, which serves this app from the same origin.

export type ClaimError = 'expired' | 'claimed' | 'throttled' | 'unreachable';
export type ClaimResult = { inboxKey: string } | { error: ClaimError };

/**
 * What this device is, as the TV's list of linked devices shows it. iPadOS asks for desktop sites with a Mac's
 * user agent, so an iPad is told apart by its touch screen.
 */
export function deviceLabel(nav: { userAgent: string; maxTouchPoints?: number } = navigator): string {
  const ua = nav.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Browser';
}

/** Claim the code the TV shows under Settings › Linked devices, for the key the TV and this browser share. */
export async function claimCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
  device: string = deviceLabel(),
): Promise<ClaimResult> {
  let res: Response;
  try {
    res = await fetchImpl('/link/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), device }),
    });
  } catch {
    return { error: 'unreachable' };
  }
  switch (res.status) {
    case 200: {
      const body: unknown = await res.json().catch(() => null);
      const key = (body as { inboxKey?: unknown } | null)?.inboxKey;
      return typeof key === 'string' && /^[0-9a-f]{16,}$/i.test(key) ? { inboxKey: key } : { error: 'unreachable' };
    }
    case 410:
      return { error: 'expired' };
    case 409:
      return { error: 'claimed' };
    case 429:
      return { error: 'throttled' };
    default:
      return { error: 'unreachable' };
  }
}
