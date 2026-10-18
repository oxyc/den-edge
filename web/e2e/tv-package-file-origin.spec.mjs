import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { E2E_PORT } from './base-url.mjs';

// This is a browser URL/history regression only. It does not prove Samsung Web Workers, AVPlay, or hardware behavior.
test.use({ launchOptions: { args: ['--allow-file-access-from-files'] } });
const entry = pathToFileURL(
  resolve(import.meta.dirname, '..', `dist-tv-tizen-package-e2e-${E2E_PORT}`, 'index.html'),
).href;

test('packaged bootstrap and TV navigation start from a file origin', async ({ page }) => {
  await page.goto(`${entry}#/`);
  const locationInfo = await page.evaluate(() => ({
    href: location.href,
    origin: location.origin,
    protocol: location.protocol,
  }));
  console.log(`file-origin regression location: ${JSON.stringify(locationInfo)}`);
  expect(locationInfo.protocol).toBe('file:');
  expect(['file://', 'null']).toContain(locationInfo.origin);
  await expect(page.getByRole('button', { name: 'Look around instead' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/index\.html#\/settings$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/index\.html#\/$/);
});
