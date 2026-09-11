// The public origins of Den's addons behind Cloudflare Access (oxyc/den#15), as den-edge names them. An install
// URL on one is Den's own, so this page asks it the way it asks a LAN one: through its own origin, where den-edge
// relays it to the addon (`ADDON_RELAY`) — the Access service token stays on the TVs.

/** The addon origins behind Access, as den-edge's `/web-config` names them; none when it can't say. */
export async function accessOrigins(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  try {
    const res = await fetchImpl('/web-config');
    if (!res.ok) return new Set();
    const access = ((await res.json()) as { access?: unknown }).access;
    return new Set(Array.isArray(access) ? access.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}
