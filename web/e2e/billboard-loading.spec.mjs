import { test, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

for (const width of [320, 393, 844, 1280])
  test(`billboard reserves text and artwork before loading at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        reducedMotion: 'reduce',
      });
      await guardNetwork(page);
      let releaseMetadata,
        releaseImages,
        requests = 0;
      const metadata = new Promise((r) => (releaseMetadata = r)),
        images = new Promise((r) => (releaseImages = r));
      await routeTmdb(page, async (r) => {
        requests++;
        await metadata;
        await r.fulfill({
          json: {
            id: 42,
            title: 'Detail title',
            backdrop_path: '/backdrop.jpg',
            runtime: 145,
            genres: [
              { id: 878, name: 'Science Fiction' },
              { id: 12, name: 'Adventure' },
              { id: 18, name: 'Drama' },
            ],
            overview: 'A substantial movie overview that fills the allotted space. '.repeat(20),
          },
        });
      });
      await page.route('https://image.tmdb.org/**', async (r) => {
        await images;
        await r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="blue"/></svg>',
        });
      });
      await page.goto(`${E2E_ORIGIN}/test/billboard.html`);
      const hero = page.locator('.billboard');
      await expect(hero).toHaveAttribute('aria-hidden', 'true');
      const empty = await hero.boundingBox();
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
      await expect(page.locator('.slide')).toHaveCount(2);
      await expect(page.locator('.reason').first()).toHaveText('Fits your viewing taste');
      await expect(hero).not.toHaveAttribute('aria-hidden', 'true');
      // What must not move while a slide loads: the hero's own height, and where everything below it
      // starts. The words inside are deliberately NOT measured — they take the lines they need, and the
      // text block reserves its room (`.text` has a min-height and sits its content at the bottom), so a
      // one-line title leaves an empty band above itself rather than pushing anything about.
      const geometry = () =>
        page.evaluate(() => {
          const measure = (el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top + scrollY, height: r.height };
          };
          return ['.billboard', '[data-following-content]'].map((s) =>
            measure(document.querySelector(s)),
          );
        });
      const before = await geometry();
      expect(before[0].height).toBe(empty.height);
      releaseImages();
      await expect(hero.locator('img.backdrop.lit')).toHaveAttribute('src', /early.jpg$/);
      await expect(hero.locator('img.backdrop.lit')).toHaveAttribute('fetchpriority', 'high');
      expect(await geometry()).toEqual(before);
      releaseMetadata();
      await expect(page.locator('.overview').first()).toContainText('substantial movie overview');
      await expect(page.locator('.facts').first()).toHaveText('2026 · Science Fiction · Adventure');
      expect(await geometry()).toEqual(before);
      releaseImages();
      await expect(hero.locator('img.backdrop.lit')).toHaveCount(1);
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
      expect(await geometry()).toEqual(before);
      await page.locator('.dot').nth(1).click();
      await expect(page.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
      // Paging to a much longer title must not resize the hero either, however many lines it takes.
      expect((await hero.boundingBox()).height).toBe(empty.height);
      await page.screenshot({ path: test.info().outputPath(`billboard-${width}.png`) });
      expect(requests, 'concurrent metadata learning should be deduplicated').toBe(2);
    } finally {
      await browser.close();
    }
  });

test('the early personalized preload is reused by the billboard image', async ({ page }) => {
  await guardNetwork(page);
  let requests = 0;
  await page.route('https://image.tmdb.org/t/p/w1280/early.jpg', async (route) => {
    requests++;
    await route.fulfill({
      headers: { 'cache-control': 'public, max-age=600' },
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>',
    });
  });
  await routeTmdb(page, (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto(`${E2E_ORIGIN}/test/billboard.html?preload=1`);
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveAttribute(
    'href',
    /\/early\.jpg$/,
  );
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
  await expect(page.locator('img.backdrop.lit')).toHaveAttribute('src', /\/early\.jpg$/);
  await page.waitForTimeout(100);
  expect(requests).toBe(1);
});

test('the responsive hero preload and image choose one smaller mobile candidate', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 800 });
  await guardNetwork(page);
  const images = [];
  await page.route('https://image.tmdb.org/t/p/*/early.jpg', async (route) => {
    images.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      headers: { 'cache-control': 'public, max-age=600' },
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="780" height="439"></svg>',
    });
  });
  await routeTmdb(page, (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto(`${E2E_ORIGIN}/test/billboard.html?preload=1`);
  const preload = page.locator('link[rel="preload"][as="image"]');
  await expect(preload).toHaveAttribute('imagesizes', '100vw');
  await expect(preload).toHaveAttribute('imagesrcset', /w300.*300w,.*w780.*780w,.*w1280.*1280w/);
  await expect.poll(() => images).toEqual(['/t/p/w780/early.jpg']);

  await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
  const shown = page.locator('img.backdrop.lit');
  await expect(shown).toHaveAttribute('sizes', '100vw');
  await expect
    .poll(() => shown.evaluate((image) => new URL(image.currentSrc).pathname))
    .toBe('/t/p/w780/early.jpg');
  await page.waitForTimeout(100);
  expect(images, 'the matching responsive preload is reused by the visible image').toEqual([
    '/t/p/w780/early.jpg',
  ]);
});

test('a retained hidden billboard starts no current, detail, or adjacent image work', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.addInitScript(() => {
    const idle = new Map();
    let id = 0;
    window.requestIdleCallback = (callback) => {
      const next = ++id;
      idle.set(next, callback);
      return next;
    };
    window.cancelIdleCallback = (cancelled) => idle.delete(cancelled);
    window.fixtureIdleCount = () => idle.size;
    window.fixtureRunIdle = () => {
      const pending = [...idle.values()];
      idle.clear();
      for (const callback of pending) callback({ didTimeout: false, timeRemaining: () => 50 });
    };
  });
  const details = [];
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    details.push(path);
    return route.fulfill({
      json: {
        id: path.endsWith('/43') ? 43 : 42,
        title: path.endsWith('/43') ? 'Later title' : 'A short title',
        backdrop_path: path.endsWith('/43') ? '/later.jpg' : '/early.jpg',
      },
    });
  });
  const images = [];
  await page.route('https://image.tmdb.org/**', (route) => {
    images.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"/>',
    });
  });

  await page.goto(`${E2E_ORIGIN}/test/billboard.html`);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: false })),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
  await page.waitForTimeout(100);
  expect(details).toEqual([]);
  expect(images).toEqual([]);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: true })),
  );
  await expect.poll(() => images.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.fixtureIdleCount())).toBe(1);
  // Run the callback in the same task as deactivation, before Svelte's effect cleanup can cancel it. The
  // callback's own active check must be what prevents the retained page from warming its neighbours.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: false }));
    window.fixtureRunIdle();
  });
  await page.waitForTimeout(100);
  expect(details).toEqual(['/tmdb/3/movie/42']);
  expect(images).toHaveLength(1);
});

test('the document starts its exact personalized hero before the app module answers', async ({
  page,
}) => {
  const identity = 'fixture-library';
  const id = createHash('sha256').update(identity).digest('hex');
  const leadKey = `den.hero-lead.v1.${id}.fresh.all`;
  await page.addInitScript(
    ({ key, library, at }) => {
      localStorage.setItem(
        'den.links',
        JSON.stringify([
          {
            inboxKey: '0123456789abcdef',
            libraryKey: library,
            linkKey: 'fixture-link',
          },
        ]),
      );
      localStorage.setItem('den.billboard.fresh', '1');
      localStorage.setItem('den.billboard.member-post', '1');
      localStorage.setItem(key, JSON.stringify({ at, path: '/parser-early.jpg' }));
    },
    { key: leadKey, library: identity, at: Date.now() },
  );

  let releaseModule;
  const moduleGate = new Promise((resolve) => (releaseModule = resolve));
  let moduleStarted;
  const moduleRequest = new Promise((resolve) => (moduleStarted = resolve));
  await page.route('**/src/main.ts*', async (route) => {
    moduleStarted();
    await moduleGate;
    await route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  let imageStarted;
  const imageRequest = new Promise((resolve) => (imageStarted = resolve));
  await page.route('https://image.tmdb.org/t/p/w1280/parser-early.jpg', async (route) => {
    imageStarted();
    await route.fulfill({
      headers: { 'cache-control': 'public, max-age=600' },
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>',
    });
  });

  const navigating = page.goto(`${E2E_ORIGIN}/#pair=ABCD-EFGH`);
  await moduleRequest;
  await imageRequest;
  expect(typeof releaseModule, 'the image starts while the entry module is still blocked').toBe(
    'function',
  );
  releaseModule();
  await navigating;
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveAttribute(
    'href',
    /\/parser-early\.jpg$/,
  );

  // Invite and pairing fragments are not routes; Home remains the intended facet for both.
  await page.goto(`${E2E_ORIGIN}/?invite-document=1#invite=fixture`);
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveAttribute(
    'href',
    /\/parser-early\.jpg$/,
  );
  // main.ts will rewrite this old route to /movies. The parser bootstrap must not warm Home first.
  await page.goto(`${E2E_ORIGIN}/?legacy-document=1#movies`);
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveCount(0);
});
