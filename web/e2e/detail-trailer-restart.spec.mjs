// A hard refresh of a title detail page starts its trailer, which plays briefly and then restarts
// from zero (oxyc/den-edge#281). `SessionServices.configure()` publishes a restored `services.v1`
// reel address first and replaces it with the live `/routes` discovery answer a moment later — a
// cold-route-only race, never seen from in-app navigation, where discovery has already settled by
// the time the page mounts. `DetailMedia`'s candidate-resolution effect used to key on that address,
// so the later publish looked like a different trailer and tore the source down mid-playback.
//
// WebKit at an iPhone's width reproduces the restart as iOS does: the element itself, not just the
// app's state, is what must not move.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test, expect, webkit, devices } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

test.skip(
  !process.env.CI && !existsSync(webkit.executablePath()),
  'needs WebKit: npx playwright install webkit',
);

const videoBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const movie = {
  id: 42,
  imdb_id: 'tt42',
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'The description belongs below the title.',
  genres: [{ name: 'Drama' }],
};

// A Reel-carried source is opaque until Edge redeems its capability into ordered browser transports.
const BLOB = 'A'.repeat(40);
const TAG = 'b'.repeat(24);
const CAPABILITY = `m/s/${BLOB}?s=${TAG}`;
const DIRECT = 'https://media.invalid';
const EXPIRES = 2_000_000_000;

/**
 * A reel install at `base`: a v2 prepare answer with one carried source. Its plan URL owns the
 * transport endpoint.
 */
async function mockReelInstall(page, base) {
  const planUrl = `http://internal${base}/sources/trailer.json?v=2`;
  await page.route(`**${base}/prepare/**`, (route) => {
    return route.fulfill({
      json: {
        v: 2,
        meta: { links: [{ planUrl }] },
        primary: { id: 'trailer', planUrl },
        primaryPlan: {
          v: 2,
          expires: EXPIRES,
          crop: null,
          sources: [
            {
              kind: 'mp4',
              audio: true,
              width: 1280,
              height: 720,
              delivery: { type: 'reel', capability: CAPABILITY },
            },
          ],
        },
      },
    });
  });
}

async function mock(page) {
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  await mockReelInstall(page, '/reel/fixture');
  // The address live discovery would publish once it settles: the same reel service, reached at a
  // different config segment. Keep it valid so any regression reaches playback and is observed as
  // a replaced, paused, or restarted video rather than being masked by a malformed fixture.
  await mockReelInstall(page, '/reel/fixture-alt');
  await page.route('**/reel/fixture*/transport', (r) => {
    const { capability } = r.request().postDataJSON();
    return r.fulfill({
      json: {
        v: 2,
        capability,
        attempts: [
          { type: 'public', url: `${DIRECT}/${capability}` },
          {
            type: 'relay',
            url: new URL(r.request().url()).pathname.replace('/transport', `/${capability}`),
          },
        ],
      },
    });
  });
  await page.route(`${DIRECT}/**`, (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : videoBytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/webm',
      body: videoBytes.subarray(start, end + 1),
      headers: {
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}),
      },
    });
  });
}

async function openPlaying(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.playCalls = 0;
    const real = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.playCalls++;
      return real.apply(this, args);
    };
  });
  await page.goto(`${E2E_ORIGIN}/test/detail-trailer.html`);
  await expect(page.locator('h1')).toHaveText('The Movie');
  const video = page.locator('video');
  await expect(video).toHaveClass(/\bplaying\b/);
  await page.evaluate(() => {
    window.originalVideo = document.querySelector('video');
    window.pauseEvents = 0;
    window.originalVideo.addEventListener('pause', () => window.pauseEvents++);
  });
  return { video, errors };
}

test('iOS detail trailer lifecycle: a late, equivalent reel address does not restart it', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    await mock(page);
    const { video, errors } = await openPlaying(page);

    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
    const srcBefore = await video.evaluate((v) => v.currentSrc);
    const timeBefore = await video.evaluate((v) => v.currentTime);

    // The live-discovery publish `SessionServices.configure()` makes after the restored
    // `services.v1` result: the same reel service, a different reachable base.
    await page.evaluate(() =>
      document.dispatchEvent(
        new CustomEvent('fixture:reel', { detail: { base: '/reel/fixture-alt' } }),
      ),
    );
    // Give a regressed effect time to tear the source down and ask reel again.
    await page.waitForTimeout(500);

    expect(
      await page.evaluate(() => window.originalVideo === document.querySelector('video')),
    ).toBe(true);
    await expect(video).toHaveClass(/\bplaying\b/);
    expect(await video.evaluate((v) => v.currentSrc)).toBe(srcBefore);
    expect(await video.evaluate((v) => v.currentTime)).toBeGreaterThanOrEqual(timeBefore);
    expect(await page.evaluate(() => window.pauseEvents)).toBe(0);
    expect(await page.evaluate(() => window.playCalls)).toBe(1);

    // Still actually playing, not merely frozen in place.
    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(timeBefore);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('iOS detail trailer lifecycle: in-app navigation after discovery settles starts once', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    // Discovery has already settled by the time the page mounts — no `fixture:reel` publish
    // follows, exactly as in-app navigation never races `SessionServices.configure()`.
    await mock(page);
    const { video, errors } = await openPlaying(page);

    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
    expect(await page.evaluate(() => window.playCalls)).toBe(1);
    expect(await page.evaluate(() => window.pauseEvents)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('iOS detail trailer lifecycle: an unrelated settings publication keeps the playing element', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    await mock(page);
    const { video, errors } = await openPlaying(page);

    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
    const srcBefore = await video.evaluate((v) => v.currentSrc);
    const timeBefore = await video.evaluate((v) => v.currentTime);
    await page.evaluate(() => document.dispatchEvent(new Event('fixture:settings')));
    await page.waitForTimeout(500);

    expect(
      await page.evaluate(() => window.originalVideo === document.querySelector('video')),
    ).toBe(true);
    expect(await video.evaluate((v) => v.currentSrc)).toBe(srcBefore);
    expect(await video.evaluate((v) => v.currentTime)).toBeGreaterThanOrEqual(timeBefore);
    expect(await page.evaluate(() => window.pauseEvents)).toBe(0);
    expect(await page.evaluate(() => window.playCalls)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
