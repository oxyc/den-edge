import { describe, expect, it } from 'vitest';
import type { Routes } from './routes';
import {
  arrivals,
  denAddonOf,
  findAddon,
  findAtlas,
  installsOf,
  SCOUT,
  trendingEverywhere,
} from './scout';

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

describe('arrivals', () => {
  const meta = (id: number, name: string) => ({ moviedb_id: id, name, releaseInfo: '2026' });
  const manifest = {
    catalogs: [
      { type: 'movie', id: 'jw-trending' },
      { type: 'movie', id: 'jw-nfx', denProviderId: 8, denProviderIds: [8] },
      { type: 'movie', id: 'jw-nfx-new', denProviderId: 8, denProviderIds: [8] },
      { type: 'series', id: 'jw-nfx-new', denProviderId: 8, denProviderIds: [8] },
      { type: 'movie', id: 'jw-mxx-new', denProviderId: 1899, denProviderIds: [1899] },
    ],
  };
  const atlas: typeof fetch = async (input) => {
    const url = String(input);
    if (url === '/atlas/manifest.json') return new Response(JSON.stringify(manifest));
    if (url === '/atlas/catalog/movie/jw-nfx-new/country=FI.json') {
      return new Response(JSON.stringify({ metas: [meta(1, 'New film on Netflix FI')] }));
    }
    if (url === '/atlas/catalog/series/jw-nfx-new/country=FI.json') {
      return new Response(JSON.stringify({ metas: [meta(2, 'New series on Netflix FI')] }));
    }
    return new Response('{}', { status: 404 });
  };

  it('asks only the "new on" catalogs of the services picked, in the countries picked', async () => {
    const lists = await arrivals('/atlas', [{ id: 8, country: 'FI' }], atlas);
    expect(lists.map((l) => l.map((t) => t.id))).toEqual([[1], [2]]);
    expect(lists.flat().map((t) => t.type)).toEqual(['movie', 'tv']);
  });

  it('falls back to every catalog the install advertises, which is already only its own services', async () => {
    // No picks synced: an install's manifest lists the services it was configured with, so all of them count.
    const asked: string[] = [];
    const watching: typeof fetch = async (input) => {
      asked.push(String(input));
      return atlas(input);
    };
    await arrivals('/atlas', [], watching);
    expect(asked).toEqual([
      '/atlas/manifest.json',
      '/atlas/catalog/movie/jw-nfx-new.json',
      '/atlas/catalog/series/jw-nfx-new.json',
      '/atlas/catalog/movie/jw-mxx-new.json',
    ]);
  });

  it('survives a service whose catalog is missing', async () => {
    const mixed = await arrivals('/atlas', [{ id: 1899, country: 'FI' }], atlas);
    expect(mixed.flat()).toEqual([]);
  });
});

describe('trendingEverywhere', () => {
  const meta = (id: number, name: string) => ({ moviedb_id: id, name, releaseInfo: '2026' });
  const catalogs: typeof fetch = async (input) => {
    const url = String(input);
    if (url === '/atlas/catalog/movie/jw-trending.json') {
      return new Response(
        JSON.stringify({
          metas: [meta(1, 'A movie'), meta(2, 'Another movie'), { name: 'No id' }],
        }),
      );
    }
    if (url === '/atlas/catalog/series/jw-trending.json') {
      return new Response(JSON.stringify({ metas: [meta(3, 'A series')] }));
    }
    return new Response('{}', { status: 404 });
  };

  it('reads both types by TMDB id and interleaves them', async () => {
    expect(await trendingEverywhere('/atlas', catalogs)).toEqual([
      { type: 'movie', id: 1, title: 'A movie', year: 2026 },
      { type: 'tv', id: 3, title: 'A series', year: 2026 },
      { type: 'movie', id: 2, title: 'Another movie', year: 2026 },
    ]);
  });

  it('is empty when atlas is out of reach, so the caller can fall back', async () => {
    const dead: typeof fetch = async () => {
      throw new Error('offline');
    };
    expect(await trendingEverywhere('/atlas', dead)).toEqual([]);
    expect(await trendingEverywhere('/nope', catalogs)).toEqual([]);
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
