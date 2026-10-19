// The player's stream picker: a button naming the stream playing in short ("4K · 11 GB"), opening the shared menu
// (a bottom sheet headed "Streams" on a phone), where each release is its quality and size over its file name, the
// one playing ticked. On the real player, at a phone's width with touch and a desktop's, in Chromium and WebKit.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const releases = [
  {
    label: '4K • BluRay REMUX • Dolby Vision • Atmos • 11 GB',
    filename: 'The.Movie.2001.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FRAMESTOR.mkv',
    size: 11 * 1024 ** 3,
    plays: 'yes',
  },
  {
    label: '4K • WEB-DL • HDR • 9 GB · from a 105 GB pack',
    filename: 'The.Movie.2001.2160p.AMZN.WEB-DL.DDP5.1.HDR.H.265-FLUX.mkv',
    size: 9 * 1024 ** 3,
    plays: 'yes',
  },
  {
    label: '4K • WEB-DL • Dolby Vision • 14 GB',
    filename: 'The.Movie.2001.2160p.WEB-DL.DV.P5.H.265-NOGROUP.mkv',
    size: 14 * 1024 ** 3,
    plays: 'no',
  },
];

async function mockPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) => route.fulfill({ json: { releases } }));
  const asked = [];
  await page.route(`${ORIGIN}/direct/session`, (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const release = releases.find((one) => one.filename === body.filename) ?? releases[0];
    const sid = `s${asked.length}`;
    return route.fulfill({
      status: 201,
      json: {
        sid,
        playlist: `/direct/s/${sid}/sig/master.m3u8`,
        duration: 60,
        release,
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [],
      },
    });
  });
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
  return asked;
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
    test(`the stream picker lists each release on two lines and switches to the one chosen (${engine}, ${layout})`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await browserType.launch(
        browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
      );
      try {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        const asked = await mockPlayer(page);
        await page.goto(`${ORIGIN}/test/player.html`);
        // The app's own stylesheet, which the fixture page leaves out: the sheet's width is measured under it.
        await page.addStyleTag({ path: fileURLToPath(new URL('../src/app.css', import.meta.url)) });
        await expect
          .poll(() => page.locator('.player video').evaluate((v) => v.currentTime), {
            timeout: 30_000,
          })
          .toBeGreaterThan(1);

        const picker = page.getByRole('button', { name: 'Stream: 4K · 11 GB' });
        await expect(picker).toHaveText('4K · 11 GB');
        await expect(picker).toHaveAttribute('aria-haspopup', 'menu');
        await picker.click();
        const menu = page.getByRole('menu', { name: 'Stream: 4K · 11 GB' });
        await expect(menu).toBeVisible();
        if (layout === 'phone') await expect(menu.getByText('Streams')).toBeVisible();

        const items = menu.getByRole('menuitemradio');
        await expect(items).toHaveCount(3);
        await expect(items.nth(0)).toHaveAccessibleName(
          '4K · BluRay REMUX · Dolby Vision · Atmos · 11 GB',
        );
        await expect(items.nth(0)).toHaveAccessibleDescription(releases[0].filename);
        await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
        await expect(items.nth(1)).toHaveAccessibleName(
          '4K · WEB-DL · HDR · 9 GB · from a 105 GB pack',
        );
        await expect(items.nth(1)).toHaveAttribute('aria-checked', 'false');
        await expect(items.nth(2)).toHaveAccessibleName(
          '4K · WEB-DL · Dolby Vision · 14 GB — can’t play here',
        );
        await expect(items.nth(2)).toHaveAttribute('aria-disabled', 'true');

        // The file name wraps, at most two lines, inside the menu, inside the screen.
        const description = items.nth(0).locator('.item-description');
        const lines = await description.evaluate(
          (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
        );
        expect(lines).toBeGreaterThan(1.5);
        expect(lines).toBeLessThan(2.5);
        const box = await menu.boundingBox();
        const width = options.viewport.width;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(options.viewport.height);
        await page.screenshot({
          path: test.info().outputPath(`stream-menu-${engine}-${layout}.png`),
        });

        // Choosing another switches to it from where it was, and the picker then names it, ticked.
        await items.nth(1).click();
        await expect.poll(() => asked.length).toBe(2);
        expect(asked[1]).toMatchObject({ filename: releases[1].filename, transcode: 'never' });
        const next = page.getByRole('button', { name: 'Stream: 4K · 9 GB' });
        await expect(next).toHaveText('4K · 9 GB', { timeout: 30_000 });
        await next.click();
        await expect(
          page.getByRole('menuitemradio', {
            name: '4K · WEB-DL · HDR · 9 GB · from a 105 GB pack',
          }),
        ).toHaveAttribute('aria-checked', 'true');
      } finally {
        await browser.close();
      }
    });
  }
}
