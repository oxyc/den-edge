import { expect, test } from '@playwright/test';
import { guardNetwork } from './network.mjs';

// In an iOS browser tab the browser's own edge swipe goes Back, so Den claims no touch and draws no preview of its
// own; added to the Home Screen there is no such gesture, and Den's swipe is the only way back.
for (const [name, standalone] of [
  ['an iOS browser tab', false],
  ['an iOS Home Screen app', true],
])
  test(`edge swipe in ${name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await guardNetwork(page);
    await page.addInitScript((standalone) => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'iPhone' });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
      if (standalone) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });
    }, standalone);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/movie/1' } })),
    );
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => {
      const target = document.querySelector('[data-active="true"] section');
      const send = (type, x) => {
        const touch = new Touch({ identifier: 1, target, clientX: x, clientY: 300 });
        return !target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            changedTouches: [touch],
          }),
        );
      };
      return {
        claimed: send('touchstart', 5),
        preview: (send('touchmove', 120), !!document.querySelector('[data-swipe-preview]')),
      };
    });
    expect(result).toEqual(
      standalone ? { claimed: true, preview: true } : { claimed: false, preview: false },
    );
    await context.close();
  });
