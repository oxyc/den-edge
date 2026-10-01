import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

// Library v4 §10: the browser that switched the library says so once, and Settings › About names the format beside
// the version, as a plain value.
test('the switch to Library v4 shows its toast, and About shows the library format', async () => {
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
    await page.goto('http://127.0.0.1:5198/test/settings.html?switched');

    await expect(page.getByRole('status').filter({ hasText: 'Library updated to v4' })).toBeVisible();

    const about = page.locator('#about');
    await expect(about.locator('#version')).toContainText('den-edge 0.242.1');
    const format = about.locator('#library-format');
    await expect(format).toContainText('Library format');
    await expect(format).toContainText('v4');
    // A value to read, not a row that opens.
    await expect(format.getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await browser.close();
  }
});
