import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_AUTHORITY_HEADERS } from './upstream.ts';

type ProxyEntry = {
  target: string;
  rewrite?: (path: string) => string;
  configure?: (proxy: EventEmitter) => void;
};
type Proxy = Record<string, ProxyEntry>;

function strippedBy(entry: ProxyEntry): string[] {
  const proxy = new EventEmitter();
  const removed: string[] = [];
  entry.configure?.(proxy);
  proxy.emit('proxyReq', { removeHeader: (name: string) => removed.push(name) });
  return removed;
}

function headersSetBy(entry: ProxyEntry): Record<string, string> {
  const proxy = new EventEmitter();
  const headers: Record<string, string> = {};
  entry.configure?.(proxy);
  proxy.emit('proxyReq', { setHeader: (name: string, value: string) => (headers[name] = value) });
  return headers;
}

async function proxy(tv: boolean): Promise<Proxy> {
  vi.resetModules();
  const config = (tv ? await import('../vite.tv.config.ts') : await import('../vite.config.ts'))
    .default as { server: { proxy: Proxy }; preview?: { proxy: Proxy } };
  if (tv) expect(config.preview?.proxy).toEqual(config.server.proxy);
  return config.server.proxy;
}

afterEach(() => vi.unstubAllEnvs());

// The first import transpiles and evaluates the whole of vite.config.ts, which a busy machine stretches past
// vitest's five seconds. An import that never settles still fails, at this bound.
vi.setConfig({ testTimeout: 30_000 });

// A spec that does not route a request (WebKit's sendBeacon skips Playwright's routing entirely) falls through
// to these proxies. Under e2e that must never be a real service: a fixture's playback outcome was recorded by the
// production den-edge this way.
describe.each([false, true])('the dev server proxy under e2e (TV: %s)', (tv) => {
  it('reaches nothing but a loopback address', async () => {
    vi.stubEnv('DEN_E2E', '1');
    const targets = Object.values(await proxy(tv)).map((entry) => entry.target);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(new URL(target).hostname).toBe('127.0.0.1');
  });

  it('refuses a real den-edge named by the environment', async () => {
    vi.stubEnv('DEN_E2E', '1');
    vi.stubEnv('DEN_EDGE', 'https://d.oxy.fi');
    await expect(proxy(tv)).rejects.toThrow(/not loopback/);
  });

  it('uses the public guest stack without reaching the private homelab', async () => {
    vi.stubEnv('DEN_E2E', '');
    const configured = await proxy(tv);
    const targets = Object.values(configured).map((entry) => entry.target);
    expect(
      targets.some((target) =>
        /^https?:\/\/(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(target),
      ),
    ).toBe(false);
    expect(configured['/health'].target).toBe('https://d.oxy.fi');
    expect(headersSetBy(configured['/health'])).toEqual({ host: 'd.oxy.fi' });
    expect(configured['/assistant'].target).toBe('https://d.oxy.fi');
    expect(configured['/performance'].target).toBe('https://d.oxy.fi');
    expect(configured['/atlas'].target).toBe('https://d.oxy.fi');
    expect(configured['/atlas'].rewrite?.('/atlas/manifest.json')).toBe('/atlas/manifest.json');
    expect(configured['/reel'].target).toBe('https://d.oxy.fi');
    expect(configured['/reel'].rewrite?.('/reel/meta/movie/1.json')).toBe(
      '/reel/meta/movie/1.json',
    );
    expect(configured['/remux'].target).toBe('https://d.oxy.fi');
    expect(strippedBy(configured['/atlas'])).toEqual([]);
    expect(strippedBy(configured['/reel'])).toEqual([]);
    expect(strippedBy(configured['/remux'])).toEqual([]);
  });

  it('strips /atlas only for an explicitly selected standalone Atlas', async () => {
    vi.stubEnv('DEN_E2E', '');
    vi.stubEnv('DEN_ATLAS', 'http://127.0.0.1:8081');
    const configured = await proxy(tv);
    expect(configured['/atlas'].target).toBe('http://127.0.0.1:8081');
    expect(configured['/atlas'].rewrite?.('/atlas/manifest.json')).toBe('/manifest.json');
    expect(strippedBy(configured['/atlas'])).toEqual(EDGE_AUTHORITY_HEADERS);
  });

  it('strips /reel only for an explicitly selected standalone Reel', async () => {
    vi.stubEnv('DEN_E2E', '');
    vi.stubEnv('DEN_REEL', 'http://127.0.0.1:8092');
    const configured = await proxy(tv);
    expect(configured['/reel'].target).toBe('http://127.0.0.1:8092');
    expect(configured['/reel'].rewrite?.('/reel/meta/movie/1.json')).toBe('/meta/movie/1.json');
    expect(strippedBy(configured['/reel'])).toEqual(EDGE_AUTHORITY_HEADERS);
  });

  it('does not lend Edge authority to an explicitly selected standalone Remux', async () => {
    vi.stubEnv('DEN_E2E', '');
    vi.stubEnv('DEN_REMUX', 'http://127.0.0.1:8095');
    const configured = await proxy(tv);
    expect(strippedBy(configured['/remux'])).toEqual(EDGE_AUTHORITY_HEADERS);
  });

  it("keeps a local Edge's credentials off the public stack's service relays", async () => {
    vi.stubEnv('DEN_E2E', '');
    vi.stubEnv('DEN_EDGE', 'http://127.0.0.1:18080');
    const configured = await proxy(tv);
    expect(configured['/lib'].target).toBe('http://127.0.0.1:18080');
    expect(strippedBy(configured['/lib'])).toEqual([]);
    for (const path of ['/atlas', '/reel', '/remux']) {
      expect(configured[path].target).toBe('https://d.oxy.fi');
      expect(strippedBy(configured[path])).toEqual(EDGE_AUTHORITY_HEADERS);
    }
  });
});

// TV and production-build configs replace webServer rather than merging it. Both build and preview subprocesses must
// inherit the guard; checking the Vite target alone would miss a Playwright configuration that never enables it.
it.each([
  '../playwright.tv.config.ts',
  '../playwright.tv-package.config.ts',
  '../playwright.production.config.ts',
])('%s enables upstream isolation for its web server', async (path) => {
  const { default: config } = await import(path);
  expect(config.webServer.env.DEN_E2E).toBe('1');
  expect(config.webServer.reuseExistingServer).toBe(false);
});

it('builds TV handoff journeys with an explicit household Web origin', async () => {
  vi.resetModules();
  const { default: config } = await import('../playwright.tv.config.ts');
  expect(config.webServer.env.DEN_TV_WEB_ORIGIN).toBe('https://household.example');
});
