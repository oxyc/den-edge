import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

for (const scenario of [
  { name: 'late filmography in portrait', width: 390, height: 800, scrolled: false },
  { name: 'late filmography after rotation', width: 844, height: 600, scrolled: false },
  { name: 'bottom scroll clamped after rotation', width: 844, height: 600, scrolled: true },
])
  test('actor Forward: ' + scenario.name, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
      await guardNetwork(page);
      await page.addInitScript(() => {
        const start = document.startViewTransition?.bind(document);
        window.fixtureTransition = Promise.resolve();
        if (start)
          document.startViewTransition = (...args) => {
            const transition = start(...args);
            window.fixtureTransition = transition.finished.catch(() => {});
            return transition;
          };
      });
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('https://image.tmdb.org/**', (r) =>
        r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
        }),
      );
      let releaseFilms;
      const filmsReady = new Promise((resolve) => (releaseFilms = resolve));
      await page.route('https://api.themoviedb.org/**', async (r) => {
        const url = r.request().url();
        if (url.includes('combined_credits')) {
          await filmsReady;
          return r.fulfill({
            json: {
              cast: Array.from({ length: 24 }, (_, i) => ({
                id: 100 + i,
                media_type: 'movie',
                title: 'Actor film ' + i,
                poster_path: '/poster.jpg',
                release_date: '2020-01-01',
                vote_count: 1000,
                popularity: 100 - i,
              })),
            },
          });
        }
        if (url.includes('/person/'))
          return r.fulfill({
            json: {
              id: 7,
              name: 'An Actor',
              profile_path: '/actor.jpg',
              biography: 'Actor biography. '.repeat(100),
            },
          });
        return r.fulfill({
          json: {
            id: 42,
            title: 'The Movie',
            poster_path: '/poster.jpg',
            backdrop_path: '/backdrop.jpg',
            overview: 'A long description. '.repeat(100),
            credits: { cast: [{ id: 7, name: 'An Actor' }] },
            recommendations: { results: [] },
          },
        });
      });
      await page.goto('http://127.0.0.1:5198/test/actual-routes.html#title/movie/42');
      await page.locator('[data-active="true"] a').filter({ hasText: 'An Actor' }).click();
      await expect(page.locator('[data-active="true"] h1')).toHaveText('An Actor');
      await page.waitForSelector('[data-loading-snapshot]', { state: 'detached' });
      // A visible heading does not mean the View Transition has released its frozen rendering.
      await page.evaluate(() => window.fixtureTransition);
      if (scenario.scrolled) {
        releaseFilms();
        // The heading exists during loading. Wait for cards, then let the sentinel load the final page.
        await expect(page.locator('[data-active="true"] .films .card')).toHaveCount(20);
        await page.locator('[data-active="true"] .load-more').scrollIntoViewIfNeeded();
        await expect(page.locator('[data-active="true"] .films .card')).toHaveCount(24);
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        expect(await page.evaluate(() => scrollY)).toBeGreaterThan(800);
      }
      await page.goBack();
      await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
      releaseFilms();
      await expect(page.locator('[data-active="false"] .films .card')).toHaveCount(
        scenario.scrolled ? 24 : 20,
      );
      await page.evaluate(() => window.fixtureTransition);
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
          if (this.hasAttribute('data-swipe-preview') && frames[0].opacity === 1) {
            return { finished: new Promise((resolve) => (window.releaseLanding = resolve)) };
          }
          return animate.call(this, frames, options);
        };
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.evaluate(() => {
          window.releaseLanding = null;
          const target = document.querySelector('[data-active="true"]');
          for (const [type, x] of [
            ['touchstart', innerWidth - 5],
            ['touchmove', innerWidth - 150],
            ['touchend', innerWidth - 250],
          ]) {
            const touch = new Touch({ identifier: 1, target, clientX: x, clientY: 300 });
            target.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: type === 'touchend' ? [] : [touch],
                changedTouches: [touch],
              }),
            );
          }
        });
        await page.waitForFunction(() => typeof window.releaseLanding === 'function');
        await expect(page.locator('[data-swipe-preview] h2')).toContainText(['Filmography']);
        const geometry = await page.evaluate(() => {
          const read = (root) =>
            [root, ...root.querySelectorAll('img, .person, .filmography, .card')].map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                tag: el.tagName,
                top: rect.top,
                height: rect.height,
                width: rect.width,
                complete: el.complete,
                naturalWidth: el.naturalWidth,
              };
            });
          return {
            scrollY,
            max: document.documentElement.scrollHeight - innerHeight,
            frozen: read(document.querySelector('[data-swipe-preview] > div > div')),
            live: read(document.querySelector('[data-active="true"]')),
          };
        });
        const frozen = await page.screenshot({ path: test.info().outputPath('frozen.png') });
        await page
          .locator('[data-swipe-preview]')
          .evaluate((el) => (el.style.visibility = 'hidden'));
        const live = await page.screenshot({ path: test.info().outputPath('live.png') });
        await test.info().attach('actor-frozen', { body: frozen, contentType: 'image/png' });
        await test.info().attach('actor-live', { body: live, contentType: 'image/png' });
        if (!frozen.equals(live)) console.log('snapshot mismatch', JSON.stringify(geometry));
        expect(
          frozen.equals(live),
          'actor Forward snapshot must match live content after background loading and rotation',
        ).toBe(true);
        await page.evaluate(() => window.releaseLanding());
        await page.waitForSelector('[data-swipe-preview]', { state: 'detached' });
        if (cycle === 0) {
          await page.goBack();
          await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
          await page.evaluate(() => window.fixtureTransition);
        }
      }
    } finally {
      await browser.close();
    }
  });
