import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());
vi.setConfig({ testTimeout: 30_000 });

async function tvCapability(
  platform: 'webos' | 'tizen',
  tizenVersion?: string,
  packaged = false,
): Promise<string> {
  vi.resetModules();
  vi.stubEnv('DEN_TV_PLATFORM', platform);
  if (tizenVersion) vi.stubEnv('DEN_TIZEN_VERSION', tizenVersion);
  vi.stubEnv('DEN_TV_PACKAGED', packaged ? '1' : '');
  if (packaged) vi.stubEnv('DEN_TV_API_ORIGIN', 'https://tv.example.invalid');
  const config = (await import('../vite.tv.config.ts')).default as {
    define: Record<string, string>;
  };
  return config.define.__DEN_MANAGED_PLAYBACK_RECEIPTS__;
}

it('keeps managed-playback receipt crypto on browser, webOS and current Tizen builds', async () => {
  vi.resetModules();
  const browser = (await import('../vite.config.ts')).default as {
    define: Record<string, string>;
  };
  expect(browser.define.__DEN_MANAGED_PLAYBACK_RECEIPTS__).toBe('true');
  expect(await tvCapability('webos')).toBe('true');
  expect(await tvCapability('tizen', '6.5')).toBe('true');
});

it('marks both hosted and packaged Tizen 3 artifacts permanently unsupported', async () => {
  expect(await tvCapability('tizen', '3.0')).toBe('false');
  expect(await tvCapability('tizen', '3.0', true)).toBe('false');
});
