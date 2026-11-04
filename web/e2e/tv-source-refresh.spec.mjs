import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { sourceRefreshFixture } from './source-refresh-fixture.mjs';

test('TV title refresh keeps the prior list when limited and warms only after admission', async ({
  page,
}) => {
  const requests = await sourceRefreshFixture(page, { bundled: true });
  await page.goto(`${E2E_ORIGIN}/test/detail-parity.html?fixturePath=%2Fmovie%2F42`);
  const panel = page.locator('[data-active="true"] .source-panel');
  const sources = page
    .locator('[data-active="true"] header.hero')
    .getByRole('button', { name: 'Sources', exact: true });
  await sources.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Prior.Movie.1080p.mkv')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sources, 1 available' })).toBeFocused();
  const plainBefore = requests.plain;
  const refresh = panel.getByRole('button', { name: 'Check for sources again', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(
    panel.getByRole('status').filter({ hasText: 'Sources were checked recently' }),
  ).toBeVisible();
  await expect(panel.getByText('Prior.Movie.1080p.mkv')).toBeVisible();
  expect(requests).toMatchObject({ fresh: 1, plain: plainBefore });
  const retry = panel.getByRole('button', { name: 'Try again', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Rebuilt.Movie.1080p.mkv')).toBeVisible();
  await expect.poll(() => requests.plain).toBe(plainBefore + 1);
  expect(requests.fresh).toBe(2);
});
