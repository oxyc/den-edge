import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('remote-owned Services retry is accessible, bounded, and geometry-stable', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/services-row.html`);

  const requests = page.locator('[data-requests]');
  const row = page.getByRole('region', { name: 'Services' });
  await row.scrollIntoViewIfNeeded();
  const reserved = await row.boundingBox();
  await expect(requests).toHaveText('1');

  const retry = row.getByRole('button', { name: 'Try again' });
  const status = row.getByRole('status');
  await expect(status).toHaveText('Services unavailable');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(requests).toHaveText('2');
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(status).toHaveText('Trying again…');

  await page.keyboard.press('Enter');
  await expect(requests, 'a second remote press cannot duplicate the live request').toHaveText('2');
  expect((await row.boundingBox())?.height).toBe(reserved?.height);

  await page.evaluate(() => document.querySelector('[data-resolve-retry]').click());
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeFocused();
  expect((await row.boundingBox())?.height).toBe(reserved?.height);
});
