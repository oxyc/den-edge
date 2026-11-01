import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

for (const touch of [true, false])
  test(`billboard viewport stability: ${touch ? 'touch toolbar' : 'desktop resize'}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      // A phone-width billboard has a fixed height, so the desktop case resizes a window wide enough to
      // take its height from the viewport.
      const width = touch ? 390 : 700;
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: touch,
      });
      await guardNetwork(page);
      await page.goto(`${E2E_ORIGIN}/test/billboard.html`);
      const hero = page.locator('.billboard');
      await expect(hero).toBeVisible();
      const before = await hero.boundingBox();
      expect(before).toMatchObject({ x: 0, width });
      if (touch) expect(before.height).toBe(430);
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--page-max').trim(),
        ),
      ).toBe('100%');
      const following = await page
        .locator('[data-following-content]')
        .evaluate((el) => el.getBoundingClientRect().top + scrollY);
      await page.evaluate(() => scrollTo(0, 250));
      // The hero re-measures from a resize listener, which the page runs on a frame after setViewportSize
      // has returned. Wait for the page's own resize event (registered after the hero's, so it runs after it)
      // instead of guessing how long that takes.
      const resized = page.evaluate(
        () =>
          new Promise((resolve) =>
            addEventListener('resize', () => requestAnimationFrame(resolve), { once: true }),
          ),
      );
      await page.setViewportSize({ width, height: 950 });
      await resized;
      const after = await hero.boundingBox();
      if (touch) {
        expect(after.height).toBe(before.height);
        expect(
          await page
            .locator('[data-following-content]')
            .evaluate((el) => el.getBoundingClientRect().top + scrollY),
        ).toBe(following);
        expect(await page.evaluate(() => scrollY)).toBe(250);
      } else expect(after.height).toBeGreaterThan(before.height);
      await page.setViewportSize({ width: 844, height: 600 });
      await expect.poll(async () => (await hero.boundingBox()).height).toBe(456);
      expect(await hero.boundingBox()).toMatchObject({ x: 0, width: 844 });
    } finally {
      await browser.close();
    }
  });

test('an ultrawide window keeps the billboard on the centred 1920×1080 canvas', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 2560, height: 1200 } });
  await guardNetwork(page);
  await page.goto(`${E2E_ORIGIN}/test/billboard.html`);

  const hero = page.locator('.billboard');
  await expect(hero).toBeVisible();
  expect(await hero.boundingBox()).toMatchObject({ x: 320, width: 1920, height: 1080 });
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--page-max').trim(),
    ),
  ).toBe('1920px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(2560);
  await page.close();
});
