/** An IPv4 literal in one of RFC 1918's private ranges. */
export function privateIPv4(host: string): boolean {
  const labels = host.split('.');
  if (
    labels.length !== 4 ||
    !labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255)
  )
    return false;
  const [a = -1, b = -1] = labels.map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** A host another device on this LAN may reach. Loopback is deliberately not included. */
export function privateLanHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return (lower.endsWith('.local') && lower !== 'localhost.local') || privateIPv4(lower);
}

/** A local host this browser may reach, including its own loopback interface. */
export function localHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return (
    lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]' || privateLanHost(lower)
  );
}

/** A credential-free HTTP URL whose destination is another device-reachable host on this LAN. */
export function privateLanHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      privateLanHost(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const SIGNED_REMUX_PLAYLIST = /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/master\.m3u8$/;

/** The only private HTTP capability the Cast path may receive. */
export function privateLanRemuxPlaylist(value: string): boolean {
  if (!privateLanHttpURL(value)) return false;
  const url = new URL(value);
  return !url.search && SIGNED_REMUX_PLAYLIST.test(url.pathname);
}

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

/**
 * Chrome Local Network Access uses this hint to classify an explicitly local destination before the request.
 * Browsers which do not implement it ignore the dictionary member.
 */
export function localRequest(init: RequestInit = {}): RequestInit {
  return { ...init, targetAddressSpace: 'local' } as RequestInit;
}
