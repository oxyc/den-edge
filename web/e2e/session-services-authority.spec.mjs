import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

test('the real Svelte effect follows A→B→A and stale discovery cannot republish B', async ({
  page,
}) => {
  await guardNetwork(page);
  const releases = new Map();
  await page.route(`${E2E_ORIGIN}/scout/*/manifest.json`, async (route) => {
    const name = /\/scout\/([^/]+)\//.exec(route.request().url())?.[1];
    if (name === 'b') await new Promise((resolve) => releases.set(name, resolve));
    await route.fulfill({ json: { id: 'com.den.scout' } });
  });
  await page.route(`${E2E_ORIGIN}/{atlas,reel}/manifest.json`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto(`${E2E_ORIGIN}/test/session-services-authority.html`);

  await page.getByRole('button', { name: 'A', exact: true }).click();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  await page.getByRole('button', { name: 'B' }).click();
  await expect(page.getByTestId('scout')).toHaveText('');
  await page.getByRole('button', { name: 'A', exact: true }).click();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  releases.get('b')?.();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  await expect(page.getByTestId('plugins')).toContainText('/scout/a/manifest.json');
});

test('automatic remux persistence and an unrelated plugin keep the active player mounted', async ({
  page,
}) => {
  await guardNetwork(page);
  let releaseRemux;
  const remuxHeld = new Promise((resolve) => (releaseRemux = resolve));
  await page.route(`${E2E_ORIGIN}/scout/*/manifest.json`, (route) =>
    route.fulfill({ json: { id: 'com.den.scout' } }),
  );
  await page.route(`${E2E_ORIGIN}/{atlas,reel}/manifest.json`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route(`${E2E_ORIGIN}/reel/health`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route(`${E2E_ORIGIN}/remux/health`, async (route) => {
    await remuxHeld;
    await route.fulfill({ json: { status: 'ok' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/session-services-authority.html`);

  await page.getByRole('button', { name: 'A', exact: true }).click();
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
  await page.getByTestId('active-player').evaluate((player) => {
    player.dataset.session = 'original';
  });

  // The discovery callback persists this hint through the model and causes the fixture's production-shaped Svelte
  // effect to configure again. The exact player node proves Scout was never withdrawn between those turns.
  releaseRemux();
  await expect(page.getByTestId('private-remux')).toContainText('/remux');
  await expect(page.getByTestId('active-player')).toHaveAttribute('data-session', 'original');

  await page.getByRole('button', { name: 'Add unrelated' }).click();
  await expect(page.getByTestId('plugins')).toContainText('/scout/extra/manifest.json');
  await expect(page.getByTestId('active-player')).toHaveAttribute('data-session', 'original');
  await expect(page.getByTestId('scout')).toContainText('/scout/a');
});
