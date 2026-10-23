import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('service directories are admitted only as their rail approaches the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  await page.goto(`${E2E_ORIGIN}/test/services-row.html`);

  const requests = page.locator('[data-requests]');
  const row = page.getByRole('region', { name: 'Services' });
  await expect(requests).toHaveText('0');
  const reserved = await row.boundingBox();
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('1');
  await expect(row.getByText('Services unavailable')).toBeVisible();
  const track = row.locator('.track');
  await expect(track).toHaveCSS('padding-left', '0px');
  await expect(track).toHaveCSS('padding-right', '0px');
  const [headingBox, firstTileBox] = await Promise.all([
    row.getByRole('heading', { name: 'Services' }).boundingBox(),
    row.locator('.hold').first().boundingBox(),
  ]);
  expect(headingBox).not.toBeNull();
  expect(firstTileBox).not.toBeNull();
  expect(Math.abs(firstTileBox.x - headingBox.x)).toBeLessThanOrEqual(1);
  const settled = await row.boundingBox();
  expect(settled?.height).toBe(reserved?.height);

  await page.evaluate(() => scrollTo(0, 0));
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('1');
});

test('the Services rail uses the phone viewport, not the desktop presentation maximum', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${E2E_ORIGIN}/test/services-row.html`);

  const row = page.getByRole('region', { name: 'Services' });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.right ?? box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
