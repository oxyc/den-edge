import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Routes } from './routes';
import {
  denAddonOf,
  denConfigureURL,
  DEN,
  findAddon,
  findAtlas,
  findReel,
  findScout,
  hostedInstalls,
  installsOf,
  legacyMediaSuperseded,
  migrateLegacyMedia,
  SCOUT,
} from './scout';

const ROUTES: Routes = {
  den: [{ url: 'http://192.168.86.193:8090/den' }],
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

describe('Den addon settings routes', () => {
  it('derives Hearth configure only from matching first-party route metadata', () => {
    expect(denConfigureURL('http://192.168.86.193:8090/den/sealed-cfg/manifest.json', ROUTES)).toBe(
      'http://192.168.86.193:8090/den/configure',
    );
    expect(denConfigureURL(THEIRS, ROUTES)).toBeNull();
    expect(
      denConfigureURL('http://192.168.86.193:8090/den/sealed-cfg/manifest.json', {}),
    ).toBeNull();
    expect(denConfigureURL('http://192.168.86.193:8090/den/sealed-cfg', ROUTES)).toBeNull();
  });
});

/** Manifests by URL; anything else is this origin's app shell, which is not JSON. */
function addons(manifests: Record<string, string | Record<string, unknown>>) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    const manifest = manifests[String(input)];
    return manifest
      ? new Response(JSON.stringify(typeof manifest === 'string' ? { id: manifest } : manifest))
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

describe('findScout', () => {
  const install = 'http://192.168.86.193:8090/den/sealed-cfg/manifest.json';

  it('opts into unified playback only when the configured route answers OPTIONS with 204', async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      asked.push([String(input), init]);
      return init?.method === 'OPTIONS'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: DEN.id }));
    };
    expect(await findScout([install], ROUTES, fetchImpl)).toEqual({
      install: install.replace('/manifest.json', ''),
      base: '/den/sealed-cfg',
      playback: '/den/sealed-cfg/playback',
    });
    expect(asked.map(([url]) => url)).toEqual([
      '/den/sealed-cfg/manifest.json',
      '/den/sealed-cfg/playback',
    ]);
    expect(asked[1]?.[1]).toMatchObject({ method: 'OPTIONS', cache: 'no-store' });
  });

  it('keeps combined installs on legacy playback for a concealed route or any non-204 answer', async () => {
    for (const status of [200, 404, 405, 500]) {
      const fetchImpl: typeof fetch = async (_input, init) =>
        init?.method === 'OPTIONS'
          ? new Response(null, { status })
          : new Response(JSON.stringify({ id: DEN.id }));
      expect(await findScout([install], ROUTES, fetchImpl)).toEqual({
        install: install.replace('/manifest.json', ''),
        base: '/den/sealed-cfg',
      });
    }
  });

  it('keeps combined installs on legacy playback when the live probe fails', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === 'OPTIONS') throw new TypeError('offline');
      return new Response(JSON.stringify({ id: DEN.id }));
    };
    expect(await findScout([install], ROUTES, fetchImpl)).toEqual({
      install: install.replace('/manifest.json', ''),
      base: '/den/sealed-cfg',
    });
  });

  it('accepts Hearth’s canonical id and the deployed transition id', async () => {
    for (const id of ['com.den.hearth', 'com.den.addon']) {
      const fetchImpl: typeof fetch = async (_input, init) =>
        init?.method === 'OPTIONS'
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ id }));
      expect(await findScout([install], ROUTES, fetchImpl)).toMatchObject({
        base: '/den/sealed-cfg',
      });
    }
  });
});

describe('legacyMediaSuperseded', () => {
  const hearth = 'http://192.168.86.193:8090/den/hearth-cfg/manifest.json';
  const reel = 'http://192.168.86.193:8092/reel-cfg/manifest.json';

  it('removes only legacy resources that an approved Hearth manifest proves it replaces', async () => {
    const { fetchImpl } = addons({
      '/den/hearth-cfg/manifest.json': {
        id: 'com.den.hearth',
        resources: ['stream', { name: 'subtitles' }],
      },
      '/scout/sealed-cfg/manifest.json': 'com.den.scout',
      '/subtitles/subs-cfg/manifest.json': 'com.den.subtitles',
      '/reel/reel-cfg/manifest.json': 'com.den.reel',
    });
    expect(
      await legacyMediaSuperseded([hearth, SCOUT_LAN, SUBS_LAN, reel], ROUTES, fetchImpl),
    ).toEqual([SCOUT_LAN, SUBS_LAN]);
  });

  it('keeps every legacy install until Hearth answers with a recognized id and resources', async () => {
    for (const manifest of [
      { id: 'some.other.addon', resources: ['stream', 'subtitles', 'meta'] },
      { id: 'com.den.hearth', resources: [] },
    ]) {
      const { fetchImpl } = addons({ '/den/hearth-cfg/manifest.json': manifest });
      expect(
        await legacyMediaSuperseded([hearth, SCOUT_LAN, SUBS_LAN, reel], ROUTES, fetchImpl),
      ).toEqual([]);
    }
  });

  it('accepts the transition id during a rolling Hearth upgrade', async () => {
    const { fetchImpl } = addons({
      '/den/hearth-cfg/manifest.json': { id: 'com.den.addon', resources: ['meta'] },
      '/reel/reel-cfg/manifest.json': 'com.den.reel',
    });
    expect(await legacyMediaSuperseded([hearth, reel], ROUTES, fetchImpl)).toEqual([reel]);
  });
});

describe('migrateLegacyMedia', () => {
  const reel = 'http://192.168.86.193:8092/reel-cfg/manifest.json';

  it('proves first-party manifests, exchanges their segments in a POST body, and returns a Hearth route', async () => {
    const asked: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      asked.push([url, init]);
      if (url === '/den/migrate')
        return new Response(JSON.stringify({ manifestUrl: '/den/new-sealed/manifest.json' }));
      const ids: Record<string, string> = {
        '/scout/sealed-cfg/manifest.json': 'com.den.scout',
        '/subtitles/subs-cfg/manifest.json': 'com.den.subtitles',
        '/reel/reel-cfg/manifest.json': 'com.den.reel',
      };
      return ids[url]
        ? new Response(JSON.stringify({ id: ids[url] }))
        : new Response(null, { status: 404 });
    };

    expect(await migrateLegacyMedia([SCOUT_LAN, SUBS_LAN, reel], ROUTES, fetchImpl)).toBe(
      'http://192.168.86.193:8090/den/new-sealed/manifest.json',
    );
    const migration = asked.find(([url]) => url === '/den/migrate')?.[1];
    expect(migration).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(migration?.body))).toEqual({
      scout: 'sealed-cfg',
      subs: 'subs-cfg',
      reel: 'reel-cfg',
    });
  });

  it('never exchanges unproved configs, and does nothing when Hearth is already installed', async () => {
    const post = vi.fn();
    const foreign: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') post();
      return new Response(
        JSON.stringify({ id: String(input).startsWith('/den/') ? DEN.id : 'some.other.addon' }),
      );
    };
    expect(await migrateLegacyMedia([SCOUT_LAN], ROUTES, foreign)).toBeNull();
    expect(post).not.toHaveBeenCalled();

    const hearth = 'http://192.168.86.193:8090/den/existing/manifest.json';
    expect(await migrateLegacyMedia([hearth, SCOUT_LAN], ROUTES, foreign)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses an endpoint answer that is not exactly a relative Den Hearth manifest path', async () => {
    for (const manifestUrl of [
      'https://attacker.example/manifest.json',
      '/den/../manifest.json',
      '/scout/new/manifest.json',
    ]) {
      const fetchImpl: typeof fetch = async (input) =>
        String(input) === '/den/migrate'
          ? new Response(JSON.stringify({ manifestUrl }))
          : new Response(JSON.stringify({ id: 'com.den.scout' }));
      expect(await migrateLegacyMedia([SCOUT_LAN], ROUTES, fetchImpl)).toBeNull();
    }
  });
});

describe('a table that names no address for the service', () => {
  /** What a public name serves: the household's LAN addresses and tailnet name are nobody else's. */
  const PUBLIC_ONLY: Routes = { edge: [{ url: 'https://d-api.oxy.fi' }] };

  it('reads the config segment off the install itself, whichever shape it is', async () => {
    const TAILNET = 'https://box.tail0000.ts.net:8443/scout/sealed-cfg/manifest.json';
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

  /**
   * Never a host outside the household, and never even a request. A guess is asked of this origin,
   * which on a public name means the edge logs the path — and a third-party config is often
   * plaintext, carrying its owner's debrid key. Den's own configs are sealed; other people's are
   * not ours to copy into somebody's request log.
   */
  it('never probes an addon on a host outside the household', async () => {
    const { asked, fetchImpl } = addons({});
    expect(await findAddon([THEIRS], PUBLIC_ONLY, SCOUT, fetchImpl)).toBeNull();
    expect(asked, 'a stranger’s config segment is never put in a URL').toEqual([]);
  });

  /**
   * The household's OWN install, on a public name, is refused just the same — and this is the live
   * shape, not a hypothetical: a table cut down to edge and play, with installs that are public
   * names. `d-scout.oxy.fi` is not the page's host, not the tailnet, not a LAN address and not named
   * by that table, so nothing here can tell it from a stranger's addon, and the safe answer is none.
   *
   * Which means a table that names no address for a service is not a neutral state for one whose
   * installs are public names: it is the service switched off. What turns it back on is the entry.
   */
  it('refuses the household’s own public-name install while the table names no address', async () => {
    const { asked, fetchImpl } = addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' });
    expect(await findAddon([SCOUT_PUBLIC], PUBLIC_ONLY, SCOUT, fetchImpl)).toBeNull();
    expect(asked, 'and it is never asked about either').toEqual([]);
  });

  /** Naming that public address is the whole fix, and it costs no request to the address itself. */
  it('places that install as soon as the table names its public address', async () => {
    const named: Routes = {
      ...PUBLIC_ONLY,
      scout: [{ url: 'https://d-scout.oxy.fi', access: true }],
    };
    const { asked, fetchImpl } = addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' });
    expect(await findAddon([SCOUT_PUBLIC], named, SCOUT, fetchImpl)).toEqual({
      install: 'https://d-scout.oxy.fi/sealed-cfg',
      base: '/scout/sealed-cfg',
    });
    // The entry identifies the install; it is never fetched. The browser asks this origin, which the
    // relay serves — and d-scout itself is behind Access, which a page has no service token for.
    expect(asked).toEqual(['/scout/sealed-cfg/manifest.json']);
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

describe('addons shared through a grant', () => {
  const SHARED = (addon: string) => `https://den.example/${addon}/~a1b2c3d4/manifest.json`;
  beforeEach(() =>
    vi.stubGlobal('location', { href: 'https://den.example/', hostname: 'den.example' }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('are asked on their own ~gid base, whatever the routes table says', async () => {
    const { asked, fetchImpl } = addons({ '/scout/~a1b2c3d4/manifest.json': 'com.den.scout' });
    // The library's own plugin comes first, and a shared one is what is left when it has none.
    expect(await findAddon([SHARED('scout')], {}, SCOUT, fetchImpl)).toEqual({
      install: 'https://den.example/scout/~a1b2c3d4',
      base: '/scout/~a1b2c3d4',
    });
    expect(asked).toEqual(['/scout/~a1b2c3d4/manifest.json']);
    expect(await findAddon([SHARED('atlas')], ROUTES, SCOUT, addons({}).fetchImpl)).toBeNull();
    expect(
      await findAddon(
        [SCOUT_LAN, SHARED('scout')],
        ROUTES,
        SCOUT,
        addons({ '/scout/sealed-cfg/manifest.json': 'com.den.scout' }).fetchImpl,
      ),
    ).toMatchObject({
      base: '/scout/sealed-cfg',
    });
  });

  it('find atlas and reel the same way', async () => {
    expect(
      await findAtlas(
        [SHARED('atlas')],
        {},
        addons({ '/atlas/~a1b2c3d4/manifest.json': 'com.den.atlas' }).fetchImpl,
      ),
    ).toMatchObject({ base: '/atlas/~a1b2c3d4' });
    expect(
      await findReel(
        [SHARED('reel')],
        {},
        addons({ '/reel/~a1b2c3d4/manifest.json': 'com.den.reel' }).fetchImpl,
      ),
    ).toMatchObject({ base: '/reel/~a1b2c3d4' });
  });

  it('give den-remux their ~gid subtitles install, as an origin and one segment', () => {
    expect(installsOf([SHARED('scout'), SHARED('subtitles'), SUBS_LAN], ROUTES, 'subs')).toEqual([
      'https://den.example/subtitles/~a1b2c3d4',
      'http://192.168.86.193:8093/subs-cfg',
    ]);
  });
});

describe('hostedInstalls', () => {
  it('is the config segment of each Den addon the library has, and nothing for one it lacks', () => {
    expect(
      hostedInstalls(
        [THEIRS, SCOUT_LAN, SUBS_PUBLIC, 'http://192.168.86.193:8081/atlas-cfg/manifest.json'],
        ROUTES,
      ),
    ).toEqual({ scout: 'sealed-cfg', subtitles: 'subs-cfg', atlas: 'atlas-cfg' });
  });

  it('skips an install that is not a plain base64url segment', () => {
    expect(hostedInstalls(['http://192.168.86.193:8080/a.b%20c/manifest.json'], ROUTES)).toEqual(
      {},
    );
    expect(hostedInstalls(['http://192.168.86.193:8080/~x/manifest.json'], ROUTES)).toEqual({});
    expect(hostedInstalls([], ROUTES)).toEqual({});
  });
});
