import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test.skip(
  process.env.DEN_TIZEN_VERSION !== '3.0',
  'Tizen 3 has the viewer-only onboarding contract',
);

test('Tizen 3 offers pairing and an accurate browser recovery handoff', async ({ page }) => {
  await routeGuestEdge(page, newEdge());
  await page.goto(E2E_ORIGIN);

  await expect(page.getByText('Open with a recovery code', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      'Open a recovery code in Den on a phone or computer, then link this TV with the QR or code above.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Look around instead' })).toBeVisible();
  await expect(page.getByLabel('Link code, twelve characters')).toBeVisible();
});
