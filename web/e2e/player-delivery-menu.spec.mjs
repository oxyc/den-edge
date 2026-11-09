// How a stream is delivered ("TorBox", "Den Remux") is named in the options' header and on their Source row, whose page
// says how it plays now and offers the switch to the other path; only choosing that switch restarts the stream. On the
// real player, at a phone's width with touch (the bottom sheet) and a desktop's (the popover), in Chromium and WebKit.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';
import { openOptionsPage, optionsButton, optionsMenu } from './player-options.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const CDN = 'https://flux-002.wnam.tb-cdn.io/opaque';
const release = { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 };
const SESSION = '/direct/s/switch1/sig';

/** Hearth with TorBox and Remux: TorBox first, Remux where the request rules TorBox out (`directFailed`). */
async function mockHearth(page, { beforePlayback } = {}) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
    route.fulfill({ json: { subtitles: [] } }),
  );
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  const playback = [];
  await page.route(`${ORIGIN}/den/config/playback`, (route) => {
    const body = route.request().postDataJSON();
    playback.push(body);
    return Promise.resolve(beforePlayback?.(body, playback.length)).then(() => {
      if (body.directFailed !== true)
        return route.fulfill({ json: { url: `${CDN}/master.m3u8`, release } });
      return route.fulfill({
        json: {
          url: `${ORIGIN}${SESSION}/master.m3u8`,
          release,
          session: {
            id: 'switch1',
            duration: 60,
            video: { codec: 'h264', transcoded: false },
            audioTrack: 0,
            audioTracks: [],
            endUrl: SESSION,
            heartbeatUrl: `${SESSION}/heartbeat`,
            reportUrl: `${SESSION}/report`,
          },
        },
      });
    });
  });
  const media = async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    const name = new URL(request.url()).pathname.split('/').pop();
    const file = name === 'master.m3u8' ? 'media.m3u8' : name;
    return route.fulfill({
      headers: {
        'access-control-allow-origin': ORIGIN,
        'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      },
      body: await readFile(new URL(file, hls)),
    });
  };
  await page.route(`${CDN}/**`, media);
  await page.route(`${ORIGIN}/direct/s/**`, media);
  return playback;
}

test('delivery changes explain the wait immediately and until the replacement paints', async () => {
  test.skip(!existsSync(chromium.executablePath()), 'Chromium is not installed here');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const releases = [];
    const playback = await mockHearth(page, {
      beforePlayback: (_body, attempt) =>
        attempt === 1 ? undefined : new Promise((resolve) => releases.push(resolve)),
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    const video = page.locator('.player video');
    await expect
      .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(2);

    const source = page.getByTestId('playback-source');
    await openOptionsPage(page, 'Source');
    await page.getByRole('menuitem', { name: 'Switch to Den Remux' }).click();
    await expect.poll(() => playback.length).toBe(2);
    await expect(page.getByRole('status')).toHaveText('Switching to Den Remux…');
    const stillPlayingAt = await video.evaluate((element) => element.currentTime);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(stillPlayingAt);
    releases.shift()();
    await expect(source).toHaveText('Den Remux', { timeout: 30_000 });
    await expect(page.getByText('Switching to Den Remux…')).toHaveCount(0);

    // A source replacement cannot rely on the element's one-shot autoplay attribute. This models the browser state
    // seen when it has already consumed that initial autoplay: the replacement must explicitly preserve playback.
    await video.evaluate((element) => {
      element.autoplay = false;
      element.removeAttribute('autoplay');
    });
    await openOptionsPage(page, 'Source');
    await page.getByRole('menuitem', { name: 'Switch to TorBox' }).click();
    await expect.poll(() => playback.length).toBe(3);
    await expect(page.getByRole('status')).toHaveText('Switching to TorBox…');
    releases.shift()();
    await expect(source).toHaveText('TorBox', { timeout: 30_000 });
    await expect(page.getByText('Switching to TorBox…')).toHaveCount(0);
    const resumedAt = await video.evaluate((element) => element.currentTime);
    await expect
      .poll(() => video.evaluate((element) => (element.paused ? -1 : element.currentTime)))
      .toBeGreaterThan(resumedAt);
  } finally {
    await browser.close();
  }
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
    test(`the Source page names the path, and only its switch restarts (${engine}, ${layout})`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await browserType.launch(
        browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
      );
      try {
        const context = await browser.newContext(options);
        const page = await context.newPage();
        const playback = await mockHearth(page);
        await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
        // The app's own stylesheet, which the fixture page leaves out: the stamp is a player button by it.
        await page.addStyleTag({ path: fileURLToPath(new URL('../src/app.css', import.meta.url)) });
        const video = page.locator('.player video');
        await expect
          .poll(() => video.evaluate((v) => v.currentTime), { timeout: 30_000 })
          .toBeGreaterThan(2);
        const more = optionsButton(page);
        await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
        await expect(more).toHaveAttribute('aria-haspopup', 'menu');
        await expect(more).toHaveAttribute('aria-expanded', 'false');

        // A press opens the options, then the Source page, and changes nothing about what plays.
        await showControls(page, layout);
        await more.click();
        const menu = optionsMenu(page);
        await expect(menu).toBeVisible();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await expect(menu.locator('.options-chip')).toHaveText('TorBox');
        await menu.getByRole('menuitem', { name: 'Source, TorBox' }).click();
        await expect(menu).toContainText('Playing directly from TorBox');
        const toRemux = menu.getByRole('menuitem', { name: 'Switch to Den Remux' });
        await expect(toRemux).toContainText(
          'For audio or subtitles this browser can’t play, or a stream that stalls',
        );
        await expect(menu.getByRole('menuitem', { name: /^Switch to/ })).toHaveCount(1);
        await page.screenshot({
          path: test.info().outputPath(`delivery-menu-${engine}-${layout}.png`),
        });
        expect(playback).toHaveLength(1);

        // Dismissed, it changes nothing either, and the player stays open.
        if (layout === 'phone') {
          // A tap outside the sheet, on the player's title.
          const box = await page.locator('.player header b').boundingBox();
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.player')).toBeVisible();
        await page.waitForTimeout(500);
        expect(playback).toHaveLength(1);
        await expect(page.getByTestId('playback-source')).toHaveText('TorBox');

        // Choosing the switch restarts it through Den Remux, from where it was (a position past the first five
        // seconds, which is carried; the very start is not).
        await expect
          .poll(() => video.evaluate((v) => v.currentTime), { timeout: 30_000 })
          .toBeGreaterThan(7);
        const at = await video.evaluate((v) => v.currentTime);
        await showControls(page, layout);
        await openOptionsPage(page, 'Source');
        await toRemux.click();
        await expect(page.getByTestId('playback-source')).toHaveText('Den Remux', {
          timeout: 30_000,
        });
        expect(playback).toHaveLength(2);
        expect(playback[1]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });
        expect(playback[1].startAt).toBeGreaterThan(at - 1);

        await showControls(page, layout);
        const back = await openOptionsPage(page, 'Source');
        await expect(back).toContainText('Playing through Den Remux');
        await expect(back.getByRole('menuitem', { name: 'Switch to TorBox' })).toContainText(
          'Straight from the source, no conversion',
        );
      } finally {
        await browser.close();
      }
    });
  }
}

/**
 * Bring the auto-hidden controls back as a viewer does: a mouse moves over the picture, a finger taps it (a tap on
 * controls already showing would hide them).
 */
async function showControls(page, layout) {
  const player = page.locator('.player');
  const box = await page.locator('.player video').boundingBox();
  if (!box) throw new Error('player has no video');
  if (layout === 'desktop') await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  else if (/web-controls-hidden/.test((await player.getAttribute('class')) ?? ''))
    // Between the toast lane at the top and the transport at the picture's centre.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.38);
  await expect(player).not.toHaveClass(/web-controls-hidden/);
}
