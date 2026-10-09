import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

async function controlWindowedRows(page) {
  // A browser may invalidate a content-visibility paint and deliver a stale `false` intersection between the
  // picture being drawn and the finger landing. Reproduce that boundary deterministically: the light proxy is
  // still the title's real link, and pointerdown must not replace that link before its click is dispatched.
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    const rowObservers = [];
    window.IntersectionObserver = class {
      constructor(callback, options = {}) {
        this.denCallback = callback;
        this.denTargets = new Set();
        this.denNative = new NativeObserver((entries) => callback(entries, this), options);
        if (options.rootMargin === '1250px 0px') rowObservers.push(this);
      }

      observe(target) {
        this.denTargets.add(target);
        this.denNative.observe(target);
      }

      unobserve(target) {
        this.denTargets.delete(target);
        this.denNative.unobserve(target);
      }

      disconnect() {
        this.denTargets.clear();
        this.denNative.disconnect();
      }

      takeRecords() {
        return this.denNative.takeRecords();
      }

      denFar() {
        this.denCallback(
          [...this.denTargets].map((target) => ({ target, isIntersecting: false })),
          this,
        );
      }
    };
    window.denForceWindowedRowsFar = () => rowObservers.forEach((observer) => observer.denFar());
  });
}

async function mockPosterImages(page) {
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
}

test('a first touch survives a windowed Continue Watching observer race', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await guardNetwork(page);
  await controlWindowedRows(page);
  await mockPosterImages(page);
  for (const index of [0, 1, 2]) {
    await page.goto(`${E2E_ORIGIN}/test/windowed-navigation.html`);
    const row = page.getByRole('region', { name: 'Continue Watching' });
    await row.scrollIntoViewIfNeeded();
    const track = row.locator('.track');
    await track.evaluate((element, left) => {
      element.scrollLeft = left;
      element.dispatchEvent(new Event('scroll'));
    }, index * 162);
    const card = row.getByRole('link', { name: new RegExp(`Continuing series ${index + 1}`) });
    await expect(card).toBeVisible();
    const point = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });

    await page.evaluate(() => window.denForceWindowedRowsFar());
    await expect(row.locator('.card')).toHaveCount(0);
    await expect(row.locator('.proxy')).toHaveCount(8);
    await page.touchscreen.tap(point.x, point.y);

    await expect(page).toHaveURL(new RegExp(`/tv/${6000 + index}-continuing-series-${index + 1}$`));
    await expect(
      page.getByRole('heading', { name: `Continuing series ${index + 1}` }),
    ).toBeVisible();
  }

  await page.close();
});

test('keyboard focus still promotes a windowed proxy to its full card', async ({ page }) => {
  await guardNetwork(page);
  await controlWindowedRows(page);
  await mockPosterImages(page);
  await page.goto(`${E2E_ORIGIN}/test/windowed-navigation.html`);
  await page.evaluate(() => window.denForceWindowedRowsFar());
  await expect(page.locator('.card')).toHaveCount(0);

  await page.keyboard.press('Tab');

  await expect(page.locator('.card:focus')).toHaveCount(1);
  await expect(page.locator('.card:focus')).toHaveAttribute('href', '/tv/6000-continuing-series-1');
});
