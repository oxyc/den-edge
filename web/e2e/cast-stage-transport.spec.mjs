// Away from home the cast page is the picture: a cross-origin frame that plays the session itself, under the player's
// bars. Its video used to carry the browser's native controls there, and the player still drew its dock over them: two
// sets of controls, one on the other. Now the player draws its whole transport and drives the frame by message, the
// frame's video has no controls of its own, and the frame's output buttons (Cast, AirPlay) sit in a hole the player
// leaves in its top bar. (Before, the Cast button sat in the picture's corner, where the top bar's empty output box
// took its press while the controls showed: den-edge#1148. The hole is what keeps that press the frame's.)
//
// This is the real cast page, built for the fixture's origin, in every engine Den serves.
import { test, expect, chromium, firefox, webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const MEDIA = 'https://media.test';
const PATH = '/remux/s/AbCdEfGhIjKlMnOpQrStUv/sIgNaTuReSiGnAtUrE0123';
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));
const cors = { 'access-control-allow-origin': '*' };

let built;
test.beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), 'den-cast-stage-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
    stdio: 'ignore',
  });
});
test.afterAll(() => rmSync(built, { recursive: true, force: true }));

const engines = [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
];

function launch(browserType) {
  if (browserType === chromium)
    return chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  if (browserType === firefox)
    return firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0 } });
  return webkit.launch();
}

async function open(browserType, { iphone = false, airPlay = false } = {}) {
  const browser = await launch(browserType);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Safari's AirPlay picker, in every frame; a press records the call. WebKit's own availability answer is withheld:
  // it fires once, and measured here a frame got `available`, `not-available` or nothing depending on when its
  // listener and its media arrived. Only the test's own (untrusted) events reach the page: Safari never answering.
  if (airPlay)
    await context.addInitScript(() => {
      HTMLVideoElement.prototype.webkitShowPlaybackTargetPicker = function () {
        window.denAirPlayPicker = (window.denAirPlayPicker ?? 0) + 1;
      };
      const listen = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type !== 'webkitplaybacktargetavailabilitychanged' || typeof listener !== 'function')
          return listen.call(this, type, listener, options);
        return listen.call(
          this,
          type,
          (event) => {
            if (!event.isTrusted) listener.call(this, event);
          },
          options,
        );
      };
    });
  // An iPhone's Safari, which no engine here is: no element can be made fullscreen, and a video can only enter
  // Apple's own fullscreen player. In every frame, so the cast page sees it too; a press records the call.
  if (iphone)
    await context.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
      HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
        window.denEnteredFullscreen = true;
      };
    });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/remux/session`, (r) =>
    r.fulfill({
      status: 201,
      json: {
        playlist: `${PATH}/master.m3u8`,
        duration: 60,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [],
        publicBase: MEDIA,
        lanBase: 'https://lan.test:8449',
        castOrigin: CAST,
      },
    }),
  );
  await page.route(`${ORIGIN}/remux/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/remux/grant`, (r) => r.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/playback/**`, (r) => r.fulfill({ status: 204 }));
  // Den-remux on its public address, playlist and segments from the fixture; reports and the end are answered.
  await context.route(`${MEDIA}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const method = r.request().method();
    if (method === 'OPTIONS')
      return r.fulfill({
        status: 204,
        headers: { ...cors, 'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS' },
      });
    if (method !== 'GET') return r.fulfill({ status: 204, headers: cors });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    try {
      return r.fulfill({
        headers: cors,
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    } catch {
      return r.fulfill({ status: 404, headers: cors });
    }
  });
  // Away from home: the home-network address the session names does not answer.
  await context.route('https://lan.test:8449/**', (r) => r.abort('addressunreachable'));
  await context.route(`${CAST}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const type = file.endsWith('.html')
      ? 'text/html'
      : file.endsWith('.js')
        ? 'text/javascript'
        : 'text/css';
    return r.fulfill({ contentType: type, body: await readFile(join(built, file)) });
  });
  // Google's Cast SDK: absent here, as in a browser without Cast.
  await context.route('https://www.gstatic.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  await page.goto(`${ORIGIN}/test/player.html?remux=/remux`);
  return { browser, page };
}

const frameVideo = (page) => page.frameLocator('iframe[title="Den Cast player"]').locator('video');

/** The frame's video once it plays past `seconds`; an engine that refuses its autoplay gets the frame's own Play. */
async function playingPast(page, seconds) {
  const frame = page.frameLocator('iframe[title="Den Cast player"]');
  const play = frame.locator('#play-local');
  await expect
    .poll(
      async () => {
        if (await play.isVisible().catch(() => false)) await play.click();
        return frameVideo(page).evaluate((v) => (v.paused ? -1 : v.currentTime));
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(seconds);
}

/** Move over the picture, which shows the player's controls. */
async function reveal(page) {
  const box = await page.locator('.player').boundingBox();
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 3);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.player')).not.toHaveClass(/web-controls-hidden/);
}

for (const [name, browserType] of engines) {
  test.describe(name, () => {
    test('away from home the player’s transport is the only one, and it drives the frame’s video', async () => {
      const { browser, page } = await open(browserType);
      try {
        await expect(page.locator('iframe.cast-frame-stage')).toHaveCount(1);
        await playingPast(page, 1);
        // No native controls under the player's own.
        expect(await frameVideo(page).evaluate((v) => v.controls)).toBe(false);
        await reveal(page);
        await expect(page.locator('.web-timeline')).toBeVisible();
        // Where the player can make itself fullscreen, fullscreen is the player's button, not the frame's.
        await expect(
          page.getByRole('button', { name: 'Enter fullscreen', exact: true }),
        ).toBeVisible();
        await expect(
          page.frameLocator('iframe[title="Den Cast player"]').locator('#fullscreen'),
        ).toBeHidden();
        // With a mouse the transport is the dock's left end (`.web-dock-transport`).
        const dock = page.locator('.web-dock-transport');

        // The picture's centre is the player's, not the frame's: a click there plays and pauses.
        const centre = await page.evaluate(() => {
          const frame = document.querySelector('iframe.cast-frame-stage').getBoundingClientRect();
          const x = frame.left + frame.width / 2;
          const y = frame.top + frame.height / 2;
          return { x, y, hit: document.elementFromPoint(x, y)?.className };
        });
        expect(String(centre.hit)).toContain('stage-picture');

        await dock.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect.poll(() => frameVideo(page).evaluate((v) => v.paused)).toBe(true);
        await expect(dock.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

        await dock.getByRole('button', { name: 'Play', exact: true }).click();
        await expect.poll(() => frameVideo(page).evaluate((v) => v.paused)).toBe(false);

        const before = await frameVideo(page).evaluate((v) => v.currentTime);
        await dock.getByRole('button', { name: 'Forward 10 seconds', exact: true }).click();
        await expect
          .poll(() => frameVideo(page).evaluate((v) => v.currentTime))
          .toBeGreaterThan(before + 8);

        await dock.getByRole('button', { name: 'Mute', exact: true }).click();
        await expect.poll(() => frameVideo(page).evaluate((v) => v.muted)).toBe(true);
        // The frame's report is what the player shows.
        await expect(dock.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible();

        await page.mouse.click(centre.x, centre.y);
        await expect
          .poll(() => frameVideo(page).evaluate((v) => v.paused), { timeout: 5_000 })
          .toBe(true);
      } finally {
        await browser.close();
      }
    });

    test('the frame’s output buttons sit in the hole the top bar leaves for them, and hide with it', async () => {
      const { browser, page } = await open(browserType);
      try {
        await playingPast(page, 1);
        await reveal(page);
        // Neither Cast nor AirPlay has a device in a test browser: the frame says it has one to show, as it does when
        // Safari finds an AirPlay device.
        const frame = page.frames().find((f) => f.url().startsWith(CAST));
        await frame.evaluate((origin) => {
          document.querySelector('#cast').hidden = false;
          window.parent.postMessage({ type: 'den-outputs', cast: true, airplay: false }, origin);
        }, ORIGIN);
        const slot = page.locator('.frame-outputs');
        await expect(slot).toHaveCount(1);

        const hole = await slot.boundingBox();
        const outputs = page.frameLocator('iframe[title="Den Cast player"]').locator('.outputs');
        await expect(outputs).toBeVisible();
        const stage = await page.locator('iframe.cast-frame-stage').boundingBox();
        await expect
          .poll(async () => {
            const box = await outputs.boundingBox();
            return box && [Math.round(box.x - stage.x), Math.round(box.y - stage.y)];
          })
          .toEqual([Math.round(hole.x - stage.x), Math.round(hole.y - stage.y)]);
        // A press there reaches the frame, past the player's bar and its picture layer.
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, {
          x: hole.x + hole.width / 2,
          y: hole.y + hole.height / 2,
        });
        expect(hit).toBe('IFRAME');

        // Left alone the controls hide, and the frame's buttons with them.
        await page.mouse.move(2, 2);
        await page.mouse.move(1, 1);
        await expect(page.locator('.player')).toHaveClass(/web-controls-hidden/, {
          timeout: 10_000,
        });
        await expect(outputs).toBeHidden();
      } finally {
        await browser.close();
      }
    });

    test('on an iPhone fullscreen is the frame’s button, where the dock’s own is, and it fills the screen with the frame’s video', async () => {
      const { browser, page } = await open(browserType, { iphone: true });
      try {
        await playingPast(page, 1);
        await reveal(page);
        const frame = page.frameLocator('iframe[title="Den Cast player"]');
        const button = frame.locator('#fullscreen');
        await expect(button).toBeVisible();
        // The player's own cannot reach the frame's video there, so it leaves a hole in its place for the frame's.
        await expect(
          page.getByRole('button', { name: 'Enter fullscreen', exact: true }),
        ).toHaveCount(0);
        const slot = page.locator('.frame-fullscreen');
        await expect(slot).toHaveCount(1);
        // In the dock, where the player's fullscreen button sits: just before More, at the dock's right end. The top
        // bar keeps its hole for Cast and AirPlay only: no test browser has Cast. WebKit has AirPlay's picker, whose
        // one availability answer races the frame's media (see `open`), so only the other engines are sure of none.
        if (browserType !== webkit) await expect(page.locator('.frame-outputs')).toHaveCount(0);
        expect(
          await slot.evaluate((hole) => {
            const more = hole.nextElementSibling;
            return {
              inDock: !!hole.closest('.web-dock'),
              beforeMore: !!more?.querySelector('.web-more'),
            };
          }),
        ).toEqual({ inDock: true, beforeMore: true });
        const hole = await slot.boundingBox();
        const more = await page.locator('.web-more').boundingBox();
        expect([hole.width, hole.height]).toEqual([44, 44]);
        expect(Math.round(hole.y)).toBe(Math.round(more.y));
        // The frame's button fills that hole exactly.
        await expect
          .poll(async () => {
            const box = await button.boundingBox();
            return box && [box.x, box.y, box.width, box.height].map(Math.round);
          })
          .toEqual([hole.x, hole.y, hole.width, hole.height].map(Math.round));
        // A press there reaches the frame, past the player's dock and its picture layer.
        const centre = { x: hole.x + hole.width / 2, y: hole.y + hole.height / 2 };
        expect(
          await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, centre),
        ).toBe('IFRAME');

        await page.mouse.click(centre.x, centre.y);
        const cast = page.frames().find((f) => f.url().startsWith(CAST));
        await expect
          .poll(() => cast.evaluate(() => window.denEnteredFullscreen === true))
          .toBe(true);
      } finally {
        await browser.close();
      }
    });
  });
}

// On an iPhone the AirPlay button was gone once Den Remux moved into this frame. Where Safari has the picker, the
// frame offers AirPlay by the player's own rule: until Safari says no device is there, not only once it says one is.
test('WebKit: the frame offers AirPlay wherever Safari has its picker, until no device is there', async () => {
  const { browser, page } = await open(webkit, { airPlay: true });
  try {
    await playingPast(page, 1);
    await reveal(page);
    const frame = page.frameLocator('iframe[title="Den Cast player"]');
    const airPlay = frame.locator('#airplay');
    await expect(airPlay).toBeVisible();
    await expect(page.locator('.frame-outputs')).toHaveCount(1);
    await airPlay.click();
    const cast = page.frames().find((f) => f.url().startsWith(CAST));
    await expect.poll(() => cast.evaluate(() => window.denAirPlayPicker ?? 0)).toBe(1);

    await cast.evaluate(() => {
      const event = new Event('webkitplaybacktargetavailabilitychanged');
      Object.defineProperty(event, 'availability', { value: 'not-available' });
      document.querySelector('video').dispatchEvent(event);
    });
    await expect(airPlay).toBeHidden();
    await expect(page.locator('.frame-outputs')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
