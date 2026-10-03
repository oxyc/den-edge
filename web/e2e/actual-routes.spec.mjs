import { guardNetwork, routeTmdb } from './network.mjs';
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('actual-routes regressions', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await guardNetwork(page);
      const errors = [];
      let docs = 0;
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docs++;
      });
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('https://image.tmdb.org/**', (r) =>
        r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
        }),
      );
      let releaseActor;
      const actorReady = new Promise((r) => (releaseActor = r));
      await routeTmdb(page, async (r) => {
        // The title's "Starring An Actor" row reads the filmography while the title is open; only the actor's own
        // page is held back. An actor with other work, as a lead has, so the row is not one that turns out empty.
        if (r.request().url().includes('/person/7/combined_credits'))
          return r.fulfill({
            json: {
              cast: [
                {
                  id: 43,
                  media_type: 'movie',
                  title: 'Another Movie',
                  poster_path: '/poster.jpg',
                  release_date: '2025-01-01',
                },
              ],
              crew: [],
            },
          });
        if (r.request().url().includes('/person/')) {
          await actorReady;
          return r.fulfill({
            json: { id: 7, name: 'An Actor', biography: 'Actor biography', cast: [] },
          });
        }
        return r.fulfill({
          json: {
            id: 42,
            title: 'The Movie',
            poster_path: '/poster.jpg',
            backdrop_path: '/backdrop.jpg',
            release_date: '2026-01-01',
            overview: 'A long description. '.repeat(250),
            genres: [{ name: 'Drama' }],
            credits: { cast: [{ id: 7, name: 'An Actor', profile_path: '/actor.jpg' }] },
            recommendations: { results: [] },
          },
        });
      });
      await page.addInitScript(() => {
        window.scrollLog = [];
        const scroll = window.scrollTo.bind(window);
        window.scrollTo = (...args) => {
          window.scrollLog.push({
            args,
            height: document.documentElement.scrollHeight,
            page: document.querySelector('[data-active="true"] h1')?.textContent,
          });
          return scroll(...args);
        };
      });
      // The fixture is a file on the dev server, so the title's path is taken before the app mounts: one
      // document, and the title is the first history entry, exactly as opening its link would give.
      await page.addInitScript(() => history.replaceState(null, '', '/movie/42'));
      await page.goto(`${E2E_ORIGIN}/test/actual-routes.html`);
      // Loaded, and through its fade in: a picture caught mid-fade is a different frame from the next one.
      await page.waitForFunction(() => {
        const backdrop = document.querySelector('[data-active="true"] .backdrop.shown');
        return backdrop && !backdrop.getAnimations().length;
      });
      // Offscreen lazy actor images need not load before capturing the visible page.
      await page.evaluate(async () => {
        const visible = Array.from(document.images).filter((image) => {
          const box = image.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
        });
        await Promise.race([
          Promise.all(visible.map((image) => image.decode().catch(() => {}))),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('visible fixture images did not decode')), 5000),
          ),
        ]);
      });
      const liveFrame = await page.screenshot({
        path: test.info().outputPath('live-detail-' + width + '.png'),
      });
      await page.evaluate(async () => {
        const { capturePage } = await import('/src/lib/pageSnapshot.ts');
        const overlay = document.createElement('div');
        overlay.dataset.visualCheck = '';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9;pointer-events:none';
        overlay.append(capturePage().show());
        document.body.append(overlay);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const frozenFrame = await page.screenshot({
        path: test.info().outputPath('frozen-detail-' + width + '.png'),
      });
      await test
        .info()
        .attach('live-detail-' + width, { body: liveFrame, contentType: 'image/png' });
      await test
        .info()
        .attach('frozen-detail-' + width, { body: frozenFrame, contentType: 'image/png' });
      // Pixel for pixel, but for antialiasing: an edge the compositor happens to draw on a layer in one and not
      // the other differs by a level or two, which no eye can see and no change of layout can cause.
      const differing = await page.evaluate(
        async ([a, b]) => {
          const load = (src) =>
            new Promise((done) => {
              const image = new Image();
              image.onload = () => done(image);
              image.src = 'data:image/png;base64,' + src;
            });
          const pixels = (image) => {
            const canvas = new OffscreenCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, image.width, image.height).data;
          };
          const [one, two] = (await Promise.all([load(a), load(b)])).map(pixels);
          let count = 0;
          for (let i = 0; i < one.length; i++) if (Math.abs(one[i] - two[i]) > 2) count++;
          return count;
        },
        [liveFrame.toString('base64'), frozenFrame.toString('base64')],
      );
      assert.equal(
        differing,
        0,
        'detail snapshot must paint exactly like the live detail, including its backdrop',
      );
      await page.evaluate(() => document.querySelector('[data-visual-check]').remove());
      const actor = page
        .locator('[data-active="true"]')
        .getByRole('region', { name: 'Cast & Crew' })
        .getByRole('link', { name: 'An Actor' });
      await actor.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => scrollY);
      await page.evaluate(
        () => (window.heading = document.querySelector('[data-active="true"] h1')),
      );
      await actor.click();
      await page.waitForSelector('[data-loading-snapshot]');
      assert.equal(
        await page.locator('[data-loading-snapshot] h1').innerText(),
        'The Movie',
        'keep outgoing snapshot while actor data loads',
      );
      assert.equal(await page.locator('[data-loading-snapshot] [role="status"]').count(), 1);
      releaseActor();
      await page.waitForSelector('[data-loading-snapshot]', { state: 'detached' });
      await page.waitForSelector('[data-active="true"] h1:text-is("An Actor")');
      await page.waitForTimeout(300);
      await page.goBack();
      await page.waitForSelector('[data-active="true"] h1:text-is("The Movie")');
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => scrollY);
      console.log(
        JSON.stringify({
          width,
          before,
          after,
          errors,
          docs,
          debug: await page.evaluate(() => ({
            log: window.scrollLog,
            same: window.heading === document.querySelector('[data-active="true"] h1'),
          })),
        }),
      );
      assert.ok(before > 300);
      assert.equal(after, before);
      assert.deepEqual(errors, []);
      assert.equal(docs, 1);
      for (const forward of [true, false]) {
        await page.evaluate((forward) => {
          const target = document.querySelector('[data-active="true"]');
          const coords = forward
            ? [innerWidth - 5, innerWidth - 50, innerWidth - 150]
            : [5, 50, 150];
          for (const [i, type] of ['touchstart', 'touchmove', 'touchend'].entries()) {
            const touch = new Touch({ identifier: 1, target, clientX: coords[i], clientY: 300 });
            target.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: i === 2 ? [] : [touch],
                changedTouches: [touch],
              }),
            );
          }
        }, forward);
        await page.waitForSelector('[data-swipe-preview]', { state: 'detached' });
        assert.equal(
          await page.locator('[data-active="true"] h1').innerText(),
          forward ? 'An Actor' : 'The Movie',
        );
      }
      assert.equal(await page.evaluate(() => scrollY), before);
      assert.equal(
        await page.evaluate(
          () => window.heading === document.querySelector('[data-active="true"] h1'),
        ),
        true,
      );
      assert.equal(docs, 1);
      assert.deepEqual(errors, [], 'swipes must not introduce runtime errors');
      console.log(
        width +
          ': actor spinner over snapshot, repeated swipe-forward/back, preserved movie DOM and scroll, one document request passed',
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
