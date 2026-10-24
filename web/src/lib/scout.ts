// Den's own addons among the library's plugins (`set:plugins`), and where this page asks them. An install URL is
// Den's when it is on one of the routes table's entries for that service (den-spec routes-v1): the LAN address, the
// tailnet path or the public name. This page asks it under its own origin — `/scout`, `/atlas` — which den-edge relays
// on the public name and tailscale serve serves on the tailnet, with the install's config segment after it. An addon
// that is not Den's is never sent anything.

import { sharedInstallOf, validInstallSegment, type GrantAddon } from './grants';
import { isLanURL } from './prefs';
import { relayFetch } from './relayFetch';
import { within, type Routes } from './routes';

export interface Addon {
  /** The install URL as the library holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Where this page asks it. */
  base: string;
  /** Hearth's unified playback operation, discovered live for this browser session. */
  playback?: string;
}

export const SCOUT = { name: 'scout', id: 'com.den.scout', path: '/scout' };
/** Hearth's canonical id. The former id stays readable while already-deployed nodes roll forward. */
export const DEN = { name: 'den', id: 'com.den.hearth', path: '/den' };
export const DEN_IDS = [DEN.id, 'com.den.addon'] as const;
export const ATLAS = { name: 'atlas', id: 'com.den.atlas', path: '/atlas' };
export const REEL = { name: 'reel', id: 'com.den.reel', path: '/reel' };

const MANIFEST = '/manifest.json';

/** Where this page would ask the plugin at `url`, when it is the service `want` names; null otherwise. */
function place(url: string, routes: Routes, want: { name: string; path: string }): Addon | null {
  if (!url.endsWith(MANIFEST)) return null;
  // An addon shared with this browser (`grants.svelte.ts`) is asked on its own `~<gid>` base and nowhere else.
  const shared = sharedInstallOf(url);
  if (shared)
    return shared.path.startsWith(`${want.path}/`)
      ? { install: shared.install, base: shared.path }
      : null;
  const install = url.slice(0, -MANIFEST.length);
  const listed = routes[want.name];
  // The URL's own segment only where the table names no address for this service at all — which is
  // what a public name serves — and only for an install on this household's own network. While the
  // table does name addresses, an install matching none of them is somebody else's addon.
  const guess = !listed?.length && household(install, routes) ? configOf(install, want.path) : null;
  const config = within(install, listed) ?? guess;
  return config !== null && /^(\/[\w.~%-]+)?$/.test(config)
    ? { install, base: want.path + config }
    : null;
}

/**
 * The install's config segment read from the URL itself, for a table that no longer names it.
 *
 * A public name is going to serve public entries only — a household's LAN addresses and tailnet name
 * are nobody else's business, and no browser out there can use them — so `within` will have nothing
 * to match a LAN install against. The segment is still there in the URL: a LAN install is
 * `http://host:8080/<config>` and a tailnet one carries the mount as well, `…:8443/reel/<config>`.
 *
 * This only guesses WHERE to ask. `findAddon` still confirms what answered is the service it wanted,
 * by its manifest id, so a stranger's plugin placed here is refused a moment later at the cost of one
 * request. That is also why this belongs to `place` alone: `denAddonOf` and `installsOf` believe the
 * table without probing, and handing them the same guess would label anyone's addon as Den's.
 */
/**
 * Is this install on the household's own network, or one of this deployment's own names?
 *
 * The guard on guessing. A guess is a request to `<this origin>/<service>/<the install's config>`,
 * and on a public name that request terminates at the edge and is written to its logs. A Den config
 * is sealed and says nothing; a third-party one is often plaintext and carries the owner's debrid
 * key, so guessing a place for a stranger's addon would copy someone's credential into a log kept by
 * a company neither of us is a customer of. A LAN or tailnet address cannot belong to a stranger.
 */
function household(install: string, routes: Routes): boolean {
  let host: string;
  try {
    host = new URL(install).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === globalThis.location?.hostname?.toLowerCase()) return true;
  // Tailscale's own names: a machine on this tailnet, which nobody outside it can even resolve.
  if (host.endsWith('.ts.net')) return true;
  if (isLanURL(install)) return true;
  // And whatever names this deployment gives for itself, which is what the table is.
  return Object.values(routes).some((entries) =>
    entries?.some((entry) => {
      try {
        return new URL(entry.url).hostname.toLowerCase() === host;
      } catch {
        return false;
      }
    }),
  );
}

function configOf(install: string, mount: string): string | null {
  let path: string;
  try {
    path = new URL(install).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  // The mount as a whole segment, never a string prefix: `/reelish-cfg` is a config, not this mount.
  if (path === mount || path.startsWith(`${mount}/`)) path = path.slice(mount.length);
  return path === '' || /^\/[\w.~%-]+$/.test(path) ? path : null;
}

/** Read a live manifest only when it identifies the expected addon. */
async function readManifest(
  manifest: string,
  id: string | readonly string[],
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(manifest, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown> | null;
    const ids = typeof id === 'string' ? [id] : id;
    return typeof body?.id === 'string' && ids.includes(body.id) ? body : null;
  } catch {
    return null;
  }
}

/** A live, deliberately uncached probe of Hearth's runtime/default-off playback route. */
async function hasPlayback(base: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${base}/playback`, {
      method: 'OPTIONS',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

/** The first of the library's plugins that is the service `want` names, confirmed by its manifest. */
export async function findAddon(
  plugins: string[],
  routes: Routes,
  want: { name: string; id: string | readonly string[]; path: string },
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  for (const url of plugins) {
    const addon = place(url, routes, want);
    if (addon && (await readManifest(`${addon.base}${MANIFEST}`, want.id, fetchImpl))) return addon;
  }
  return null;
}

/**
 * The stream source used by playback: legacy Scout, or the combined Den addon. The latter opts the browser into
 * Hearth-owned playback only when its configured playback route answers the live capability probe with exactly 204.
 * A concealed 404, any other answer, or a failed probe keeps the existing Remux client, so shipping these bytes does
 * not turn the feature on.
 */
export async function findScout(
  plugins: string[],
  routes: Routes,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  const legacy = await findAddon(plugins, routes, SCOUT, fetchImpl);
  if (legacy) return legacy;
  for (const url of plugins) {
    const addon = place(url, routes, DEN);
    if (!addon) continue;
    if (!(await readManifest(`${addon.base}${MANIFEST}`, DEN_IDS, fetchImpl))) continue;
    return (await hasPlayback(addon.base, fetchImpl))
      ? { ...addon, playback: `${addon.base}/playback` }
      : addon;
  }
  return null;
}

/** atlas: a plugin, or — where this origin serves one — the box's own, which the library need not list. */
export async function findAtlas(
  plugins: string[],
  routes: Routes,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  const plugin = await findAddon(plugins, routes, ATLAS, fetchImpl);
  if (plugin) return plugin;
  const here = await readManifest(`${ATLAS.path}${MANIFEST}`, ATLAS.id, fetchImpl);
  return here ? { install: ATLAS.path, base: ATLAS.path } : null;
}

/**
 * reel: a plugin, or — where this origin serves one — the box's own.
 *
 * The same fallback atlas has, and for the same reason: a guest has no library, so no list of plugins, and
 * looking reel up in one found nothing. The billboard then had no trailer to play and said nothing about why.
 *
 * The box's own is proved by its `/health`, not a manifest: Hearth serves Reel under `/reel` with no manifest of
 * its own (its one manifest is the combined addon's), so asking for one found nothing on every page. The answer
 * must be Reel's JSON, since this origin answers an unknown path with the app's HTML.
 */
export async function findReel(
  plugins: string[],
  routes: Routes,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  const plugin = await findAddon(plugins, routes, REEL, fetchImpl);
  if (plugin) return plugin;
  return (await servesHealth(REEL.path, fetchImpl))
    ? { install: REEL.path, base: REEL.path }
    : null;
}

async function servesHealth(base: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown } | null;
    return typeof body?.status === 'string';
  } catch {
    return false;
  }
}

/** Den's own addons, as Settings names them. */
const DEN_ADDONS = [
  { name: 'den', label: 'Den Hearth', role: 'Streams, subtitles and trailers' },
  { name: 'scout', label: 'Den Scout', role: 'Streams' },
  { name: 'subs', label: 'Den Subtitles', role: 'Subtitles' },
  { name: 'atlas', label: 'Den Atlas', role: 'Discovery' },
  { name: 'reel', label: 'Den Reel', role: 'Trailers' },
];

/** Which of Den's addons the plugin at `url` is, by the routes table's entries; null for anyone else's. */
export function denAddonOf(
  url: string,
  routes: Routes,
): { name: string; label: string; role: string } | null {
  const install = url.endsWith(MANIFEST) ? url.slice(0, -MANIFEST.length) : url;
  return DEN_ADDONS.find((addon) => within(install, routes[addon.name]) !== null) ?? null;
}

/**
 * Hearth's configure page for an installed first-party route. The address comes only from signed-in route metadata,
 * never by trimming or otherwise trusting an arbitrary plugin URL.
 */
export function denConfigureURL(url: string, routes: Routes): string | null {
  if (!url.endsWith(MANIFEST)) return null;
  const install = url.slice(0, -MANIFEST.length);
  // A shared access's `/den/~<gid>` is a guest's view of someone else's Hearth: its settings open from "Shared with
  // you", never the owner's setup page.
  const entry = routes.den?.find((candidate) => {
    const rest = within(install, [candidate]);
    return rest !== null && !rest.startsWith('/~');
  });
  return entry ? `${entry.url.replace(/\/+$/, '')}/configure` : null;
}

/**
 * The single config segment of each of the library's own Hearth, scout, atlas, reel and subtitles installs — what a grant
 * escrows, so den-edge builds the address itself. An addon with no install, or one whose segment isn't plain base64url,
 * is left out.
 */
export function hostedInstalls(
  plugins: string[],
  routes: Routes,
): Partial<Record<GrantAddon, string>> {
  const installs: Partial<Record<GrantAddon, string>> = {};
  const wants: [GrantAddon, { name: string; path: string }][] = [
    ['den', DEN],
    ['scout', SCOUT],
    ['atlas', ATLAS],
    ['reel', REEL],
    ['subtitles', { name: 'subs', path: '/subtitles' }],
  ];
  for (const [addon, want] of wants) {
    for (const url of plugins) {
      const segment = place(url, routes, want)?.base.slice(want.path.length + 1);
      if (segment && validInstallSegment(addon, segment)) {
        installs[addon] = segment;
        break;
      }
    }
  }
  return installs;
}

/** The library's installs of the service `name` (den-subtitles, for den-remux), without their manifest file. */
export function installsOf(plugins: string[], routes: Routes, name: string): string[] {
  return plugins.flatMap((url) => {
    if (!url.endsWith(MANIFEST)) return [];
    const shared = sharedInstallOf(url);
    if (shared)
      return shared.addon === (name === 'subs' ? 'subtitles' : name) ? [shared.install] : [];
    const install = url.slice(0, -MANIFEST.length);
    return within(install, routes[name]) === null ? [] : [install];
  });
}
