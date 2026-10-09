import { guardNetwork } from './network.mjs';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// A release a missing chunk found (`recoverChunkFailure`, `release.ts`) waits for the next page opened when
// reloading right now would cost something on screen: the page the person is on stays where it is, and the
// next one is loaded whole, onto the new release.
test('a waiting release is put on screen by the next page opened, never mid-visit', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route(`${E2E_ORIGIN}/tv/1399`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p id="swapped">the new release</p>' }),
  );
  await page.goto(`${E2E_ORIGIN}/test/router.html`);
  const active = page.locator('[data-route-page][data-active="true"]');
  await active.getByText('Details', { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.denSameDocument = true;
    // The module the router imported; `recoverChunkFailure` marks a release waiting the same way.
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

// A release can replace the Worker/session lifecycle under an old Home document without making one of its
// already-loaded chunks fail. The quiet shell probe finds that handoff first; the Continue Watching press then
// loads the destination as a new document, so no retained route can keep running the superseded lifecycle.
test('a newer shell puts a Continue Watching destination on the new release', async ({ page }) => {
  await guardNetwork(page);
  let releaseChecks = 0;
  await page.route(`${E2E_ORIGIN}/test/router.html`, async (route) => {
    if (route.request().method() === 'HEAD') {
      releaseChecks += 1;
      return route.fulfill({ headers: { 'x-den-release': 'new-shell' } });
    }
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'server-timing': 'den-release;desc="old-shell"',
      },
    });
  });
  await page.route(`${E2E_ORIGIN}/tv/6066-verano-azul`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p id="swapped">Verano azul</p>' }),
  );
  await page.goto(`${E2E_ORIGIN}/test/router.html`);
  const active = page.locator('[data-route-page][data-active="true"]');
  await active.getByText('Details', { exact: true }).waitFor();

  await page.evaluate(async () => {
    window.denSameDocument = true;
    const link = [...document.querySelectorAll('a')].find((candidate) =>
      candidate.textContent?.includes('Details'),
    );
    if (!link) throw new Error('fixture detail link missing');
    link.href = '/tv/6066-verano-azul';
    link.textContent = 'Verano azul';
    const [{ loadRelease }, { watchRelease }] = await Promise.all([
      import('/src/lib/diagnosticsReport.ts'),
      import('/src/lib/release.ts'),
    ]);
    await watchRelease(loadRelease()).check();
  });

  expect(releaseChecks).toBe(1);
  expect(await page.evaluate(() => window.denSameDocument)).toBe(true);
  await active.getByRole('link', { name: 'Verano azul' }).click();
  await expect(page.locator('#swapped')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/tv/6066-verano-azul');
  expect(await page.evaluate(() => window.denSameDocument)).toBeUndefined();
});
