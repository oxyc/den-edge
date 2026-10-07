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

// The carried-source shape `carriedPath`/`activateDirect` require: a `/reel/m/s/<blob>?s=<tag>`
// path, signed with a 24-hex tag.
const BLOB = 'A'.repeat(40);
const TAG = 'b'.repeat(24);
const MEDIA = `/reel/m/s/${BLOB}?s=${TAG}`;
const DIRECT = 'https://media.invalid';

/**
 * A reel install at `base`: its own `/meta` answer (one trailer, carrying a `/sources` link so the
 * activation path — the one the production log's doubled `/reel/activate` came from — is exercised,
 * not just the play-URL fallback `detail-trailer.spec.mjs` covers). `mediaBase()` collapses any
 * install's config segment to the bare `/reel` mount before `/sources` and `/activate` are ever
 * asked, so every install's activation lands on the same path — counted once, overall.
 */
async function mockReelInstall(page, base, counts) {
  const key = base.split('/').pop();
  await page.route(`**${base}/meta/**`, (route) => {
    counts.meta[key] = (counts.meta[key] ?? 0) + 1;
    return route.fulfill({
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
    });
  });
}

async function mock(page) {
  const counts = { meta: {}, activate: 0, direct: 0 };
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  await mockReelInstall(page, '/reel/fixture', counts);
  // The address live discovery would publish once it settles: the same reel service, reached at a
  // different config segment. A fix at the wrong layer re-asks it; this must stay at zero.
  await mockReelInstall(page, '/reel/fixture-alt', counts);
  await page.route('**/sources/trailer.json**', (r) =>
    r.fulfill({
      json: {
        sources: [{ kind: 'mp4', url: `http://internal${MEDIA}`, audio: true, height: 720 }],
      },
    }),
  );
  await page.route('**/reel/activate', (r) => {
    counts.activate += 1;
    return r.fulfill({
      json: { publicBase: DIRECT, media: `${DIRECT}${MEDIA}`, form: 'progressive' },
    });
  });
  await page.route(`${DIRECT}/**`, (route) => {
    counts.direct += 1;
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
  return counts;
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
    const counts = await mock(page);
    const { video, errors } = await openPlaying(page);

    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
    const srcBefore = await video.evaluate((v) => v.currentSrc);
    const timeBefore = await video.evaluate((v) => v.currentTime);
    expect(counts.activate).toBe(1);
    expect(counts.meta.fixture).toBe(1);

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
    expect(counts.meta['fixture-alt']).toBeUndefined();
    expect(counts.activate).toBe(1);

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
    const counts = await mock(page);
    const { video, errors } = await openPlaying(page);

    await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
    expect(counts.activate).toBe(1);
    expect(counts.meta.fixture).toBe(1);
    expect(counts.meta['fixture-alt']).toBeUndefined();
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
    const counts = await mock(page);
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
    expect(counts.activate).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
