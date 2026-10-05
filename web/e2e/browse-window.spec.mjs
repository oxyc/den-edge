import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

test('large rows keep every title reachable while mounting a bounded card window', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/browse-window.html`);

  const row = page.getByRole('region', { name: 'Windowed row' });
  const track = row.locator('.track');
  await expect(row.locator('[data-card-index]')).toHaveCount(200);
  await expect(row.locator('.card').first()).toBeVisible();

  const initial = await row.evaluate((node) => ({
    cards: node.querySelectorAll('.card').length,
    slots: node.querySelectorAll('[data-card-index]').length,
    nodes: node.querySelectorAll('*').length,
  }));
  expect(initial.slots).toBe(200);
  expect(initial.cards).toBeGreaterThan(0);
  expect(initial.cards).toBeLessThan(20);
  expect(initial.nodes).toBeLessThan(800);

  await track.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(row.locator('[data-card-index="199"] .card')).toHaveCount(1);
  await expect(row.locator('[data-card-index="0"] .card')).toHaveCount(0);
  expect(await row.locator('.card').count()).toBeLessThan(20);

  // A keyboard can land on any lightweight proxy. It becomes the real card without moving the row first.
  await row
    .locator('[data-card-index="100"] .proxy')
    .evaluate((node) => node.focus({ preventScroll: true }));
  await expect(row.locator('[data-card-index="100"] .card')).toBeFocused();

  // Retained hidden routes keep slots/scroll geometry and only the one interaction anchor needed for exact Back
  // focus; every other full card/menu tree is removed.
  await page.evaluate(() => window.fixture.setActive(false));
  expect(await row.locator('.card').count()).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.fixture.setActive(true));
  await expect(row.locator('[data-card-index="100"] .card')).toBeFocused();
  expect(await row.locator('.card').count()).toBeLessThan(20);

  await page.close();
});

test('windowing materially reduces a large row DOM', async ({ browser }, testInfo) => {
  async function measure(search = '') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await guardNetwork(page);
    await page.route('https://image.tmdb.org/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
      }),
    );
    await page.goto(`${E2E_ORIGIN}/test/browse-window.html${search}`);
    const row = page.getByRole('region', { name: 'Windowed row' });
    if (search) await expect(row.locator('.card')).toHaveCount(200);
    else await expect(row.locator('[data-card-index]')).toHaveCount(200);
    const session = await page.context().newCDPSession(page);
    const counters = await session.send('Memory.getDOMCounters');
    const rowNodes = await row.evaluate((node) => node.querySelectorAll('*').length);
    await page.close();
    return { ...counters, rowNodes };
  }

  const control = await measure('?all-cards');
  const windowed = await measure();
  await testInfo.attach('dom-windowing-metrics.json', {
    body: JSON.stringify({ control, windowed }, null, 2),
    contentType: 'application/json',
  });
  expect(windowed.rowNodes).toBeLessThan(control.rowNodes * 0.4);
  expect(windowed.nodes).toBeLessThan(control.nodes * 0.6);
});
