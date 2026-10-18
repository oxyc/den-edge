import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test.describe('Samsung TV platform bootstrap', () => {
  test.skip(process.env.DEN_TV_PLATFORM !== 'tizen', 'Tizen platform contract');

  test('registers supported media keys once and cleans them up on pagehide', async ({ page }) => {
    await routeGuestEdge(page, newEdge());
    await page.addInitScript(() => {
      globalThis.__denTvPlatformCalls = [];
      globalThis.tizen = {
        tvinputdevice: {
          getSupportedKeys: () => [
            { name: 'MediaPlayPause', code: 10252 },
            { name: 'MediaStop', code: 10253 },
          ],
          registerKeyBatch: (names) => globalThis.__denTvPlatformCalls.push(['register', names]),
          unregisterKeyBatch: (names) =>
            globalThis.__denTvPlatformCalls.push(['unregister', names]),
        },
      };
    });

    await page.goto(`${E2E_ORIGIN}/?tv-diagnostics=1`);
    await expect
      .poll(() => page.evaluate(() => globalThis.__denTvPlatformCalls))
      .toEqual([['register', ['MediaPlayPause', 'MediaStop']]]);

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect
      .poll(() => page.evaluate(() => globalThis.__denTvPlatformCalls))
      .toEqual([
        ['register', ['MediaPlayPause', 'MediaStop']],
        ['unregister', ['MediaPlayPause', 'MediaStop']],
      ]);
  });

  test('falls through when the optional Tizen application exit method is absent', async ({
    page,
  }) => {
    await routeGuestEdge(page, newEdge());
    await page.addInitScript(() => {
      globalThis.__denTvPlatformCalls = [];
      globalThis.tizen = {
        application: { getCurrentApplication: () => ({}) },
        tvinputdevice: { getSupportedKeys: () => [] },
      };
      globalThis.webOS = {
        platformBack: () => globalThis.__denTvPlatformCalls.push(['webos-exit']),
      };
      window.confirm = () => true;
    });
    await page.goto(`${E2E_ORIGIN}/`);
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true });
      Object.defineProperty(event, 'keyCode', { value: 10009 });
      document.body.dispatchEvent(event);
    });
    await expect
      .poll(() => page.evaluate(() => globalThis.__denTvPlatformCalls))
      .toEqual([['webos-exit']]);
  });
});
