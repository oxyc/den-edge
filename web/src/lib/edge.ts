// Calls to den-edge, which serves this app from the same origin.

export type ClaimError = 'expired' | 'claimed' | 'throttled' | 'unreachable';
export type ClaimResult = { inboxKey: string } | { error: ClaimError };

/** Claim the code the TV shows under Settings › Linked devices, for the key the TV and this browser share. */
export async function claimCode(code: string, fetchImpl: typeof fetch = fetch): Promise<ClaimResult> {
  let res: Response;
  try {
    res = await fetchImpl('/link/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
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
