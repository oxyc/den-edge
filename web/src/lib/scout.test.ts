import { describe, expect, it } from 'vitest';
import type { Routes } from './routes';
import { denAddonOf, findAddon, findAtlas, findReel, installsOf, SCOUT } from './scout';

const ROUTES: Routes = {
  scout: [
    { url: 'http://192.168.86.193:8080' },
    { url: 'https://pve.example:8443/scout' },
    { url: 'https://d-scout.oxy.fi', access: true },
  ],
  subs: [
    { url: 'http://192.168.86.193:8093' },
    { url: 'https://pve.example:8443/subs' },
    { url: 'https://d-subs.oxy.fi', access: true },
  ],
  atlas: [
    { url: 'http://192.168.86.193:8081' },
    { url: 'https://pve.example:8443/atlas' },
    { url: 'https://d-atlas.oxy.fi', access: true },
  ],
  reel: [
    { url: 'http://192.168.86.193:8092' },
    { url: 'https://pve.example:8443/reel' },
    { url: 'https://d-reel.oxy.fi', access: true },
  ],
};
const SCOUT_LAN = 'http://192.168.86.193:8080/sealed-cfg/manifest.json';
const SCOUT_PUBLIC = 'https://d-scout.oxy.fi/sealed-cfg/manifest.json';
const SUBS_LAN = 'http://192.168.86.193:8093/subs-cfg/manifest.json';
const SUBS_PUBLIC = 'https://d-subs.oxy.fi/subs-cfg/manifest.json';
const THEIRS = 'https://torrentio.example/debrid-token/manifest.json';

/** Manifests by URL; anything else is this origin's app shell, which is not JSON. */
function addons(manifests: Record<string, string>) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    const id = manifests[String(input)];
    return id
      ? new Response(JSON.stringify({ id }))
      : new Response('<!doctype html>', { status: 200 });
  };
  return { asked, fetchImpl };
}

describe('findAddon', () => {
  it('asks scout under this origin, whichever of its addresses the install is on, and nobody else’s addon', async () => {
    for (const install of [SCOUT_LAN, SCOUT_PUBLIC]) {
      const { asked, fetchImpl } = addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' });
      expect(await findAddon([THEIRS, SUBS_LAN, install], ROUTES, SCOUT, fetchImpl)).toEqual({
        install: install.replace('/manifest.json', ''),
        base: '/scout/sealed-cfg',
      });
      expect(asked, install).toEqual(['/scout/sealed-cfg/manifest.json']);
    }
  });

  it('is null when no plugin is scout, or the table has none', async () => {
    expect(await findAddon([THEIRS], ROUTES, SCOUT, addons({}).fetchImpl)).toBeNull();
    expect(await findAddon([SCOUT_LAN], {}, SCOUT, addons({}).fetchImpl)).toBeNull();
  });
});

describe('a table that names no address for the service', () => {
  /** What a public name serves: the household's LAN addresses and tailnet name are nobody else's. */
  const PUBLIC_ONLY: Routes = { edge: [{ url: 'https://d-api.oxy.fi' }] };

  it('reads the config segment off the install itself, whichever shape it is', async () => {
    const TAILNET = 'https://pve.example:8443/scout/sealed-cfg/manifest.json';
    for (const install of [SCOUT_LAN, TAILNET]) {
      const { asked, fetchImpl } = addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' });
      expect(await findAddon([install], PUBLIC_ONLY, SCOUT, fetchImpl)).toEqual({
        install: install.replace('/manifest.json', ''),
        base: '/scout/sealed-cfg',
      });
      // The mount is stripped as a whole segment, so both shapes land on the same place to ask.
      expect(asked, install).toEqual(['/scout/sealed-cfg/manifest.json']);
    }
  });

  /** Guessing a place is not believing it: the manifest id is still what decides. */
  it('still refuses a stranger’s addon, for one request', async () => {
    const { asked, fetchImpl } = addons({});
    expect(await findAddon([THEIRS], PUBLIC_ONLY, SCOUT, fetchImpl)).toBeNull();
    expect(asked).toEqual(['/scout/debrid-token/manifest.json']);
  });

  /** And while the table CAN disqualify it, a stranger's URL is never touched at all. */
  it('leaves other addons alone while the table names addresses', async () => {
    const { asked, fetchImpl } = addons({});
    expect(await findAddon([THEIRS], ROUTES, SCOUT, fetchImpl)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('findAtlas', () => {
  it('is a plugin, else this origin’s own, else none', async () => {
    const plugin = addons({ '/atlas/manifest.json': 'com.den.atlas' });
    expect(
      await findAtlas(['https://d-atlas.oxy.fi/manifest.json'], ROUTES, plugin.fetchImpl),
    ).toEqual({
      install: 'https://d-atlas.oxy.fi',
      base: '/atlas',
    });
    expect((await findAtlas([], ROUTES, plugin.fetchImpl))?.base).toBe('/atlas');
    expect(
      await findAtlas([], ROUTES, addons({}).fetchImpl),
      'nothing under /atlas here',
    ).toBeNull();
  });
});

describe('findReel', () => {
  it('is a plugin, else this origin’s own, else none', async () => {
    const plugin = addons({ '/reel/manifest.json': 'com.den.reel' });
    expect(
      await findReel(['https://d-reel.oxy.fi/manifest.json'], ROUTES, plugin.fetchImpl),
    ).toEqual({
      install: 'https://d-reel.oxy.fi',
      base: '/reel',
    });
    // A guest lists no plugins, because a guest has no library — and the billboard still wants its trailer.
    expect((await findReel([], ROUTES, plugin.fetchImpl))?.base).toBe('/reel');
    expect(await findReel([], ROUTES, addons({}).fetchImpl), 'nothing under /reel here').toBeNull();
  });
});

describe('denAddonOf', () => {
  it('names Den’s own plugins on any of their addresses, and nobody else’s', () => {
    expect(denAddonOf(SUBS_LAN, ROUTES)).toEqual({
      name: 'subs',
      label: 'Den Subtitles',
      role: 'Subtitles',
    });
    expect(denAddonOf(SCOUT_PUBLIC, ROUTES)?.label).toBe('Den Scout');
    expect(denAddonOf(THEIRS, ROUTES)).toBeNull();
    expect(denAddonOf(SUBS_LAN, {}), 'before the table arrives').toBeNull();
  });
});

describe('installsOf', () => {
  it('lists the installs of one service, without their manifest file', () => {
    expect(installsOf([THEIRS, SUBS_LAN, SUBS_PUBLIC, SCOUT_PUBLIC], ROUTES, 'subs')).toEqual([
      'http://192.168.86.193:8093/subs-cfg',
      'https://d-subs.oxy.fi/subs-cfg',
    ]);
  });
});
