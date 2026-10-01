import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, type Route } from './route';

// `public/sw.js` is a classic worker script, not a module, so it is run here as one: its `fetch` listener is
// captured and handed navigations, with `caches` and `fetch` standing in for the browser's.

const ORIGIN = 'https://den.test';
const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  request: { url: string; method: string; mode: string };
  resultingClientId?: string;
  clientId?: string;
  respondWith(answer: Promise<Response>): void;
  waitUntil(work: Promise<unknown>): void;
}

/** `/` as Cloudflare hands it over: re-encoded, so with no ETag, and with den-edge's release header intact. */
const RELEASED = (release: string): Record<string, string> =>
  release ? { 'x-den-release': release } : {};

function worker(shell?: string, { network = 'r2', files = [] as string[] } = {}) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const key = (request: string | { url: string }) =>
    new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const cache = (name: string) => ({
    match: async (request: string | { url: string }) => store(name).get(key(request))?.clone(),
    put: async (request: string | { url: string }, response: Response) =>
      void store(name).set(key(request), response),
    delete: async (request: string | { url: string }) => store(name).delete(key(request)),
  });
  const caches = {
    open: async (name: string) => cache(name),
    match: async (request: { url: string }) => {
      for (const kept of stores.values()) if (kept.has(key(request))) return kept.get(key(request));
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetched: string[] = [];
  const messages: unknown[] = [];
  const fetchImpl = async (request: { url: string }) => {
    fetched.push(key(request));
    // A file of a release den-edge no longer serves.
    if (key(request).startsWith('/assets/gone')) return new Response('', { status: 404 });
    const response = new Response(`network ${key(request)}`, { headers: RELEASED(network) });
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
  class FakeRequest {
    readonly url: string;
    readonly method = 'GET';
    constructor(input: string) {
      this.url = new URL(input, ORIGIN).href;
    }
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      get: async (id?: string) =>
        id ? { postMessage: (message: unknown) => void messages.push(message) } : undefined,
    },
  };
  const appPage = new Function('self', 'caches', 'fetch', 'Request', `${SOURCE}\nreturn appPage;`)(
    self,
    caches,
    fetchImpl,
    FakeRequest,
  ) as (pathname: string) => boolean;
  // The kept shell went through Cloudflare too; an ETag on it changes nothing, as no fresh `/` carries one.
  if (shell)
    store('den-page-v1').set(
      '/',
      new Response(shell, { headers: { ...RELEASED('r1'), etag: '"r1-origin"' } }),
    );
  for (const name of files) store(name).set('/assets/kept.js', new Response('kept'));

  /** The answer the worker gives a navigation to `path`, or undefined when it leaves it to the network. */
  async function navigate(path: string) {
    let answer: Promise<Response> | undefined;
    const behind: Promise<unknown>[] = [];
    listeners.get('fetch')!({
      request: { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'navigate' },
      resultingClientId: 'page',
      respondWith: (response) => (answer = response),
      waitUntil: (work) => void behind.push(work),
    });
    const body = answer && (await (await answer).text());
    await Promise.all(behind);
    return body;
  }
  /** The answer the worker gives the page's request for one of the build's files. */
  async function asset(path: string) {
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')!({
      request: { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'cors' },
      clientId: 'page',
      respondWith: (response) => (answer = response),
      waitUntil: () => undefined,
    });
    return (await answer)?.status;
  }
  /** The worker taking over: what it clears out of what an earlier one kept. */
  async function activate() {
    const behind: Promise<unknown>[] = [];
    listeners.get('activate')!({
      waitUntil: (work: Promise<unknown>) => void behind.push(work),
    } as never);
    await Promise.all(behind);
  }
  return {
    appPage,
    navigate,
    asset,
    activate,
    fetched,
    messages,
    kept: () => [...store('den-page-v1').keys()],
    /** The release the kept shell is from. */
    keptRelease: async () =>
      (await cache('den-page-v1').match('/'))?.headers.get('x-den-release') ?? null,
    fileCaches: () => [...stores.keys()].filter((name) => name.startsWith('den-files-')).sort(),
  };
}

describe('the service worker', () => {
  const app = [
    '/',
    '/movies',
    '/series',
    '/watchlist',
    '/settings',
    '/search',
    '/search?q=blade+runner&c=genre-28',
    '/people',
    '/people?t=role-director',
    '/movie/550-fight-club',
    '/tv/1399',
    '/person/287-brad-pitt',
    '/service/8-us-netflix',
  ];
  const server = [
    '/oauth/authorize?client_id=x',
    '/oauth/request/0123/approve',
    '/grant/redeem',
    '/grant/abcd1234',
    '/mcp',
    '/connect',
    '/connect?request=abc',
    '/.well-known/oauth-authorization-server',
    '/lib/abc/changes',
    '/link',
    '/pair/new',
    '/inbox/drain',
    '/routes',
    '/config',
    '/health',
    '/tmdb/3/movie/550',
    '/scout/manifest.json',
    '/atlas/catalog',
    '/remux/session',
    '/p/ticket',
    '/sw.js',
    '/og.png',
    '/settings/extra',
    '/movie/550/credits',
    '/movies/extra',
  ];

  it('answers every navigation to an app page with the kept shell', async () => {
    // A fresh worker each: the check behind an answer replaces what is kept with the network's copy.
    for (const path of app)
      expect(await worker('kept shell').navigate(path), path).toBe('kept shell');
  });

  it('leaves every navigation den-edge answers itself to the network', async () => {
    const { navigate } = worker('kept shell');
    for (const path of server) expect(await navigate(path), path).toBeUndefined();
  });

  it('names exactly the pages the router reads', () => {
    const { appPage } = worker();
    // One of every page the router knows: a new kind of page fails to type-check here until it is listed.
    const pages: Record<Route['page'], Route> = {
      library: { page: 'library' },
      movies: { page: 'movies' },
      series: { page: 'series' },
      watchlist: { page: 'watchlist' },
      settings: { page: 'settings' },
      search: { page: 'search', query: 'dune', chips: ['genre-28'] },
      people: { page: 'people', traits: ['role-director'] },
      title: { page: 'title', type: 'tv', id: 1399 },
      person: { page: 'person', id: 287 },
      service: { page: 'service', id: 8, country: 'US' },
    };
    for (const route of Object.values(pages)) {
      const path = new URL(routePath(route), ORIGIN).pathname;
      expect(appPage(path), path).toBe(true);
      expect(parseRoute(path).page, path).toBe(route.page);
    }
    // And a path the router reads as Home only because it knows nothing of it is not answered as a page.
    for (const path of server) expect(appPage(new URL(path, ORIGIN).pathname), path).toBe(false);
  });

  it('keeps only the plain shell at `/`, never a page the preview rewrote', async () => {
    const cold = worker();
    expect(await cold.navigate('/movie/550')).toBe('network /movie/550');
    expect(cold.fetched.sort()).toEqual(['/', '/movie/550']);
    expect(cold.kept()).toEqual(['/']);

    const warm = worker('kept shell');
    expect(await warm.navigate('/movie/550')).toBe('kept shell');
    expect(warm.fetched).toEqual(['/']);
  });

  it('finds a release by its header when `/` arrives with no ETag, and tells the page without reloading it', async () => {
    const current = worker('kept shell');
    expect(await current.navigate('/')).toBe('kept shell');
    expect(await current.keptRelease()).toBe('r2');
    // The page is told a release is waiting, and moves onto it with the next page opened (`release.test.ts`).
    expect(current.messages).toEqual(['den:release']);
    // That next load is the new release, and finds nothing newer.
    expect(await current.navigate('/movie/550')).toBe('network /');
    expect(current.messages).toEqual(['den:release']);
  });

  it('tells the page nothing when the release is the one it kept', async () => {
    const same = worker('kept shell', { network: 'r1' });
    expect(await same.navigate('/')).toBe('kept shell');
    expect(same.messages).toEqual([]);
  });

  it('keeps files under their release, and only the releases a page runs or moves to', async () => {
    const files = [
      'den-files-r0',
      'den-files-r1',
      'den-files-"etag-named"',
      'den-files-unreleased',
    ];
    const current = worker('kept shell', { files });
    expect(await current.asset('/assets/Home-abc.js')).toBe(200);
    expect(current.fileCaches()).toEqual(files.sort());

    await current.navigate('/');
    expect(current.fileCaches()).toEqual(['den-files-r1']);
    expect(await current.asset('/assets/Detail-def.js')).toBe(200);
    expect(current.fileCaches()).toEqual(['den-files-r1', 'den-files-r2']);
  });

  it('clears the never-pruned files kept before releases were named, once it takes over', async () => {
    const current = worker('kept shell', { files: ['den-files-r1', 'den-files-unreleased'] });
    await current.activate();
    expect(current.fileCaches()).toEqual(['den-files-r1']);
  });

  it('keeps no file when den-edge names no release', async () => {
    const cold = worker(undefined, { network: '' });
    await cold.navigate('/');
    expect(await cold.asset('/assets/Home-abc.js')).toBe(200);
    expect(cold.fileCaches()).toEqual([]);
  });

  it('drops a kept shell whose release is gone and tells the page, which moves on with the next page', async () => {
    const { asset, kept, messages } = worker('kept shell');
    expect(await asset('/assets/Detail-abc.js')).toBe(200);
    expect(kept()).toEqual(['/']);
    expect(messages).toEqual([]);

    expect(await asset('/assets/gone-Detail-old.js')).toBe(404);
    expect(kept()).toEqual([]);
    expect(messages).toEqual(['den:release']);
  });
});
