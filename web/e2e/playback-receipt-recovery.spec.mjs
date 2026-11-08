import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE as SEED_FIXTURE, routeLibraryEdge } from './library-edge.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/live-position.html`;

test('the production library exposes one bounded receipt retry and announces recovery', async ({
  page,
}) => {
  await routeLibraryEdge(page, {});
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );

  const releases = [];
  let attempts = 0;
  await page.route(`${E2E_ORIGIN}/playback/receipts/drain`, async (route) => {
    const attempt = attempts++;
    await new Promise((resolve) => releases.push(resolve));
    if (attempt === 0) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    return route.fulfill({ json: { messages: [] } });
  });

  await page.goto(`${SEED_FIXTURE}?seed`);
  await page.getByRole('status').filter({ hasText: 'Worker library seeded' }).waitFor();
  await page.goto(FIXTURE);

  await expect.poll(() => attempts).toBe(1);
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
