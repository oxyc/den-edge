import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// Library v4 §10: the browser that switched the library says so once, and Settings › About names the format beside
// the version, as a plain value.
test('the switch to Library v4 shows its toast, and Diagnostics shows the library format', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await guardNetwork(page);
    await page.route('**/routes', (r) => r.fulfill({ json: {} }));
    await page.route('**/version', (r) => r.fulfill({ json: { version: '0.242.1' } }));
    await page.route('**/config', (r) => r.fulfill({ json: { simklClientId: 'client-1' } }));
    await routeTmdb(page, (route) => route.fulfill({ json: { results: [], images: {} } }));
    await page.goto(`${E2E_ORIGIN}/test/settings.html?switched`);

    await expect(
      page.getByRole('status').filter({ hasText: 'Library updated to v4' }),
    ).toBeVisible();

    const diagnostics = page.locator('#diagnostics');
    await diagnostics.getByRole('button', { name: /Diagnostics/ }).click();
    await expect(diagnostics).toContainText('den-edge 0.242.1');
    await expect(diagnostics.locator('div', { hasText: 'Library format' }).last()).toContainText(
      'v4',
    );
    await expect(page.locator('#about #version, #about #library-format')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await browser.close();
  }
});
