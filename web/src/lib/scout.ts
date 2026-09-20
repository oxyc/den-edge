// Den's own addons among the library's plugins (`set:plugins`), and where this page asks them. An install URL is
// Den's when it is on one of the routes table's entries for that service (den-spec routes-v1): the LAN address, the
// tailnet path or the public name. This page asks it under its own origin — `/scout`, `/atlas` — which den-edge relays
// on the public name and tailscale serve serves on the tailnet, with the install's config segment after it. An addon
// that is not Den's is never sent anything.

import { SEGMENT, sharedInstallOf, type GrantAddon } from './grants';
import { isLanURL } from './prefs';
import { relayFetch } from './relayFetch';
import { within, type Routes } from './routes';

export interface Addon {
  /** The install URL as the library holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Where this page asks it. */
  base: string;
}

export const SCOUT = { name: 'scout', id: 'com.den.scout', path: '/scout' };
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

async function manifestIs(manifest: string, id: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(manifest);
    return res.ok && ((await res.json()) as { id?: unknown }).id === id;
  } catch {
    return false; // out of reach, or not an addon at all
  }
}

/** The first of the library's plugins that is the service `want` names, confirmed by its manifest. */
export async function findAddon(
  plugins: string[],
  routes: Routes,
  want: { name: string; id: string; path: string },
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  for (const url of plugins) {
    const addon = place(url, routes, want);
    if (addon && (await manifestIs(`${addon.base}${MANIFEST}`, want.id, fetchImpl))) return addon;
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
  const here = await manifestIs(`${ATLAS.path}${MANIFEST}`, ATLAS.id, fetchImpl);
  return here ? { install: ATLAS.path, base: ATLAS.path } : null;
}

/**
 * reel: a plugin, or — where this origin serves one — the box's own.
 *
 * The same fallback atlas has, and for the same reason: a guest has no library, so no list of plugins, and
 * looking reel up in one found nothing. The billboard then had no trailer to play and said nothing about why.
 */
export async function findReel(
  plugins: string[],
  routes: Routes,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Addon | null> {
  const plugin = await findAddon(plugins, routes, REEL, fetchImpl);
  if (plugin) return plugin;
  const here = await manifestIs(`${REEL.path}${MANIFEST}`, REEL.id, fetchImpl);
  return here ? { install: REEL.path, base: REEL.path } : null;
}

/** Den's own addons, as Settings names them. */
const DEN_ADDONS = [
  { name: 'scout', label: 'Den Scout', role: 'Streams' },
  { name: 'subs', label: 'Den Subtitles', role: 'Subtitles' },
  { name: 'atlas', label: 'Den Atlas', role: 'Discovery' },
  { name: 'reel', label: 'Den Reel', role: 'Trailers' },
];

/** Which of Den's addons the plugin at `url` is, by the routes table's entries; null for anyone else's. */
export function denAddonOf(url: string, routes: Routes): { label: string; role: string } | null {
  const install = url.endsWith(MANIFEST) ? url.slice(0, -MANIFEST.length) : url;
  return DEN_ADDONS.find((addon) => within(install, routes[addon.name]) !== null) ?? null;
}

/**
 * The single config segment of each of the library's own scout, atlas, reel and subtitles installs — what a grant
 * escrows, so den-edge builds the address itself. An addon with no install, or one whose segment isn't plain base64url,
 * is left out.
 */
export function hostedInstalls(
  plugins: string[],
  routes: Routes,
): Partial<Record<GrantAddon, string>> {
  const installs: Partial<Record<GrantAddon, string>> = {};
  const wants: [GrantAddon, { name: string; path: string }][] = [
    ['scout', SCOUT],
    ['atlas', ATLAS],
    ['reel', REEL],
    ['subtitles', { name: 'subs', path: '/subtitles' }],
  ];
  for (const [addon, want] of wants) {
    for (const url of plugins) {
      const segment = place(url, routes, want)?.base.slice(want.path.length + 1);
      if (segment && SEGMENT.test(segment)) {
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
