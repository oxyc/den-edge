import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

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
    await page.goto(`${E2E_ORIGIN}/test/navigation-bar.html`);
    const back = page.getByRole('button', { name: 'Back', exact: true });
    await expect(back).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Den home' }).locator('img')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 900));
    await page.locator('[data-active="true"]').getByText('Details', { exact: true }).click();
    await expect(back).toBeVisible();
    const brand = page.getByRole('link', { name: 'Den home' });
    const home = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Home', exact: true });
    for (const control of [brand, home, back]) {
      await control.focus();
      await expect(control).toHaveCSS('border-radius', '8px');
    }
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
      const bar = await page.locator('header.bar').boundingBox();
      expect(bar).toMatchObject({ x: 16, width: width - 32 });
      expect(
        Math.abs(bar.y + bar.height - (800 - 12)),
        `phone bar is not pinned above the bottom inset at ${width}px`,
      ).toBeLessThanOrEqual(2);
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--page-max').trim(),
        ),
      ).toBe('100%');
    }
    // The smallest current iPad viewport uses the compact controls but keeps the tablet bar at the top.
    await page.setViewportSize({ width: 744, height: 900 });
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/search' } })),
    );
    await expect(back).toBeHidden();
    expect((await page.locator('header.bar').boundingBox()).y).toBe(12);
    // Tablet widths, on search with Back showing: every tab stays inside the bar and the field has room to type.
    for (const width of [760, 820, 1099]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/search' } })),
      );
      await expect(back).toBeVisible();
      const bar = await page.locator('header.bar').boundingBox();
      expect(bar.y, `tablet bar moved away from the top at ${width}px`).toBe(12);
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
    await page.setViewportSize({ width: 2560, height: 1200 });
    const ultrawide = await page.locator('header.bar').boundingBox();
    expect(ultrawide).toMatchObject({ x: 368, width: 1824 });
  } finally {
    await browser.close();
  }
});
