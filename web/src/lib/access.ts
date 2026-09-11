// What den-edge tells the web app about its surroundings (`/web-config`, oxyc/den#15): the public origins of Den's
// addons behind Cloudflare Access — an install URL on one is Den's own, which this page asks through its own origin,
// where den-edge relays it (`ADDON_RELAY`), so the Access service token stays on the TVs — and where the player
// reaches den-remux when this origin has none (the tailnet's address; video never goes through the tunnel).

export interface WebConfig {
  access: Set<string>;
  remux: string | null;
}

/** den-edge's `/web-config`; nothing when it can't say. */
export async function webConfig(fetchImpl: typeof fetch = fetch): Promise<WebConfig> {
  try {
    const res = await fetchImpl('/web-config');
    if (!res.ok) return { access: new Set(), remux: null };
    const body = (await res.json()) as { access?: unknown; remux?: unknown };
    const access = Array.isArray(body.access) ? body.access.filter((o): o is string => typeof o === 'string') : [];
    return { access: new Set(access), remux: typeof body.remux === 'string' ? body.remux : null };
  } catch {
    return { access: new Set(), remux: null };
  }
}
