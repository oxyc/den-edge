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
  // Two providers can independently return the same file. Playback selection itself accepts only the filename, so
  // these are one actionable choice—not two DOM rows with an invalid duplicate identity.
  {
    label: '4K • WEB-DL • Dolby Vision • 14 GB · duplicate provider',
    filename: 'The.Movie.2001.2160p.WEB-DL.DV.P5.H.265-NOGROUP.mkv',
    size: 14 * 1024 ** 3,
    plays: 'no',
  },
];

async function mockPlayer(page, { releaseGate, replacementGate, audioTracks = [] } = {}) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, async (route) => {
    await releaseGate?.promise;
    return route.fulfill({ json: { releases } });
  });
  const asked = [];
  await page.route(`${ORIGIN}/direct/session`, async (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    if (asked.length > 1) await replacementGate?.promise;
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
        audioTrack: body.audioTrack ?? 0,
        audioTracks,
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

test('a chosen stream is acknowledged while its replacement is opening', async ({ page }) => {
  let openReplacement;
  const replacementGate = {
    promise: new Promise((resolve) => (openReplacement = resolve)),
  };
  const asked = await mockPlayer(page, { replacementGate });
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect
    .poll(() => page.locator('.player video').evaluate((v) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Stream: 4K · 11 GB' }).click();
  await page
    .getByRole('menuitemradio', { name: '4K · WEB-DL · HDR · 9 GB · from a 105 GB pack' })
    .click();

  await expect.poll(() => asked.length).toBe(2);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const status = page.getByRole('status').filter({ hasText: 'Switching stream…' });
  await expect(status).toBeVisible();
  await expect(status.locator('.status-spinner')).toBeVisible();

  openReplacement();
  await expect(page.getByRole('button', { name: 'Stream: 4K · 9 GB' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(status).toHaveCount(0);
});

test('an audio choice requests that exact track and stays acknowledged until it opens', async ({
  page,
}) => {
  let openReplacement;
  const replacementGate = {
    promise: new Promise((resolve) => (openReplacement = resolve)),
  };
  const audioTracks = [
    { language: 'en', name: null, channels: 6, commentary: false },
    { language: 'ru', name: null, channels: 6, commentary: false },
  ];
  const asked = await mockPlayer(page, { replacementGate, audioTracks });
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect
    .poll(() => page.locator('.player video').evaluate((v) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Audio track: English 5.1' }).click();
  await page.getByRole('menuitemradio', { name: 'Russian 5.1' }).click();

  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]).toMatchObject({ audioTrack: 1, filename: releases[0].filename });
  const status = page.getByRole('status').filter({ hasText: 'Switching audio…' });
  await expect(status).toBeVisible();
  await expect(status.locator('.status-spinner')).toBeVisible();

  openReplacement();
  await expect(page.getByRole('button', { name: 'Audio track: Russian 5.1' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(status).toHaveCount(0);
});

test('the modal player contains keyboard focus and returns it to its opener', async ({ page }) => {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?startClosed`);
  const opener = page.getByRole('button', { name: 'Open fixture player' });
  await opener.focus();
  await opener.click();

  const dialog = page.getByRole('dialog', { name: 'The Movie' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();

  // Reverse-tab at the dialog boundary stays in its final visible control. Forward-tab from that boundary loops
  // back to the first: neither direction can move through the page hidden behind this modal surface.
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.evaluate(() => {
    const player = document.querySelector('.player');
    const stops = Array.from(
      player.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element.getAttribute('aria-disabled') !== 'true' && element.getClientRects().length > 0,
    );
    stops.at(-1)?.focus();
  });
  await page.keyboard.press('Tab');
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a pending stream search is named and keeps the playing choice focused as results arrive', async ({
  page,
}) => {
  let release;
  const releaseGate = {
    promise: new Promise((resolve) => (release = resolve)),
  };
  await mockPlayer(page, { releaseGate });
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect(page.locator('.player video')).toBeVisible();

  const picker = page.getByRole('button', { name: 'Stream: 4K · 11 GB' });
  await picker.click();
  const menu = page.getByRole('menu', { name: 'Stream: 4K · 11 GB' });
  await expect(menu).toContainText('Finding the other available streams…');
  const playing = menu.getByRole('menuitemradio', {
    name: '4K · BluRay REMUX · Dolby Vision · Atmos · 11 GB',
  });
  await expect(playing).toBeFocused();
  await expect(playing).toHaveAttribute('aria-checked', 'true');

  release();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3);
  await expect(menu).not.toContainText('Finding the other available streams…');
  await expect(playing).toBeFocused();
});

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
        if (browserType === webkit && layout === 'desktop') {
          await context.addInitScript(() => {
            Object.defineProperty(HTMLVideoElement.prototype, 'webkitShowPlaybackTargetPicker', {
              configurable: true,
              value() {
                window.airPlayPickerCalls = (window.airPlayPickerCalls ?? 0) + 1;
              },
            });
          });
        }
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

        const video = page.locator('.player video');
        if (layout === 'desktop') {
          await expect(video).not.toHaveAttribute('controls', '');
          await page.mouse.move(options.viewport.width / 2, options.viewport.height / 2);
          await expect(page.getByRole('navigation', { name: 'Playback controls' })).toBeVisible();
          await page.getByRole('button', { name: 'Pause' }).click();
          await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
          await page.getByRole('button', { name: 'Play', exact: true }).click();
          await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
          const pause = page.getByRole('button', { name: 'Pause' });
          await expect
            .poll(() => pause.evaluate((element) => getComputedStyle(element).cursor))
            .toBe('pointer');
          if (browserType === webkit) {
            const airplay = page.getByRole('button', { name: 'AirPlay', exact: true });
            await expect(airplay).toBeVisible();
            await airplay.click();
            await expect.poll(() => page.evaluate(() => window.airPlayPickerCalls ?? 0)).toBe(1);
          }
        } else {
          await expect(video).toHaveAttribute('controls', '');
          await expect(page.getByRole('navigation', { name: 'Playback controls' })).toHaveCount(0);
        }

        const picker = page.getByRole('button', { name: 'Stream: 4K · 11 GB' });
        await expect(picker).toBeVisible();
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
        await expect(next).toBeVisible({ timeout: 30_000 });
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
