import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('service directories are admitted only as their rail approaches the viewport', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/services-row.html`);

  const requests = page.locator('[data-requests]');
  const row = page.getByRole('region', { name: 'Services' });
  await expect(requests).toHaveText('0');
  const reserved = await row.boundingBox();
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('1');
  await expect(row.getByText('Services unavailable')).toBeVisible();
  const settled = await row.boundingBox();
  expect(settled?.height).toBe(reserved?.height);

  await page.evaluate(() => scrollTo(0, 0));
  await row.scrollIntoViewIfNeeded();
  await expect(requests).toHaveText('1');
});
