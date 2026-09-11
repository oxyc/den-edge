import { describe, expect, it } from 'vitest';
import { denInstalls, findAddon, findAtlas, SCOUT } from './scout';

const SCOUT_LAN = 'http://192.168.86.193:8080/sealed-cfg/manifest.json';
const SCOUT_PUBLIC = 'https://d-scout.oxy.fi/sealed-cfg/manifest.json';
const SUBTITLES = 'http://192.168.86.193:8093/subs-cfg/manifest.json';
const SUBS_PUBLIC = 'https://d-subs.oxy.fi/subs-cfg/manifest.json';
const PUBLIC = 'https://torrentio.example/debrid-token/manifest.json';
const ACCESS = new Set(['https://d-scout.oxy.fi', 'https://d-subs.oxy.fi', 'https://d-atlas.oxy.fi']);

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
  it('asks a LAN install under this origin, and never an addon that is not Den’s', async () => {
    const { asked, fetchImpl } = addons({
      '/scout/subs-cfg/manifest.json': 'com.den.subtitles',
      '/scout/sealed-cfg/manifest.json': 'com.den.scout',
    });
    expect(await findAddon([PUBLIC, SUBTITLES, SCOUT_LAN], ACCESS, SCOUT, fetchImpl)).toEqual({
      install: 'http://192.168.86.193:8080/sealed-cfg',
      base: '/scout/sealed-cfg',
    });
    expect(asked).toEqual(['/scout/subs-cfg/manifest.json', '/scout/sealed-cfg/manifest.json']);
  });

  it('asks a public install behind Access through this origin too, keeping its URL for den-remux', async () => {
    const { asked, fetchImpl } = addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' });
    expect(await findAddon([PUBLIC, SCOUT_PUBLIC], ACCESS, SCOUT, fetchImpl)).toEqual({
      install: 'https://d-scout.oxy.fi/sealed-cfg',
      base: '/scout/sealed-cfg',
    });
    expect(asked).toEqual(['/scout/sealed-cfg/manifest.json']);
  });
});

describe('findAtlas', () => {
  it('is a plugin, else this origin’s own, else none', async () => {
    const plugin = addons({ '/atlas/manifest.json': 'com.den.atlas' });
    expect(await findAtlas(['https://d-atlas.oxy.fi/manifest.json'], ACCESS, plugin.fetchImpl)).toEqual({
      install: 'https://d-atlas.oxy.fi',
      base: '/atlas',
    });
    const tailnet = addons({ '/atlas/manifest.json': 'com.den.atlas' });
    expect((await findAtlas([], ACCESS, tailnet.fetchImpl))?.base).toBe('/atlas');
    expect(await findAtlas([], ACCESS, addons({}).fetchImpl), 'the public web name serves no /atlas').toBeNull();
  });
});

describe('denInstalls', () => {
  it('lists Den’s other addons, on the LAN or behind Access, without their manifest file', () => {
    const scout = { install: 'https://d-scout.oxy.fi/sealed-cfg', base: 'https://d-scout.oxy.fi/sealed-cfg' };
    expect(denInstalls([PUBLIC, SUBTITLES, SUBS_PUBLIC, SCOUT_PUBLIC], ACCESS, scout)).toEqual([
      'http://192.168.86.193:8093/subs-cfg',
      'https://d-subs.oxy.fi/subs-cfg',
    ]);
  });
});
