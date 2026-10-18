import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

test('TV joins another device through encrypted pairing and retains its saved library', async ({
  browser,
  page: host,
}) => {
  const edge = newEdge();
  await routeGuestEdge(host, edge);
  await host.goto(E2E_ORIGIN);
  await host.getByRole('button', { name: 'Look around instead' }).click();
  await host.goto(`${E2E_ORIGIN}/movie/1002`);
  const saved = host.getByRole('button', { name: 'Watchlist', exact: true });
  await saved.click();
  await expect(saved).toHaveAttribute('aria-pressed', 'true');
  // Pressed is optimistic; finish the actual local save before tearing down its Worker with navigation.
  await expect(saved).not.toHaveAttribute('aria-busy', 'true');
  // Local-only libraries cannot be shared. Accept a real invite first so the
  // Worker uploads the saved title into the relay's encrypted library.
  await host.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await host
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => [...edge.libraries.values()][0].rows.size).toBeGreaterThan(0);
  await expect
    .poll(() => host.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]').length))
    .toBe(1);
  await host.goto(`${E2E_ORIGIN}/settings`);
  await host.getByRole('button', { name: /Linked devices/ }).click();
  const devices = host.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Get a code' }).click();
  const code = await devices.locator('.code').textContent();

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const tv = await context.newPage();
    await routeGuestEdge(tv, edge);
    await tv.goto(E2E_ORIGIN);
    await tv.getByLabel('Link code, twelve characters').fill(code);
    await tv.getByLabel('This device’s name').fill('Living room LG');
    await tv.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(devices.getByText('Allow “Living room LG”?')).toBeVisible();
    await devices.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(tv.getByRole('heading', { name: 'Open your Den library' })).toBeHidden();
    await tv.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(tv.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    await tv.reload();
    await expect(tv.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
});
