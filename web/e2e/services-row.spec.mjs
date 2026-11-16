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
  const status = row.getByRole('status');
  const retry = row.getByRole('button', { name: 'Try again' });
  await expect(status).toHaveText('Services unavailable');
  await expect(retry).toBeVisible();
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

  await retry.focus();
  await retry.click();
  await expect(requests).toHaveText('2');
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(status).toHaveText('Trying again…');
  await page.keyboard.press('Enter');
  await expect(requests, 'an activation while the retry is live does not duplicate it').toHaveText(
    '2',
  );
  expect((await row.boundingBox())?.height).toBe(reserved?.height);

  await page.evaluate(() => document.querySelector('[data-resolve-retry]').click());
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeFocused();
  expect((await row.boundingBox())?.height).toBe(reserved?.height);

  await page.evaluate(() => scrollTo(0, 0));
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('2');
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

test('a failed country waits for another country before offering a bounded retry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  await page.goto(`${E2E_ORIGIN}/test/services-row.html?result=staggered`);

  const requests = page.locator('[data-requests]');
  const row = page.getByRole('region', { name: 'Services' });
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('2');
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeVisible();
  await expect(row.getByRole('status')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.evaluate(() => document.querySelector('[data-resolve-outstanding]').click());
  const status = row.getByRole('status');
  const retry = row.getByRole('button', { name: 'Try again' });
  await expect(status).toHaveText('Services unavailable');
  await retry.focus();
  await retry.click();
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(status).toHaveText('Trying again…');
  await expect(requests).toHaveText('3');
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeVisible();
});

test('a resolved duplicate-country replacement keeps the shared browser rail in place', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  await page.goto(`${E2E_ORIGIN}/test/services-row.html?result=replacement`);

  const row = page.getByRole('region', { name: 'Services' });
  await page.evaluate(() => document.fonts.ready);
  const reserved = await row.boundingBox();
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeVisible();
  const resolved = await row.boundingBox();
  await page.evaluate(() => globalThis.replaceServicesWithDuplicate());
  await expect(row.getByRole('link', { name: 'Netflix, US' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Netflix, FI' })).toBeVisible();
  const replaced = await row.boundingBox();

  expect(resolved?.height).toBe(reserved?.height);
  expect(replaced?.height).toBe(reserved?.height);
  await expect(row.locator('.country')).toHaveText(['US', 'FI']);
});
