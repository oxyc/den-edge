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
  const trackBox = await track.boundingBox();
  expect(trackBox).not.toBeNull();
  expect(Math.abs(trackBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(trackBox.width - page.viewportSize().width)).toBeLessThanOrEqual(1);
  await expect(track).toHaveCSS('padding-left', '0px');
  await expect(track).toHaveCSS('padding-right', '0px');
  const settled = await row.boundingBox();
  expect(settled?.height).toBe(reserved?.height);

  await page.evaluate(() => scrollTo(0, 0));
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('1');
});
