// A Kid who reaches a title its policy withholds can ask for the Owner PIN on the spot. The real app, Worker and
// Vault: a wrong PIN writes nothing, the right one writes the same persistent per-title approval the Owner's menu
// writes, the page admits the title, and the approval is still there after a reload.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const TITLE = 1002;

async function makeProtectedHousehold(page, edge) {
  await routeGuestEdge(page, edge);
  await page.goto(`${E2E_ORIGIN}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await page.goto(`${E2E_ORIGIN}/movie/${TITLE}`);
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  const owner = page.getByRole('button', { name: 'Switch profile, current Owner' });
  await expect(owner).toBeVisible({ timeout: 30_000 });
  await owner.click();
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await page.getByLabel('New Owner PIN').fill('1234');
  await page.getByLabel('Confirm Owner PIN').fill('1234');
  await expect(page.getByRole('button', { name: 'Switch profile, current Kids' })).toBeVisible({
    timeout: 30_000,
  });
}

const heads = (edge) =>
  JSON.stringify([...edge.libraries].map(([id, library]) => [id, library.head]));

test('a Kid asks for the Owner PIN on a blocked title, and the approval persists', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'DedicatedWorker/Vault authority is covered once; package builds cover TV engines.',
  );
  test.setTimeout(180_000);
  const edge = newEdge({ profiles: true });
  await makeProtectedHousehold(page, edge);
  // Atlas withholds this one title from the Kid's policy; every other answer stays the guest edge's.
  // A same-origin Atlas, which is what lets a Kid's policy be asked at all (without one the title is unavailable).
  await page.route(`${E2E_ORIGIN}/atlas/manifest.json`, (route) =>
    route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } }),
  );
  // The policy rides on the query string, so match the path whatever follows it.
  await page.route(
    (url) => url.pathname === `/atlas/index/title/movie/${TITLE}.json`,
    (route) => route.fulfill({ json: { eligible: false, minimumAge: 18 } }),
  );

  await page.goto(`${E2E_ORIGIN}/movie/${TITLE}`);
  await expect(page.getByText('This title isn’t available on this profile.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask Owner' }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow for Kids?' });
  await expect(dialog).toBeVisible();
  const before = heads(edge);

  // A wrong PIN is refused and nothing is written.
  await dialog.getByLabel('Owner PIN').fill('0000');
  await expect(dialog.getByRole('alert')).toHaveText('That PIN didn’t match.');
  expect(heads(edge)).toBe(before);
  await expect(page.getByText('This title isn’t available on this profile.')).toBeVisible();

  // The right one writes the approval and the page admits the title.
  await dialog.getByLabel('Owner PIN').fill('1234');
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('This title isn’t available on this profile.')).toHaveCount(0);
  expect(heads(edge)).not.toBe(before);

  // The approval is durable: a fresh load of the Kid still opens the title.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('This title isn’t available on this profile.')).toHaveCount(0);
});
