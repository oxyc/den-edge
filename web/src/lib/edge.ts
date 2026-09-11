// Calls to den-edge, which serves this app from the same origin.

export type ClaimError = 'expired' | 'claimed' | 'throttled' | 'unreachable';
export type ClaimResult = { inboxKey: string } | { error: ClaimError };

/**
 * What this device is, as the TV's list of linked devices shows it: "Mac · Chrome". iPadOS asks for desktop
 * sites with a Mac's user agent, so an iPad is told apart by its touch screen. Browsers don't tell a MacBook
 * from an iMac.
 */
export function deviceLabel(nav: { userAgent: string; maxTouchPoints?: number } = navigator): string {
  const ua = nav.userAgent;
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? 'Android phone'
          : 'Android tablet'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /CrOS/.test(ua)
            ? 'Chromebook'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux PC'
                : '';
  // Edge and Chrome on iOS carry Chrome's and Safari's tokens too, so the rarer ones are checked first.
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return [platform, browser].filter(Boolean).join(' · ') || 'Browser';
}

/** Tell a linked TV what this device is, so its list of linked devices names it. The TV keeps the latest. */
export async function announceDevice(
  inboxKey: string,
  device: string = deviceLabel(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/inbox/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-den-link': inboxKey },
      body: JSON.stringify({ message: { type: 'device', name: device } }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
