// Den's own addons among the library's plugins (`set:plugins`), and where this page asks them. An install URL names
// either a public name behind Cloudflare Access (oxyc/den#15) or the TV's LAN address; this page can reach neither
// itself, so it asks both under its own origin — `/scout`, `/atlas` — which den-edge relays on the public name
// (`ADDON_RELAY`) and tailscale serve on the tailnet. An addon that is not Den's is never sent anything.

import { isLanURL } from './prefs';

export interface Addon {
  /** The install URL as the library holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Where this page asks it. */
  base: string;
}

export const SCOUT = { id: 'com.den.scout', lanPath: '/scout' };
export const ATLAS = { id: 'com.den.atlas', lanPath: '/atlas' };

/** Where this page would ask the addon at `url`, when it is one of Den's; null for anyone else's. */
function place(url: string, access: Set<string>, lanPath: string): Addon | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const suffix = '/manifest.json';
  if (!parsed.pathname.endsWith(suffix) || parsed.search || parsed.hash) return null;
  const install = url.slice(0, -suffix.length);
  const path = parsed.pathname.slice(0, -suffix.length);
  const dens = access.has(parsed.origin) || isLanURL(url);
  return dens && /^(\/[\w.~%-]+)?$/.test(path) ? { install, base: lanPath + path } : null;
}

async function manifestIs(manifest: string, id: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(manifest);
    return res.ok && ((await res.json()) as { id?: unknown }).id === id;
  } catch {
    return false; // out of reach, or not an addon at all
  }
}

/** The first of the library's plugins that is the addon `want` names, by its manifest. */
export async function findAddon(
  plugins: string[],
  access: Set<string>,
  want: { id: string; lanPath: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Addon | null> {
  for (const url of plugins) {
    const addon = place(url, access, want.lanPath);
    if (addon && (await manifestIs(`${addon.base}/manifest.json`, want.id, fetchImpl))) return addon;
  }
  return null;
}

/** atlas: a plugin, or — where this origin serves one (the tailnet's `/atlas`) — the box's own. */
export async function findAtlas(plugins: string[], access: Set<string>, fetchImpl: typeof fetch = fetch): Promise<Addon | null> {
  const plugin = await findAddon(plugins, access, ATLAS, fetchImpl);
  if (plugin) return plugin;
  const here = await manifestIs(`${ATLAS.lanPath}/manifest.json`, ATLAS.id, fetchImpl);
  return here ? { install: ATLAS.lanPath, base: ATLAS.lanPath } : null;
}

/** The library's other Den addons as install URLs — den-subtitles among them, which only den-remux can tell apart. */
export function denInstalls(plugins: string[], access: Set<string>, except: Addon | null): string[] {
  return plugins.flatMap((url) => place(url, access, '')?.install ?? []).filter((install) => install !== except?.install);
}
