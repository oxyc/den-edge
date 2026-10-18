// A page opened in a background tab, or in an occluded window, is hidden: the browser gives it no animation frames.
// A returning Owner's page holds its retained billboard, and waited two frames before starting the app so the
// billboard could paint first — so a hidden one started nothing at all until it was shown (desktop Chrome logged
// `den: startup +7212ms app module requested`). It must start at once instead: there is no paint to make room for.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';

/** What a hidden document is: hidden, and never given a frame. */
function hiddenDocument() {
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { get: () => true });
  window.requestAnimationFrame = () => 0;
}

test('a returning Owner’s page opened hidden starts the app without waiting to be shown', async () => {
  test.setTimeout(240_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const edge = newEdge({ profiles: true });
    await bigHousehold(context, edge);
    // The kept billboard the document draws from: Home keeps it once its ranking's encrypted copy has landed
    // (`recommend.ts` `keepPersonalBackdrop`), which a slow machine reaches after the household's own setup is done.
    const keeping = await context.newPage();
    await routeBigHousehold(keeping, edge);
    await keeping.goto(`${E2E_ORIGIN}/`);
    await expect
      .poll(
        () =>
          keeping.evaluate(() =>
            // `den.hero-lead.current.v1.<fresh.?><facet>` (`heroLeadPointer.ts`): Home's, whichever form it keeps.
            Object.keys(localStorage).some((key) =>
              /^den\.hero-lead\.current\.v1\.(?:fresh\.)?all$/.test(key),
            ),
          ),
        { timeout: 60_000, message: 'Home kept its billboard lead' },
      )
      .toBe(true);
    await keeping.close();

    const page = await context.newPage();
    await routeBigHousehold(page, edge);
    await page.addInitScript(hiddenDocument);
    const started = [];
    page.on('console', (message) => {
      const match = /den: startup \+(\d+)ms app module requested/.exec(message.text());
      if (match) started.push(Number(match[1]));
    });
    await page.goto(`${E2E_ORIGIN}/`);
    // The case under test: the page holds a retained billboard, which is what made it wait for frames.
    await expect(
      page.locator('[data-den-early-billboard]:not([hidden]) [data-den-early-backdrop][data-path]'),
    ).toHaveCount(1);
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(1);
    expect(started[0]).toBeLessThan(2_000);
  } finally {
    await browser.close();
  }
});
