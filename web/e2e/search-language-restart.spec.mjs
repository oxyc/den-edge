import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const route = encodeURIComponent('/search?q=heist&fixtureSearchLanguageRace=1');

test('shared Search aborts and restarts an active query when interface language changes', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/routes', (request) => request.fulfill({ json: {} }));
  await page.route('**/atlas/**', (request) => request.fulfill({ status: 404, body: '' }));
  await page.goto(`${E2E_ORIGIN}/test/nav-search.html?at=${route}`);
  await expect
    .poll(() => page.evaluate(() => window.denSearchLanguageRace?.signals.length))
    .toBe(1);

  await page.evaluate(() => window.denSearchLanguageRace.setLanguage('sv'));

  await expect
    .poll(() =>
      page.evaluate(() => ({
        requests: window.denSearchLanguageRace.signals.length,
        oldAborted: window.denSearchLanguageRace.signals[0]?.aborted,
      })),
    )
    .toEqual({ requests: 2, oldAborted: true });
  await expect(page.getByRole('link', { name: /Fresh Swedish/ })).toBeVisible();

  await page.evaluate(() => window.denSearchLanguageRace.releaseOld());
  await page.waitForTimeout(100);
  await expect(page.getByRole('link', { name: /Fresh Swedish/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Stale English/ })).toHaveCount(0);
});
