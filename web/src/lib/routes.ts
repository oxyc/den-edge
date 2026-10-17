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

/**
 * How long the page reuses one `/routes` answer. Every session and Settings ask as the page opens, a moment apart;
 * the table changes only when the deployment does, and a later rediscovery still asks again.
 */
const ROUTES_REUSE_MS = 30_000;
let asked: { routes: Promise<Routes>; at: number } | undefined;

/** den-edge's `/routes`; empty when it can't say. The page's callers within `ROUTES_REUSE_MS` share one answer. */
export function fetchRoutes(fetchImpl?: typeof fetch): Promise<Routes> {
  if (fetchImpl) return readRoutes(fetchImpl);
  if (!asked || performance.now() - asked.at >= ROUTES_REUSE_MS) {
    const routes = readRoutes((input, init) => fetch(input, init));
    const current = { routes, at: performance.now() };
    asked = current;
    // An empty table is den-edge not saying (or not reached): the next caller asks again.
    void routes.then((table) => {
      if (!Object.keys(table).length && asked === current) asked = undefined;
    });
  }
  // Each caller its own copy: one keeping and editing its table never changes another's.
  return asked.routes.then((routes) => structuredClone(routes));
}

async function readRoutes(fetchImpl: typeof fetch): Promise<Routes> {
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
          return typeof entry?.url === 'string'
            ? [{ url: entry.url, access: entry.access === true }]
            : [];
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
