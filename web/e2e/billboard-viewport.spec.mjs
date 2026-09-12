import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

for (const touch of [true, false])
  test(`billboard viewport stability: ${touch ? 'touch toolbar' : 'desktop resize'}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 800 },
        hasTouch: touch,
      });
      await guardNetwork(page);
      await page.goto('http://127.0.0.1:5198/test/billboard.html');
      const hero = page.locator('.billboard');
      await expect(hero).toBeVisible();
      const before = await hero.boundingBox();
      const following = await page
        .locator('[data-following-content]')
        .evaluate((el) => el.getBoundingClientRect().top + scrollY);
      await page.evaluate(() => scrollTo(0, 250));
      await page.setViewportSize({ width: 390, height: 950 });
      await page.waitForTimeout(100);
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
    } finally {
      await browser.close();
    }
  });
