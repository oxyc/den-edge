// A page left behind stays mounted (`RoutePage`), and a trailer on it was heard from the page in front: leaving a
// title whose trailer was playing with sound left it talking. Whatever page a trailer plays on — Home's billboard,
// a title's hero, a service's billboard — leaving it, by a link or by Back, stops it and silences it.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const videoBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const film = {
  id: 42,
  imdb_id: 'tt42',
  title: 'The Movie',
  media_type: 'movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  release_date: '2026-01-01',
  overview: 'A film.',
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
  genres: [{ id: 18, name: 'Drama' }],
  credits: { cast: [{ id: 7, name: 'An Actor' }] },
  recommendations: { results: [] },
};

async function mock(page) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  await routeTmdb(page, (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/(tmdb\/)?3\//, '/');
    if (path.endsWith('/combined_credits')) return r.fulfill({ json: { cast: [], crew: [] } });
    if (path.startsWith('/person/')) return r.fulfill({ json: { id: 7, name: 'An Actor' } });
    if (path.startsWith('/watch/providers/'))
      return r.fulfill({
        json: {
          results: [
            { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
          ],
        },
      });
    // One answer that reads both as this film and as a list holding it, whichever was asked.
    return r.fulfill({ json: { ...film, page: 1, total_pages: 1, results: [film] } });
  });
  // This origin serves reel, which offers one file that plays.
  await page.route('**/reel/manifest.json', (r) => r.fulfill({ json: { id: 'com.den.reel' } }));
  await page.route('**/reel/prepare/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.route('**/reel/meta/**', (r) =>
    r.fulfill({
      json: {
        meta: {
          links: [
            {
              trailers: 'http://internal/play/trailer.webm',
              sources: 'http://internal/sources/trailer.json',
            },
          ],
        },
      },
    }),
  );
  await page.route('**/sources/trailer.json**', (r) =>
    r.fulfill({
      json: {
        sources: [
          { kind: 'mp4', url: 'http://internal/m/s/trailer.webm', audio: true, height: 720 },
        ],
        crop: null,
      },
    }),
  );
  await page.route('**/m/s/trailer.webm', (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : videoBytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/webm',
      body: videoBytes.subarray(start, end + 1),
      headers: {
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}),
      },
    });
  });
}

/** Every video in the document: where it is, and whether it is playing or could be heard. */
const videos = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('video')].map((video) => ({
      onActivePage: !!video.closest('[data-route-page][data-active="true"]'),
      playing: !video.paused,
      audible: !video.muted,
    })),
  );

/** Nothing plays off the page in front, and nothing anywhere can be heard. */
async function expectQuiet(page) {
  await expect
    .poll(async () =>
      (await videos(page)).filter((v) => v.audible || (v.playing && !v.onActivePage)),
    )
    .toEqual([]);
}

const go = (page, path) =>
  page.evaluate(
    (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
    path,
  );

test('a title’s trailer, playing with sound, stops and goes quiet when its page is left', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  // Home is the first entry, as opening the app gives.
  await page.addInitScript(() => history.replaceState(null, '', '/'));
  await page.goto(`${E2E_ORIGIN}/test/actual-routes.html`);
  await go(page, '/movie/42');
  const active = page.locator('[data-active="true"]');
  await expect(active.locator('h1')).toHaveText('The Movie');
  const trailer = active.locator('[data-detail-media] video');
  await expect(trailer).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  await active.getByRole('button', { name: 'Play trailer with sound' }).click();
  expect(await trailer.evaluate((v) => !v.muted && !v.paused)).toBe(true);

  // By a link: the actor in its cast.
  await active
    .getByRole('region', { name: 'Cast & Crew' })
    .getByRole('link', { name: 'An Actor' })
    .click();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('An Actor');
  await expectQuiet(page);

  // Back to it, where it plays again, quietly; then away by Back.
  await page.goBack();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  await expect(trailer).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  await expectQuiet(page);
  await active.getByRole('button', { name: 'Play trailer with sound' }).click();
  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/');
  await expectQuiet(page);
  // Home's own billboard trailer comes on, quietly, and nothing else does.
  await expect(page.locator('[data-active="true"] video.ambient')).toHaveClass(/\bplaying\b/, {
    timeout: 15000,
  });
  await expectQuiet(page);
});

// Coming back to a title whose trailer was playing shows the frame it was left on, and carries on from there: the
// backdrop is never shown in between, and the trailer does not start over.
test('a trailer left playing comes back on its last frame and carries on from there', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.addInitScript(() => history.replaceState(null, '', '/'));
  await page.goto(`${E2E_ORIGIN}/test/actual-routes.html`);
  await go(page, '/movie/42');
  const active = page.locator('[data-active="true"]');
  await expect(active.locator('h1')).toHaveText('The Movie');
  const trailer = active.locator('[data-detail-media] video');
  await expect(trailer).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  await expect.poll(() => trailer.evaluate((v) => v.currentTime)).toBeGreaterThan(0.5);
  const handle = await trailer.elementHandle();

  await active
    .getByRole('region', { name: 'Cast & Crew' })
    .getByRole('link', { name: 'An Actor' })
    .click();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('An Actor');
  const left = await handle.evaluate(
    (v) => v.closest('[data-detail-media]').querySelector('canvas.frame') !== null,
  );
  expect(left, 'its frame is kept as the page is left').toBe(true);

  // Every frame from Back until the trailer plays again: what the hero shows.
  await page.evaluate(() => {
    window.shown = [];
    const loop = () => {
      const media = document.querySelector('[data-active="true"] [data-detail-media]');
      if (media) {
        const video = media.querySelector('video');
        const playing = video.classList.contains('playing');
        window.shown.push({
          frame: media.querySelector('canvas.frame') !== null,
          playing,
          at: video.currentTime,
        });
        if (playing) return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.goBack();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  await expect(trailer).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  const shown = await page.evaluate(() => window.shown);
  expect(shown.length).toBeGreaterThan(0);
  expect(
    shown.filter((s) => !s.frame && !s.playing),
    'never the backdrop',
  ).toEqual([]);
  expect(shown.at(-1).at, 'carried on rather than started over').toBeGreaterThan(0.4);
});

test('a trailer playing with sound on a phone stops when the page is swiped back, or the tab hidden', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await mock(page);
  await page.addInitScript(() => history.replaceState(null, '', '/'));
  await page.goto(`${E2E_ORIGIN}/test/actual-routes.html`);
  await go(page, '/movie/42');
  const active = page.locator('[data-active="true"]');
  await expect(active.locator('h1')).toHaveText('The Movie');
  const trailer = active.locator('[data-detail-media] video');
  await expect(trailer).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  const sound = async () => {
    // A tap on a phone's trailer is the gesture that turns its sound on.
    await trailer.tap();
    await expect.poll(() => trailer.evaluate((v) => !v.muted && !v.paused)).toBe(true);
  };
  await sound();

  // Behind another tab.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => trailer.evaluate((v) => v.paused && v.muted)).toBe(true);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => trailer.evaluate((v) => !v.paused)).toBe(true);

  // Swiped back from the screen's edge, the app's own gesture.
  const handle = await trailer.elementHandle();
  await page.evaluate(() => {
    const target = document.querySelector('[data-active="true"] h1');
    for (const [type, x] of [
      ['touchstart', 5],
      ['touchmove', 150],
      ['touchend', 250],
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
  await page.waitForFunction(() => location.pathname === '/');
  await expect.poll(() => handle.evaluate((v) => v.paused && v.muted)).toBe(true);
  await expectQuiet(page);
  await context.close();
});

for (const [name, path] of [
  ['Home', '/'],
  ['a service page', '/service/8-us'],
])
  test(`${name}’s billboard trailer stops when its page is left, by a link or by Back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mock(page);
    await page.addInitScript(() => history.replaceState(null, '', '/'));
    await page.goto(`${E2E_ORIGIN}/test/actual-routes.html`);
    if (path !== '/') {
      await go(page, path);
      // The address moves before the page in front does.
      await expect(page.locator('[data-active="true"] .hero.branded')).toBeVisible();
    }
    await page.waitForFunction((path) => location.pathname === path, path);
    const ambient = page.locator('[data-active="true"] video.ambient');
    await expect(ambient).toHaveClass(/\bplaying\b/, { timeout: 15000 });
    const playing = await ambient.elementHandle();

    // By a link: the slide's own.
    await page
      .locator('[data-active="true"] .slide-link')
      .first()
      .evaluate((link) => link.click());
    await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
    expect(await playing.evaluate((v) => v.paused && v.muted)).toBe(true);
    await expectQuiet(page);

    // Back, where it carries on; and away by Back.
    await page.goBack();
    await page.waitForFunction((path) => location.pathname === path, path);
    await expect.poll(() => playing.evaluate((v) => !v.paused)).toBe(true);
    if (path === '/') {
      await page.goForward();
      await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
    } else {
      await page.goBack();
      await expect(page.locator('[data-active="true"] .hero.branded')).toHaveCount(0);
    }
    expect(await playing.evaluate((v) => v.paused && v.muted)).toBe(true);
    await expectQuiet(page);
  });
