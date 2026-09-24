import { guardNetwork } from './network.mjs';
import { test, chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// A page that throws while rendering stays that page's problem: it says so and offers another try, and the rest of
// the app — the pages kept behind it, and navigating away — keeps working.
test('a page that fails says so, offers another try, and leaves the other pages be', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    await guardNetwork(page);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"] [data-page="library"]');
    const go = (path) =>
      page.evaluate(
        (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
        path,
      );
    await go('/movie/13');
    const active = page.locator('[data-route-page][data-active="true"]');
    await active.getByRole('alert').waitFor();
    assert.match(await active.getByRole('alert').innerText(), /Something went wrong on this page/);
    await page.goBack();
    await page.waitForSelector('[data-active="true"] [data-page="library"]');
    await page.goForward();
    await active.getByRole('button', { name: 'Try again' }).click();
    await page.waitForSelector('[data-active="true"] [data-page="title"]');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
