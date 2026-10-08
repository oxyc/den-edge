// Where den-remux answers for this page, and whether the browser refused it the home network: what the session asks
// as it starts. Apart from `remux.ts`, which is the player's and would otherwise ride along in the first load.

import type { Entry } from './routes';
import { relayFetch } from './relayFetch';

/** A direct LAN/tailnet probe must finish even when an unreachable route silently drops packets. */
export const REMUX_PROBE_TIMEOUT_MS = 3_000;

/**
 * Where den-remux answers for this page: the first of its routes-table entries (den-spec routes-v1) this page can use
 * whose `/health` answers — none behind Access (a browser holds no token), and no plain http from an https page — or
 * null, off the tailnet where no address reaches it.
 */
export async function findRemux(
  entries: Entry[],
  fetchImpl: typeof fetch = relayFetch,
  secure = globalThis.location?.protocol !== 'http:',
): Promise<string | null> {
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('remux health deadline'));
      }, REMUX_PROBE_TIMEOUT_MS);
    });
    try {
      const probe = async () => {
        const res = await fetchImpl(`${entry.url}/health`, { signal: controller.signal });
        return res.ok && typeof ((await res.json()) as { status?: unknown }).status === 'string';
      };
      if (await Promise.race([probe(), expired])) return entry.url;
    } catch {
      // Out of reach from here, or not den-remux: the next.
    } finally {
      clearTimeout(timer);
    }
  }
  // The public web name exposes only member-gated control JSON at this same-origin mount. Its session answer
  // supplies the IP-literal media origin; no video byte follows this relay.
  try {
    const res = await fetchImpl('/remux/health');
    if (res.ok && typeof ((await res.json()) as { status?: unknown }).status === 'string')
      return '/remux';
  } catch {
    // No control relay here either.
  }
  return null;
}

/**
 * Whether this browser refuses the page the home network, which is a different thing from no route reaching
 * den-remux — and the two were told apart only by a sentence that assumed the second.
 *
 * Chrome's Local Network Access (enforcing since 142) classifies a tailnet address (100.64.0.0/10) as local, so a page
 * on the public name can be refused before a request leaves. Refusal only: `prompt` means the question has not been
 * put, and a browser that does not know the name has no such policy — neither is something to tell a viewer about.
 */
async function localNetworkPermission(): Promise<PermissionState | null> {
  const permissions = globalThis.navigator?.permissions;
  if (!permissions) return null;
  try {
    const status = await permissions.query({ name: 'local-network-access' as PermissionName });
    return status.state;
  } catch {
    // An unknown permission name throws; that browser does not enforce this either.
    return null;
  }
}

/** Whether the browser has explicitly refused this page access to the local network. */
export async function localNetworkRefused(): Promise<boolean> {
  return (await localNetworkPermission()) === 'denied';
}

/**
 * Whether this page may proactively load a local-network media origin.
 *
 * A browser implementing Local Network Access must already have a grant: a media load cannot explain or reliably
 * surface its own permission prompt, so both `prompt` and `denied` are unusable. Browsers without the Permissions API
 * or this permission name keep their existing behaviour; they do not enforce Chrome's Local Network Access gate.
 */
export async function mayUseLocalNetwork(): Promise<boolean> {
  const permission = await localNetworkPermission();
  return permission === null || permission === 'granted';
}
