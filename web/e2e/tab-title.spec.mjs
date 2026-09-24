import { guardNetwork, routeTmdb } from './network.mjs';
import { test, chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// Every kept page stays mounted, and Svelte runs a child's effects before its parent's: a title page that set
// `document.title` itself was renamed "Den" by App on coming back to it, and a kept page could rename the one
// on screen. The page on screen offers its name (`tabName`) and only the app writes it.
test('the tab names the page on screen, including a kept page returned to', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    const go = (path) =>
      page.evaluate(
        (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
        path,
      );
    const titled = (name) => page.waitForFunction((name) => document.title === name, name);
    await titled('library');
    await go('/movie/1');
    await titled('Title 1');
    await go('/movies');
    await titled('movies');
    await page.goBack();
    await titled('Title 1');
    await go('/movie/2');
    await titled('Title 2');
    await page.goBack();
    await titled('Title 1');
    await page.waitForTimeout(100);
    assert.equal(await page.title(), 'Title 1');
  } finally {
    await browser.close();
  }
});

// Playing a film from its title page makes that page inactive, so it stops naming the tab: the player names it.
test('the tab keeps the title while its player is open', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ status: 404, json: {} }));
    await page.goto('http://127.0.0.1:5198/test/player.html');
    await page.waitForFunction(() => document.title === 'The Movie (2001) · Den');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForFunction(() => document.title === 'Den');
  } finally {
    await browser.close();
  }
});
