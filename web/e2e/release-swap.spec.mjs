import { guardNetwork } from './network.mjs';
import { test, expect } from '@playwright/test';

// A release the service worker found behind the kept shell waits for the next page opened (`release.ts`): the page
// the person is on stays where it is, and the next one is loaded whole, onto the new release.
test('a waiting release is put on screen by the next page opened, never mid-visit', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('http://127.0.0.1:5198/tv/1399', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p id="swapped">the new release</p>' }),
  );
  await page.goto('http://127.0.0.1:5198/test/router.html');
  const active = page.locator('[data-route-page][data-active="true"]');
  await active.getByText('Details', { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.denSameDocument = true;
    // The module the router imported; the worker's `den:release` lands here in a built page (`main.ts`).
    (await import('/src/lib/release.ts')).releaseWaiting();
    window.scrollTo(0, 950);
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => [window.denSameDocument, scrollY])).toEqual([true, 950]);

  await active.getByText('Details', { exact: true }).click();
  await expect(page.locator('#swapped')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/tv/1399');
  expect(await page.evaluate(() => window.denSameDocument)).toBeUndefined();
});
