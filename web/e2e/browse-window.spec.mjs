import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { recordFrameGeometryReads } from './frame-geometry-reads.mjs';
import { guardNetwork } from './network.mjs';

test('a retained hidden browse page owns no viewport observers or idle expansion', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.IntersectionObserver;
    const active = new Set();
    window.fixtureObserved = () => active.size;
    window.IntersectionObserver = class extends Native {
      mine = new Set();
      observe(element) {
        this.mine.add(element);
        active.add(element);
        super.observe(element);
      }
      unobserve(element) {
        this.mine.delete(element);
        active.delete(element);
        super.unobserve(element);
      }
      disconnect() {
        for (const element of this.mine) active.delete(element);
        this.mine.clear();
        super.disconnect();
      }
    };
  });
  await guardNetwork(page);
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/browse-window.html?catalog&hidden`);
  expect(await page.evaluate(() => window.fixtureObserved())).toBe(0);

  await page.evaluate(() => window.fixture.setActive(true));
  await expect.poll(() => page.evaluate(() => window.fixtureObserved())).toBeGreaterThan(0);
  await page.evaluate(() => window.fixture.setActive(false));
  await expect.poll(() => page.evaluate(() => window.fixtureObserved())).toBe(0);
});

test('large rows keep every title reachable while mounting a bounded card window', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await recordFrameGeometryReads(page);
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

  await page.evaluate(() => window.takeFrameGeometryReads());
  await track.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(row.locator('[data-card-index="199"] .card')).toHaveCount(1);
  await expect(row.locator('[data-card-index="0"] .card')).toHaveCount(0);
  expect(await row.locator('.card').count()).toBeLessThan(20);
  expect(await page.evaluate(() => window.takeFrameGeometryReads())).toEqual([]);
  const savedScrollLeft = await track.evaluate((node) => node.scrollLeft);

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
  await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBe(savedScrollLeft);
  await expect(row.locator('[data-card-index="199"] .card')).toHaveCount(1);
  expect(await row.locator('.card').count()).toBeLessThan(20);
  expect(await page.evaluate(() => window.takeFrameGeometryReads())).toEqual([]);

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

test('a row entering the viewport materializes card trees in small frame batches', async ({
  browser,
}, testInfo) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/browse-window.html?below`);
  const row = page.getByRole('region', { name: 'Windowed row' });
  await expect(row.locator('[data-card-index]')).toHaveCount(200);
  await expect(row.locator('.card')).toHaveCount(0);

  const counts = await page.evaluate(async () => {
    const row = document.querySelector('[aria-label="Windowed row"]');
    const count = () => row?.querySelectorAll('.card').length ?? 0;
    const samples = [count()];
    scrollTo({ top: document.body.scrollHeight });
    for (let index = 0; index < 20; index += 1) {
      await new Promise(requestAnimationFrame);
      samples.push(count());
    }
    return samples;
  });
  const additions = counts.slice(1).map((count, index) => count - counts[index]);
  await testInfo.attach('browse-row-materialization.json', {
    body: JSON.stringify({ counts, additions }, null, 2),
    contentType: 'application/json',
  });
  expect(Math.max(...additions)).toBeLessThanOrEqual(2);
  expect(counts.at(-1)).toBeGreaterThan(4);

  // A keyboard target is interactive immediately even if its ordinary frame has not been reached yet.
  await row
    .locator('[data-card-index="18"] .proxy')
    .evaluate((node) => node.focus({ preventScroll: true }));
  await expect(row.locator('[data-card-index="18"] .card')).toBeFocused();
  await page.close();
});
