// The routes table (den-spec wire/routes-v1.md, oxyc/den#16): for each of the deployment's services, every address
// to try, in order. This page uses it to tell which of the library's install URLs are Den's own addons, and to find
// where its player reaches den-remux. It asks the addons' JSON under its own origin (`/scout`, `/atlas`: den-edge's
// relay on the public name, tailscale serve on the tailnet), and trailers come from YouTube.

export interface Entry {
  url: string;
  /** A public name behind Cloudflare Access: the service token is sent there, and a browser has none. */
  access?: boolean;
}

export type Routes = Record<string, Entry[]>;

/** den-edge's `/routes`; empty when it can't say. */
export async function fetchRoutes(fetchImpl: typeof fetch = fetch): Promise<Routes> {
  try {
    const res = await fetchImpl('/routes');
    if (!res.ok) return {};
    const addons = ((await res.json()) as { addons?: unknown }).addons;
    if (!addons || typeof addons !== 'object') return {};
    return Object.fromEntries(
      Object.entries(addons as Record<string, unknown>).map(([name, list]) => [
        name,
        (Array.isArray(list) ? list : []).flatMap((raw): Entry[] => {
          const entry = raw as { url?: unknown; access?: unknown } | null;
          return typeof entry?.url === 'string' ? [{ url: entry.url, access: entry.access === true }] : [];
        }),
      ]),
    );
  } catch {
    return {};
  }
}

/** The rest of `url` past the one of `entries` it is on — `/<config>` for an install URL — or null when it is on none. */
export function within(url: string, entries: Entry[] = []): string | null {
  for (const entry of entries) {
    if (url === entry.url || url.startsWith(`${entry.url}/`)) return url.slice(entry.url.length);
  }
  return null;
}
