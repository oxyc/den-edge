// ActionMenu's bottom sheet on a phone, through the player's Streams sheet (a long list): its head (the handle, the
// heading and any note) is a grab area. Dragged, the sheet follows the finger; let go, it closes past 30% of its
// height or on a quick downward flick, and springs back otherwise; tapped, it closes. The list under it scrolls on
// its own, the head staying put. With reduced motion nothing travels: it closes or stays, at once.
//
// The gestures are pointer events dispatched at the heading, as a finger's arrive (pointerType "touch"): Playwright
// has a tap but no touch drag in either engine.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const releases = Array.from({ length: 30 }, (_, i) => ({
  label: `1080p • WEB-DL • ${i + 1} GB`,
  filename: `The.Movie.2001.1080p.WEB-DL.H264-GRP${i + 1}.mkv`,
  size: (i + 1) * 1024 ** 3,
  plays: 'yes',
}));

async function mockPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) => route.fulfill({ json: { releases } }));
  await page.route(`${ORIGIN}/direct/session`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        sid: 's1',
        playlist: '/direct/s/s1/sig/master.m3u8',
        duration: 60,
        release: releases[0],
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

/** The player at a phone's width, its Streams sheet open: the sheet, its heading and its first item. */
async function openSheet(browserType, { reducedMotion } = {}) {
  const browser = await browserType.launch(
    browserType === chromium
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ['--autoplay-policy=no-user-gesture-required'],
        }
      : {},
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  const page = await context.newPage();
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  await page.addStyleTag({ path: fileURLToPath(new URL('../src/app.css', import.meta.url)) });
  await expect
    .poll(() => page.locator('.player video').evaluate((v) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);
  await page.getByRole('button', { name: /^Stream: / }).tap();
  const sheet = page.getByRole('menu', { name: /^Stream: / });
  await expect(sheet).toBeVisible();
  const heading = sheet.getByText('Streams', { exact: true });
  await expect(heading).toBeVisible();
  return { browser, page, sheet, heading };
}

/**
 * A finger on `locator`'s centre: `down`, then each of `moves` (pixels below where it went down, `wait` ms after the
 * last), all in one task when no waits are given — as fast as a flick.
 */
const finger = {
  down: (locator) =>
    locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const target = document.elementFromPoint(x, y) ?? el;
      window.__finger = { target, x, y };
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          pointerId: 9,
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    }),
  move: (page, moves) =>
    page.evaluate(async (moves) => {
      const { target, x, y } = window.__finger;
      for (const { dy, wait = 0 } of moves) {
        if (wait) await new Promise((done) => setTimeout(done, wait));
        target.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerType: 'touch',
            pointerId: 9,
            isPrimary: true,
            clientX: x,
            clientY: y + dy,
            bubbles: true,
          }),
        );
      }
    }, moves),
  up: (page, dy) =>
    page.evaluate((dy) => {
      const { target, x, y } = window.__finger;
      target.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerType: 'touch',
          pointerId: 9,
          isPrimary: true,
          clientX: x,
          clientY: y + dy,
          bubbles: true,
        }),
      );
    }, dy),
  /** A deliberately fast gesture. Keep its moves and release in one browser task so runner load cannot turn the
   * Playwright round trip between them into more than the product's 100 ms flick window. */
  flick: (locator, moves) =>
    locator.evaluate((el, moves) => {
      const box = el.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const target = document.elementFromPoint(x, y) ?? el;
      const event = (type, dy) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerType: 'touch',
            pointerId: 9,
            isPrimary: true,
            clientX: x,
            clientY: y + dy,
            bubbles: true,
          }),
        );
      event('pointerdown', 0);
      for (const dy of moves) event('pointermove', dy);
      event('pointerup', moves.at(-1) ?? 0);
    }, moves),
};

/** A slow drag to `to` pixels down, in 10 px steps a frame or more apart: no flick. */
const slowly = (to) =>
  Array.from({ length: Math.ceil(to / 10) }, (_, i) => ({
    dy: Math.min(to, (i + 1) * 10),
    wait: 40,
  }));

const top = async (locator) => (await locator.boundingBox()).y;

for (const [engine, browserType] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  test.describe(`the phone sheet's head (${engine})`, () => {
    test.skip(
      browserType === webkit && !existsSync(webkit.executablePath()),
      'WebKit is not installed here',
    );

    test('a short drag moves the sheet with the finger, and it springs back open', async () => {
      const { browser, page, sheet, heading } = await openSheet(browserType);
      try {
        const rest = await top(sheet);
        await finger.down(heading);
        await finger.move(page, slowly(40));
        await expect(sheet).toBeVisible();
        expect(await top(sheet)).toBeCloseTo(rest + 40, 0);
        await page.waitForTimeout(150);
        await finger.up(page, 40);
        await expect.poll(() => top(sheet)).toBeCloseTo(rest, 0);
        await expect(sheet).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('a drag past 30% of its height closes it', async () => {
      const { browser, page, sheet, heading } = await openSheet(browserType);
      try {
        const rest = await top(sheet);
        const far = Math.round((await sheet.boundingBox()).height * 0.4);
        await finger.down(heading);
        await finger.move(page, slowly(far));
        // Still open while the finger is down, and as far down as it.
        await expect(sheet).toBeVisible();
        expect(await top(sheet)).toBeCloseTo(rest + far, 0);
        await page.waitForTimeout(150);
        await finger.up(page, far);
        await expect(sheet).toBeHidden();
      } finally {
        await browser.close();
      }
    });

    test('a quick flick closes it, however short', async () => {
      const { browser, sheet, heading } = await openSheet(browserType);
      try {
        await finger.flick(heading, [10, 20]);
        await expect(sheet).toBeHidden();
      } finally {
        await browser.close();
      }
    });

    test('a tap on the heading closes it', async () => {
      const { browser, sheet, heading } = await openSheet(browserType);
      try {
        await heading.tap();
        await expect(sheet).toBeHidden();
      } finally {
        await browser.close();
      }
    });

    test('the list scrolls under the head, which stays put, and a drag in it mid-list moves nothing', async () => {
      const { browser, page, sheet, heading } = await openSheet(browserType);
      try {
        const rest = await top(sheet);
        const headAt = await top(heading);
        const list = sheet.locator('.items');
        // Down the list to an item below the fold, however it scrolls (mobile WebKit has no wheel to send).
        await sheet.getByRole('menuitemradio').nth(25).scrollIntoViewIfNeeded();
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await top(heading)).toBeCloseTo(headAt, 0);
        expect(await top(sheet)).toBeCloseTo(rest, 0);

        // A finger down mid-list, dragging down: that scrolls the list back, it doesn't move or close the sheet.
        const item = sheet.getByRole('menuitemradio').nth(15);
        await finger.down(item);
        await finger.move(page, slowly(60));
        await finger.up(page, 60);
        await page.waitForTimeout(300);
        await expect(sheet).toBeVisible();
        expect(await top(sheet)).toBeCloseTo(rest, 0);
      } finally {
        await browser.close();
      }
    });

    test('with reduced motion it closes or stays at once, with no travel', async () => {
      const { browser, page, sheet, heading } = await openSheet(browserType, {
        reducedMotion: 'reduce',
      });
      try {
        const rest = await top(sheet);
        await finger.down(heading);
        await finger.move(page, slowly(40));
        await page.waitForTimeout(150);
        await finger.up(page, 40);
        // Back where it rests by the very next read, with no transition to run.
        const settled = await sheet.evaluate((el) => ({
          transform: getComputedStyle(el).transform,
          transition: getComputedStyle(el).transitionDuration,
          open: el.matches(':popover-open'),
        }));
        expect(settled).toEqual({ transform: 'none', transition: '0s', open: true });
        expect(await top(sheet)).toBeCloseTo(rest, 0);

        const far = Math.round((await sheet.boundingBox()).height * 0.4);
        await finger.down(heading);
        await finger.move(page, slowly(far));
        await page.waitForTimeout(150);
        await finger.up(page, far);
        // Closed by the very next read: nothing slid away first (that takes 220 ms).
        expect(await page.evaluate(() => !!document.querySelector('[popover]:popover-open'))).toBe(
          false,
        );
      } finally {
        await browser.close();
      }
    });
  });
}
