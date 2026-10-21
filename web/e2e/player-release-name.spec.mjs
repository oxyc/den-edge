// The name of the release playing selects as text, to be copied, while the rest of the player does not; selecting
// it leaves playback and the player's controls as they were. On the real player, at a phone's width with touch and
// a desktop's, in Chromium and WebKit.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const release = {
  label: 'The.Movie.2001.2160p.WEB-DL.DV.H.265-FLUX',
  filename: 'The.Movie.2001.2160p.WEB-DL.DV.H.265-FLUX.mkv',
  size: 1,
};

async function mockPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  await page.route(`${ORIGIN}/direct/session`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        sid: 'name1',
        playlist: '/direct/s/name1/sig/master.m3u8',
        duration: 60,
        release,
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [],
      },
    }),
  );
  await page.route(`${ORIGIN}/direct/s/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    const path = new URL(request.url()).pathname;
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return route.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
}

const layouts = [
  ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ['desktop', { viewport: { width: 1280, height: 800 } }],
];

for (const [engine, browserType] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  for (const [layout, options] of layouts) {
    test(`the release name selects as text and leaves playback alone (${engine}, ${layout})`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await browserType.launch(
        browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
      );
      try {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        await mockPlayer(page);
        await page.goto(`${ORIGIN}/test/player.html`);
        const video = page.locator('.player video');
        await expect
          .poll(() => video.evaluate((v) => v.currentTime), { timeout: 30_000 })
          .toBeGreaterThan(1);
        const name = page.locator('.player .release');
        await expect(name).toHaveText(release.label);

        await name.click({ clickCount: 3 });
        expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(release.label);

        // The selection played or paused nothing, and the player and its controls are as they were.
        expect(await video.evaluate((v) => v.paused)).toBe(false);
        if (layout === 'phone') await expect(video).toHaveAttribute('controls', '');
        else {
          await expect(video).not.toHaveAttribute('controls', '');
          await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
        }
        await expect(page.locator('.player footer')).toBeVisible();
        // The rest of the player still selects nothing under a finger.
        await page.evaluate(() => getSelection()?.removeAllRanges());
        await page.locator('.player header b').click({ clickCount: 3 });
        expect(await page.evaluate(() => getSelection()?.toString().trim() ?? '')).toBe('');
      } finally {
        await browser.close();
      }
    });
  }
}
