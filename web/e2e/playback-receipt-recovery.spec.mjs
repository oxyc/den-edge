import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

test('the production library exposes one bounded receipt retry and announces recovery', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());

  const releases = [];
  let attempts = 0;
  await page.route(`${E2E_ORIGIN}/playback/receipts/drain`, async (route) => {
    const attempt = attempts++;
    await new Promise((resolve) => releases.push(resolve));
    if (attempt === 0) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    return route.fulfill({ json: { messages: [] } });
  });

  // Start a real member library through the shipped invite path. The production build deliberately carries only
  // its seed entry beside the app, not source-only fixture pages.
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();

  await expect.poll(() => attempts, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole('status')).toContainText('Checking saved playback progress…');
  releases.shift()();
  await expect(page.getByRole('alert')).toContainText(
    'Saved playback progress couldn’t be updated. Try again.',
  );
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('status')).toContainText('Checking saved playback progress…');
  releases.shift()();
  await expect(page.getByRole('status')).toContainText('Saved playback progress is up to date.');
  await expect.poll(() => attempts).toBe(2);
});
