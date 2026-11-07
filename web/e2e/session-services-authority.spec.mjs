import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

test('the real Svelte effect follows A→B→A and stale discovery cannot republish B', async ({
  page,
}) => {
  await guardNetwork(page);
  const releases = new Map();
  await page.route(`${E2E_ORIGIN}/scout/*/manifest.json`, async (route) => {
    const name = /\/scout\/([^/]+)\//.exec(route.request().url())?.[1];
    if (name === 'b') await new Promise((resolve) => releases.set(name, resolve));
    await route.fulfill({ json: { id: 'com.den.scout' } });
  });
  await page.route(`${E2E_ORIGIN}/{atlas,reel}/manifest.json`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto(`${E2E_ORIGIN}/test/session-services-authority.html`);

  await page.getByRole('button', { name: 'A' }).click();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  await page.getByRole('button', { name: 'B' }).click();
  await expect(page.getByTestId('scout')).toHaveText('');
  await page.getByRole('button', { name: 'A' }).click();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  releases.get('b')?.();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  await expect(page.getByTestId('plugins')).toContainText('/scout/a/manifest.json');
});
