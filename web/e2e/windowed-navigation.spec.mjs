import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

async function controlWindowedRows(page, startFar = false) {
  // Reproduce the false intersection delivery observed at the first-touch boundary without depending on browser
  // scheduling. Tests can deliver it after the live cards paint, or start with a legitimately dormant shelf.
  await page.addInitScript((initiallyFar) => {
    const NativeObserver = window.IntersectionObserver;
    const rowObservers = [];
    window.IntersectionObserver = class {
      constructor(callback, options = {}) {
        this.denCallback = callback;
        this.denTargets = new Set();
        this.denNative = new NativeObserver((entries) => callback(entries, this), options);
        this.denInitiallyFar = initiallyFar && options.rootMargin === '1250px 0px';
        if (options.rootMargin === '1250px 0px') rowObservers.push(this);
      }

      observe(target) {
        this.denTargets.add(target);
        if (this.denInitiallyFar) {
          this.denCallback([{ target, isIntersecting: false }], this);
        } else {
          this.denNative.observe(target);
        }
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
    // Times on the page's clock how long after this call the last card is released. A loaded runner polls the page
    // late, so a wall-clock expect cannot tell a release that came on time from one that did not.
    window.denStartReleaseClock = () => {
      const start = performance.now();
      window.denReleasedAfter = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.card')) return;
          observer.disconnect();
          resolve(performance.now() - start);
        });
        if (!document.querySelector('.card')) return resolve(0);
        observer.observe(document.body, { childList: true, subtree: true });
      });
    };
  }, startFar);
}

async function expectReleasedWithin(page, ms) {
  await expect(page.locator('.card')).toHaveCount(0);
  expect(await page.evaluate(() => window.denReleasedAfter)).toBeLessThan(ms);
}

async function mockPosterImages(page) {
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
}

test('a visible Continue Watching shelf stays mounted through a stale observer exit and first touch', async ({
  browser,
}) => {
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
    const mountedAfterExit = await page.evaluate(async () => {
      window.denForceWindowedRowsFar();
      await new Promise(requestAnimationFrame);
      return document.querySelectorAll('.windowed .card').length;
    });
    // The observed failure replaced these links immediately: the row vanished and the URL stayed on Home.
    // Keep them stable through the touch/click that follows the exit.
    expect(mountedAfterExit).toBeGreaterThan(0);
    await page.touchscreen.tap(point.x, point.y);

    await expect(page).toHaveURL(new RegExp(`/tv/${6000 + index}-continuing-series-${index + 1}$`));
    await expect(
      page.getByRole('heading', { name: `Continuing series ${index + 1}` }),
    ).toBeVisible();
  }

  await page.close();
});

test('a genuinely distant windowed shelf still releases its card trees after the touch grace', async ({
  page,
}) => {
  await guardNetwork(page);
  await controlWindowedRows(page);
  await mockPosterImages(page);
  await page.goto(`${E2E_ORIGIN}/test/windowed-navigation.html`);
  await expect(page.locator('.card')).not.toHaveCount(0);

  await page.evaluate(() => {
    window.denStartReleaseClock();
    window.denForceWindowedRowsFar();
  });

  await expectReleasedWithin(page, 1_000);
  await expect(page.locator('.proxy')).toHaveCount(8);
});

test('a pointer released outside the shelf clears its interaction pin', async ({ page }) => {
  await guardNetwork(page);
  await controlWindowedRows(page);
  await mockPosterImages(page);
  await page.goto(`${E2E_ORIGIN}/test/windowed-navigation.html`);
  const card = page.getByRole('link', { name: 'Continuing series 1' });
  await expect(card).toBeVisible();
  // Moving the pressed pointer off the card would drag it, which ends the press with pointercancel and no release.
  // Cancel the drag at the document: the card's artwork can be replaced after it paints, so marking the elements
  // there now undraggable can miss the one that is pressed.
  await page.evaluate(() =>
    document.addEventListener('dragstart', (event) => event.preventDefault()),
  );
  const point = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.evaluate(() => window.denForceWindowedRowsFar());
  // The active press keeps the real link mounted even beyond the ordinary retirement grace.
  await page.waitForTimeout(500);
  await expect(card).toBeVisible();

  await page.mouse.move(5, 5);
  // Focus leaves with the release, in the same task, so the clock covers only the shelf's own retirement.
  await page.evaluate(() =>
    window.addEventListener(
      'pointerup',
      () => {
        window.denStartReleaseClock();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      },
      { once: true },
    ),
  );
  await page.mouse.up();

  await expectReleasedWithin(page, 1_000);
  await expect(page.locator('.proxy')).toHaveCount(8);
});

test('keyboard focus still promotes a windowed proxy to its full card', async ({ page }) => {
  await guardNetwork(page);
  await controlWindowedRows(page, true);
  await mockPosterImages(page);
  await page.goto(`${E2E_ORIGIN}/test/windowed-navigation.html`);
  await expect(page.locator('.card')).toHaveCount(0);

  await page.keyboard.press('Tab');

  await expect(page.locator('.card:focus')).toHaveCount(1);
  await expect(page.locator('.card:focus')).toHaveAttribute('href', '/tv/6000-continuing-series-1');
});
