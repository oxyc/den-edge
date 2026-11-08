// One transport at a time, and Den's own controls never over another control. A browser with a fine, hovering pointer
// gets Den's transport and a video without native controls; a touch-only one gets the native controls with Den's bar
// in its own row below the picture. A hybrid device (a touchscreen laptop whose browser calls the touch screen its
// primary pointer) counts as having the fine pointer, and the choice follows the device when it changes mid-play.
// On the real player, in Chromium, Firefox and WebKit.
import { test, expect, chromium, firefox, webkit } from '@playwright/test';
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
const FINE_POINTER = '(any-hover: hover) and (any-pointer: fine)';

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
        sid: 'overlap1',
        playlist: '/direct/s/overlap1/sig/master.m3u8',
        duration: 60,
        release,
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        // Two tracks, so the audio picker is in the bar on every layout.
        audioTracks: [
          { language: 'eng', name: null, channels: 2, commentary: false },
          { language: 'swe', name: null, channels: 2, commentary: false },
        ],
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

/**
 * The pointer query answered by the test instead of the browser, which no engine's emulation can make "touch screen
 * primary, trackpad present". `window.__finePointer(bool)` changes the answer and fires `change`, as plugging in a
 * mouse or leaving tablet mode does. Every other query is the browser's own.
 */
function controlledPointer(initial) {
  const real = window.matchMedia.bind(window);
  let fine = initial;
  const lists = new Set();
  window.matchMedia = (query) => {
    if (query !== '(any-hover: hover) and (any-pointer: fine)') return real(query);
    const target = new EventTarget();
    const list = Object.assign(target, {
      media: query,
      onchange: null,
      addListener: (listener) => target.addEventListener('change', listener),
      removeListener: (listener) => target.removeEventListener('change', listener),
    });
    // A getter, not a value: Object.assign would copy today's answer for good.
    Object.defineProperty(list, 'matches', { get: () => fine });
    lists.add(list);
    return list;
  };
  window.__finePointer = (next) => {
    fine = next;
    for (const list of lists) {
      const event = new Event('change');
      Object.assign(event, { matches: fine, media: list.media });
      list.dispatchEvent(event);
    }
  };
}

async function launch(browserType) {
  return browserType.launch(
    browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
  );
}

async function openPlaying(page, query = '') {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html${query}`);
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((v) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);
  return video;
}

/**
 * Every pair of a Den bar control and a transport control (or the video's own box), and of the transport's own
 * groups, whose rectangles intersect.
 */
async function overlaps(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        w: r.width,
        h: r.height,
      };
    };
    const name = (element) =>
      element.getAttribute('aria-label') ||
      element.textContent?.trim().slice(0, 30) ||
      element.className;
    const visible = (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const bar = [
      ...document.querySelectorAll(
        '.player footer .controls :is(button, a, select), .player footer .release',
      ),
    ].filter(visible);
    const transport = [
      ...document.querySelectorAll(
        '.player .full-tv-transport :is(button, input), .player .tv-timeline span',
      ),
    ].filter(visible);
    const found = [];
    const pairs = bar.flatMap((a) => transport.map((b) => [a, b]));
    // Inside the transport too: its right-hand group (volume, PiP, fullscreen) against its centre buttons.
    const centre = [...document.querySelectorAll('.player .tv-transport-actions > button')];
    const extras = [
      ...document.querySelectorAll('.player .web-transport-extras :is(button, input)'),
    ].filter(visible);
    for (const a of extras) for (const b of centre) pairs.push([a, b]);
    for (const [a, b] of pairs) {
      const p = box(a);
      const q = box(b);
      if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom)
        found.push(`${name(a)} × ${name(b)}`);
    }
    // Native controls are drawn inside the video's own box, along its bottom: Den's bar must stay out of it.
    const video = document.querySelector('.player video');
    if (video?.hasAttribute('controls')) {
      const v = box(video);
      for (const a of bar) {
        const p = box(a);
        if (p.left < v.right && v.left < p.right && p.top < v.bottom && v.top < p.bottom)
          found.push(`${name(a)} × native controls`);
      }
    }
    return found;
  });
}

const engines = [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
];

for (const [engine, browserType] of engines) {
  // A mouse: Den's transport only, its bar clear of the transport at any window width, and while the next episode
  // counts down (its two wide text buttons, Next and Stay, appear).
  for (const width of [1440, 1100, 1000, 780, 640]) {
    test(`a mouse gets Den's transport alone, nothing over it (${engine}, ${width}px)`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await launch(browserType);
      try {
        const context = await browser.newContext({ viewport: { width, height: 720 } });
        const page = await context.newPage();
        const video = await openPlaying(page, '?next&resume=52');
        await page.mouse.move(width / 2, 300);
        await expect(video).not.toHaveAttribute('controls', '');
        await expect(page.getByRole('navigation', { name: 'Playback controls' })).toBeVisible();
        expect(await overlaps(page)).toEqual([]);

        // The end: the countdown's Next and Stay.
        await expect(page.getByRole('button', { name: 'Stay' })).toBeVisible({ timeout: 30_000 });
        expect(await overlaps(page)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }

  // A touch-only phone: the native controls alone, Den's bar below the video's box rather than over its controls.
  test(`a touch-only phone gets the native controls alone, nothing over them (${engine})`, async () => {
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
    const browser = await launch(browserType);
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        // Firefox has no mobile emulation; touch alone makes its pointer coarse.
        isMobile: browserType !== firefox,
      });
      const page = await context.newPage();
      const video = await openPlaying(page, '?next&resume=52');
      expect(await page.evaluate((q) => matchMedia(q).matches, FINE_POINTER)).toBe(false);
      await expect(video).toHaveAttribute('controls', '');
      await expect(page.getByRole('navigation', { name: 'Playback controls' })).toHaveCount(0);
      expect(await overlaps(page)).toEqual([]);
      await expect(page.getByRole('button', { name: 'Stay' })).toBeVisible({ timeout: 30_000 });
      expect(await overlaps(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // A touchscreen laptop: touch is the primary pointer, a trackpad is there too. Den's transport, and when the
  // trackpad goes (tablet mode) the native controls take over — and back — without two at once.
  test(`a hybrid device follows its pointer, one transport at a time (${engine})`, async () => {
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
    const browser = await launch(browserType);
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
      });
      await context.addInitScript(controlledPointer, true);
      const page = await context.newPage();
      const video = await openPlaying(page);
      const transport = page.getByRole('navigation', { name: 'Playback controls' });
      await expect(video).not.toHaveAttribute('controls', '');
      await expect(transport).toBeVisible();

      await page.evaluate(() => window.__finePointer(false));
      await expect(video).toHaveAttribute('controls', '');
      await expect(transport).toHaveCount(0);
      expect(await overlaps(page)).toEqual([]);
      expect(await video.evaluate((v) => v.paused)).toBe(false);

      await page.evaluate(() => window.__finePointer(true));
      await expect(video).not.toHaveAttribute('controls', '');
      await expect(transport).toBeVisible();
      // Taking over mid-play, Den's transport shows where the element is, and that it is playing.
      await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
      await expect(page.getByLabel('Playback position')).not.toHaveAttribute(
        'aria-valuetext',
        /^0:00 /,
      );
      expect(await overlaps(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}
