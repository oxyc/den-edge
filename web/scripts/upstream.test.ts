import { afterEach, describe, expect, it, vi } from 'vitest';

type Proxy = Record<string, { target: string }>;

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

  it('still points a developer at the homelab outside e2e', async () => {
    vi.stubEnv('DEN_E2E', '');
    const targets = Object.values(await proxy(tv)).map((entry) => entry.target);
    expect(targets.some((target) => target.startsWith('http://192.168.'))).toBe(true);
  });
});

// TV configs replace webServer rather than merging it. Both build and preview subprocesses must inherit
// the guard; checking the Vite target alone would miss a Playwright configuration that never enables it.
it.each(['../playwright.tv.config.ts', '../playwright.tv-package.config.ts'])(
  '%s enables upstream isolation for its web server',
  async (path) => {
    const { default: config } = await import(path);
    expect(config.webServer.env.DEN_E2E).toBe('1');
    expect(config.webServer.reuseExistingServer).toBe(false);
  },
);
