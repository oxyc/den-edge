// The packaged TV build on a linked library whose log den-edge no longer holds and won't start again
// (`NEW_LIBRARIES=members`): the notice and its Linked devices handoff are reached with the remote.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const NOTICE =
  'This device’s library isn’t on Den. Your changes are kept here—join your household’s library in Settings › Linked devices.';

test('a linked TV library den-edge will not start keeps the edit and hands off to Linked devices', async ({
  page,
}) => {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  await page.goto(`${E2E_ORIGIN}/movie/1500`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('heading', { name: 'Movie 1500', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  // A saved row, then the invite: the guest library is started on den-edge with it.
  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
  await watchlist.click();
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
  await page.goto('about:blank');
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => [...edge.libraries.values()][0]?.rows.size ?? 0).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]').length))
    .toBe(1);

  // den-edge loses the log, and the grant's one library is spoken for: nothing may start it again.
  edge.libraries.clear();
  edge.grant.reserved = { id: 'another-library', tokenHash: 'another-token' };
  await page.goto(`${E2E_ORIGIN}/movie/1500`);
  await expect(page.getByRole('heading', { name: 'Movie 1500', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await watchlist.click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(NOTICE, { timeout: 30_000 });
  await expect(alert).not.toContainText('Waiting to sync');
  await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
  expect(edge.refusedStarts).toBeGreaterThan(0);
  expect(edge.libraries.size, 'nothing started a library').toBe(0);

  // The remote reaches the handoff, and Linked devices opens focused with the join code field.
  const action = alert.getByRole('button', { name: 'Open Linked devices' });
  await action.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
  const linkedDevices = page.locator('#linked-devices > .row');
  await expect(linkedDevices).toHaveAttribute('aria-expanded', 'true');
  await expect(linkedDevices).toBeFocused();
  await expect(page.locator('#join-library-code')).toBeVisible();
  expect(edge.libraries.size, 'opening Linked devices started nothing').toBe(0);
});
