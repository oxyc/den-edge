import { describe, expect, it } from 'vitest';
import type { Routes } from './routes';
import { findAddon, findAtlas, installsOf, SCOUT } from './scout';

const ROUTES: Routes = {
  scout: [{ url: 'http://192.168.86.193:8080' }, { url: 'https://pve.example:8443/scout' }, { url: 'https://d-scout.oxy.fi', access: true }],
  subs: [{ url: 'http://192.168.86.193:8093' }, { url: 'https://pve.example:8443/subs' }, { url: 'https://d-subs.oxy.fi', access: true }],
  atlas: [{ url: 'http://192.168.86.193:8081' }, { url: 'https://pve.example:8443/atlas' }, { url: 'https://d-atlas.oxy.fi', access: true }],
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
    return id ? new Response(JSON.stringify({ id })) : new Response('<!doctype html>', { status: 200 });
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

describe('findAtlas', () => {
  it('is a plugin, else this origin’s own, else none', async () => {
    const plugin = addons({ '/atlas/manifest.json': 'com.den.atlas' });
    expect(await findAtlas(['https://d-atlas.oxy.fi/manifest.json'], ROUTES, plugin.fetchImpl)).toEqual({
      install: 'https://d-atlas.oxy.fi',
      base: '/atlas',
    });
    expect((await findAtlas([], ROUTES, plugin.fetchImpl))?.base).toBe('/atlas');
    expect(await findAtlas([], ROUTES, addons({}).fetchImpl), 'nothing under /atlas here').toBeNull();
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
