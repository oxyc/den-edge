/** How long to wait for the home network to answer before the public address is used instead. */
export const LAN_PROBE_MS = 2_500;

/**
 * Whether the home-network den-remux answers from here. On home Wi-Fi it does, and the public address does not (the
 * router never loops a request for it back in); anywhere else the name resolves to a private address that nothing
 * answers, so this fails fast and the public address is used.
 *
 * `no-cors` because den-remux's health answer carries no CORS headers for this origin: a response of any kind, opaque
 * or not, proves the name resolves, the address is reachable, and the TLS handshake succeeded, which needs a
 * certificate for our own zone, so another device on someone else's 192.168.x.x network cannot pass for it.
 */
export async function lanReachable(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LAN_PROBE_MS,
): Promise<boolean> {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(new URL('/remux/health', url).href, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
