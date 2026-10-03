import { guardNetwork } from './network.mjs';
import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('snapshots regressions', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await guardNetwork(page);
      await page.goto(`${E2E_ORIGIN}/test/snapshot.html`);
      await page.waitForSelector('.hero');
      await page.waitForTimeout(350);
      const result = await page.evaluate(async () => {
        scrollTo(0, 140);
        document.querySelector('.rail').scrollLeft = 400;
        const { capturePage } = await import('/src/lib/pageSnapshot.ts');
        const animated = document.querySelector('.animated');
        animated.getAnimations().forEach((a) => a.pause());
        const before = getComputedStyle(animated);
        const visual = { transform: before.transform, opacity: before.opacity };
        const snapshot = capturePage();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99;';
        overlay.append(snapshot.show());
        document.body.append(overlay);
        const second = document.createElement('div');
        second.style.cssText = 'position:fixed;inset:0;z-index:100;';
        second.append(snapshot.show());
        document.body.append(second);
        if (!overlay.querySelector('.hero') || !second.querySelector('.hero'))
          throw Error('Showing snapshot twice must not move shared DOM');
        await new Promise((r) => requestAnimationFrame(r));
        if (second.querySelector('.rail').scrollLeft !== 400)
          throw Error('Second snapshot must retain rail position');
        second.remove();
        const live = document.querySelector('#app .hero').getBoundingClientRect();
        const frozen = overlay.querySelector('.hero').getBoundingClientRect();
        const computed = getComputedStyle(overlay.querySelector('.animated'));
        return {
          visual,
          frozenVisual: { transform: computed.transform, opacity: computed.opacity },
          live: { top: live.top, left: live.left, width: live.width, height: live.height },
          frozen: {
            top: frozen.top,
            left: frozen.left,
            width: frozen.width,
            height: frozen.height,
          },
          rail: overlay.querySelector('.rail').scrollLeft,
        };
      });
      console.log(width, result);
      assert.deepEqual(
        result.frozen,
        result.live,
        'snapshot and live page must occupy identical pixels',
      );
      assert.equal(result.rail, 400);
      assert.deepEqual(
        result.frozenVisual,
        result.visual,
        'snapshot must preserve the painted animation frame',
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

// Leaving a page measures it; copying it waits until the copy is wanted, and a hidden page that has changed
// since is copied again, so the copy is never older than the page it stands for.
test('a snapshot copies the page only when shown, and again once the hidden page has changed', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.goto(`${E2E_ORIGIN}/test/snapshot.html`);
  await page.waitForSelector('.hero');
  const result = await page.evaluate(async () => {
    const { capturePage } = await import('/src/lib/pageSnapshot.ts');
    const source = document.querySelector('[data-route-page]');
    let clones = 0;
    const clone = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function (deep) {
      if (deep && this === source) clones++;
      return clone.call(this, deep);
    };
    const snapshot = capturePage();
    const measured = clones;
    source.hidden = true;
    const first = snapshot.show().textContent.includes('Snapshot geometry');
    const shown = clones;
    snapshot.show();
    const reused = clones;
    source.querySelector('h1').textContent = 'Changed while hidden';
    await new Promise((r) => setTimeout(r));
    const again = snapshot.show().textContent.includes('Changed while hidden');
    // A swipe asks for the hidden page's current layout. In the same window that is the copy already in hand;
    // laying the page out again offscreen was a long frame on the swipe's first move.
    const kept = snapshot.refresh() === snapshot;
    window.snapshot = snapshot;
    return { measured, first, shown, reused, again, copies: clones, kept };
  });
  expect(result).toEqual({
    measured: 0,
    first: true,
    shown: 1,
    reused: 1,
    again: true,
    copies: 2,
    kept: true,
  });
  // A turned phone is a different window, and the page is measured again in it.
  await page.setViewportSize({ width: 600, height: 400 });
  expect(await page.evaluate(() => window.snapshot.refresh() === window.snapshot)).toBe(false);
});
