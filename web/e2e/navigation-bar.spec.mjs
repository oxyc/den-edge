import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

test('desktop Back traverses nested details and direct links have a Home fallback', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/navigation-bar.html');
    const back = page.getByRole('button', { name: 'Back', exact: true });
    await expect(back).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Den home' }).locator('img')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 900));
    await page.locator('[data-active="true"]').getByText('Details', { exact: true }).click();
    await expect(back).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole('link', { name: 'Den home' })
          .locator('img')
          .evaluate((img) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('desktop-nav.png') });
    await page.locator('[data-active="true"]').getByText('Person', { exact: true }).click();
    await expect(page.locator('[data-active="true"] h1')).toHaveText('person');
    await back.click();
    await expect(page.locator('[data-active="true"] h1')).toHaveText('title');
    await back.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-active="true"] h1')).toHaveText('library');
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(900);
    // A history entry the router has no ledger for — what an address-bar arrival leaves behind. The fixture is
    // a file on the dev server, so the path is taken directly rather than by loading the document again.
    await page.evaluate(() => {
      history.pushState(null, '', '/person/7');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await back.click();
    await expect(page.locator('[data-active="true"] h1')).toHaveText('library');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/movie/9' } })),
      );
      await expect(back).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    // Tablet widths, on search with Back showing: every tab stays inside the bar and the field has room to type.
    for (const width of [760, 820, 1099]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/search' } })),
      );
      await expect(back).toBeVisible();
      const fit = await page.evaluate(() => {
        const bar = document.querySelector('header.bar').getBoundingClientRect();
        const tabs = [...document.querySelectorAll('nav[aria-label="Main navigation"] a')]
          .map((a) => a.getBoundingClientRect())
          .filter((rect) => rect.width > 0);
        const field = document.querySelector('#nav-search').getBoundingClientRect();
        return {
          overflow: Math.max(...tabs.map((rect) => rect.right)) - bar.right,
          field: field.width,
        };
      });
      expect(fit.overflow, `tabs overflow the bar at ${width}px`).toBeLessThanOrEqual(0);
      expect(fit.field, `search field width at ${width}px`).toBeGreaterThanOrEqual(200);
    }
  } finally {
    await browser.close();
  }
});
