import { afterEach, describe, expect, it, vi } from 'vitest';

type Proxy = Record<string, { target: string }>;

async function proxy(): Promise<Proxy> {
  vi.resetModules();
  return ((await import('../vite.config.ts')).default as { server: { proxy: Proxy } }).server.proxy;
}

afterEach(() => vi.unstubAllEnvs());

// The first import transpiles and evaluates the whole of vite.config.ts, which a busy machine stretches past
// vitest's five seconds. An import that never settles still fails, at this bound.
vi.setConfig({ testTimeout: 30_000 });

// A spec that does not route a request (WebKit's sendBeacon skips Playwright's routing entirely) falls through
// to these proxies. Under e2e that must never be a real service: a fixture's playback outcome was recorded by the
// production den-edge this way.
describe('the dev server proxy under e2e', () => {
  it('reaches nothing but a loopback address', async () => {
    vi.stubEnv('DEN_E2E', '1');
    const targets = Object.values(await proxy()).map((entry) => entry.target);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(new URL(target).hostname).toBe('127.0.0.1');
  });

  it('refuses a real den-edge named by the environment', async () => {
    vi.stubEnv('DEN_E2E', '1');
    vi.stubEnv('DEN_EDGE', 'https://d.oxy.fi');
    await expect(proxy()).rejects.toThrow(/not loopback/);
  });

  it('still points a developer at the homelab outside e2e', async () => {
    vi.stubEnv('DEN_E2E', '');
    const targets = Object.values(await proxy()).map((entry) => entry.target);
    expect(targets.some((target) => target.startsWith('http://192.168.'))).toBe(true);
  });
});
