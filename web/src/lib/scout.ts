// den-scout among the library's plugins (`set:plugins`). Its install URL names the TV's LAN address, which this page
// can't reach, so each LAN plugin's config is tried against scout on this page's own origin (`/scout/`, tailscale
// serve): the one whose manifest is scout's. A public addon's URL is never sent.

import { isLanURL } from './prefs';

export interface Scout {
  /** The install URL as the TV holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Its config segment, for asking scout on this origin. */
  config: string;
}

const SCOUT = 'com.den.scout';

export async function findScout(plugins: string[], fetchImpl: typeof fetch = fetch): Promise<Scout | null> {
  for (const url of plugins) {
    const config = lanConfig(url);
    if (!config) continue;
    try {
      const res = await fetchImpl(`/scout/${config}/manifest.json`);
      if (res.ok && ((await res.json()) as { id?: unknown }).id === SCOUT) return { install: installURL(url), config };
    } catch {
      // Out of reach from here; the next may not be.
    }
  }
  return null;
}

/** The library's other LAN addons as install URLs — den-subtitles among them, which only den-remux can tell apart. */
export function lanInstalls(plugins: string[], scout: Scout | null): string[] {
  return plugins
    .filter((url) => lanConfig(url) !== null)
    .map(installURL)
    .filter((install) => install !== scout?.install);
}

function installURL(manifest: string): string {
  return manifest.replace(/\/manifest\.json$/, '');
}

/** The config segment of a LAN addon's `…/<config>/manifest.json` URL. */
function lanConfig(url: string): string | null {
  if (!isLanURL(url)) return null;
  const [config, file, ...rest] = new URL(url).pathname.split('/').filter(Boolean);
  return config && file === 'manifest.json' && rest.length === 0 && /^[\w.~%-]+$/.test(config) ? config : null;
}
