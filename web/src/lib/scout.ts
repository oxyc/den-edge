// Den's own addons among the library's plugins (`set:plugins`), and where this page asks them. An install URL is
// Den's when it is on one of the routes table's entries for that service (den-spec routes-v1): the LAN address, the
// tailnet path or the public name. This page asks it under its own origin — `/scout`, `/atlas` — which den-edge relays
// on the public name and tailscale serve serves on the tailnet, with the install's config segment after it. An addon
// that is not Den's is never sent anything.

import { within, type Routes } from './routes';

export interface Addon {
  /** The install URL as the library holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Where this page asks it. */
  base: string;
}

export const SCOUT = { name: 'scout', id: 'com.den.scout', path: '/scout' };
export const ATLAS = { name: 'atlas', id: 'com.den.atlas', path: '/atlas' };

const MANIFEST = '/manifest.json';

/** Where this page would ask the plugin at `url`, when it is the service `want` names; null otherwise. */
function place(url: string, routes: Routes, want: { name: string; path: string }): Addon | null {
  if (!url.endsWith(MANIFEST)) return null;
  const install = url.slice(0, -MANIFEST.length);
  const config = within(install, routes[want.name]);
  return config !== null && /^(\/[\w.~%-]+)?$/.test(config) ? { install, base: want.path + config } : null;
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
  fetchImpl: typeof fetch = fetch,
): Promise<Addon | null> {
  for (const url of plugins) {
    const addon = place(url, routes, want);
    if (addon && (await manifestIs(`${addon.base}${MANIFEST}`, want.id, fetchImpl))) return addon;
  }
  return null;
}

/** atlas: a plugin, or — where this origin serves one — the box's own, which the library need not list. */
export async function findAtlas(plugins: string[], routes: Routes, fetchImpl: typeof fetch = fetch): Promise<Addon | null> {
  const plugin = await findAddon(plugins, routes, ATLAS, fetchImpl);
  if (plugin) return plugin;
  const here = await manifestIs(`${ATLAS.path}${MANIFEST}`, ATLAS.id, fetchImpl);
  return here ? { install: ATLAS.path, base: ATLAS.path } : null;
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

/** The library's installs of the service `name` (den-subtitles, for den-remux), without their manifest file. */
export function installsOf(plugins: string[], routes: Routes, name: string): string[] {
  return plugins.flatMap((url) => {
    if (!url.endsWith(MANIFEST)) return [];
    const install = url.slice(0, -MANIFEST.length);
    return within(install, routes[name]) === null ? [] : [install];
  });
}
