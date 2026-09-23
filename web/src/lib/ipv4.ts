// The media address a public remux session plays from is IPv4 only, so a browser den-edge sees over IPv6 fetches it
// from an IPv4 address den-edge never sees. Told that address (`ipv4Hint` on `POST /remux/session`), den-edge opens
// the media listener for it alone rather than to everyone. Nothing but the address is asked for or sent.

/**
 * Cloudflare's trace on an IP literal: reached over IPv4 by construction, with no DNS to steer it. Some networks
 * intercept 1.1.1.1, and a middlebox answering for it reports its own view of the address — which is what the
 * player's one retry without the hint is for (`retryWithoutHint`).
 */
const TRACE = 'https://1.1.1.1/cdn-cgi/trace';
/** The fallback: ipify's IPv4-only name (it has no AAAA record). */
const IPIFY = 'https://api.ipify.org?format=json';
/** The whole lookup, both tries: a session start never waits longer than this for it. */
const TIMEOUT_MS = 1_500;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

/** The address in a Cloudflare trace (`ip=…` on a line of its own) when it is IPv4. */
export function traceAddress(text: string): string | undefined {
  const ip = text
    .split('\n')
    .find((line) => line.startsWith('ip='))
    ?.slice(3)
    .trim();
  return ip && IPV4.test(ip) ? ip : undefined;
}

/** The address in ipify's JSON answer when it is IPv4. */
export function ipifyAddress(body: unknown): string | undefined {
  const ip = (body as { ip?: unknown } | null)?.ip;
  return typeof ip === 'string' && IPV4.test(ip) ? ip : undefined;
}

/** This browser's IPv4 address as the internet sees it, or undefined on any failure or after `timeoutMs`. */
export function lookupIpv4(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const ask = async (url: string, read: (res: Response) => Promise<string | undefined>) => {
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      return res.ok ? await read(res) : undefined;
    } catch {
      return undefined;
    }
  };
  const lookup = (async () =>
    (await ask(TRACE, async (res) => traceAddress(await res.text()))) ??
    (await ask(IPIFY, async (res) => ipifyAddress(await res.json()))))();
  return Promise.race([lookup, deadline]).finally(() => clearTimeout(timer));
}

let asked: Promise<string | undefined> | undefined;

/** `lookupIpv4`, asked once per page load. */
export function ipv4Hint(fetchImpl?: typeof fetch): Promise<string | undefined> {
  return (asked ??= lookupIpv4(fetchImpl));
}

/** Forget the looked-up address (tests). */
export function forgetIpv4Hint(): void {
  asked = undefined;
}

/**
 * Whether a session that failed should be asked for again without the hint: den-edge opened it for the reported
 * address (`hinted`), nothing of it ever arrived, and it has not been retried already. A carrier NAT can give one
 * browser a different IPv4 address per destination, and then the listener waits for an address that never comes.
 * The retry gets what a page without a hint gets: a member the wide listener, a guest the IPv6 message.
 */
export function retryWithoutHint(
  session: { hinted?: boolean },
  played: boolean,
  retried: boolean,
): boolean {
  return session.hinted === true && !played && !retried;
}
