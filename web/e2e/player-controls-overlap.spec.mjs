// One transport, Den's, in every browser, and Den's own controls never over another control. A fine, hovering pointer
// clicks the picture to pause; a touch screen alone taps it to show or hide the controls, and gets 44px targets and a
// timeline a finger can drag to the second. A hybrid device (a touchscreen laptop whose browser calls the touch screen
// its primary pointer) changes how the transport behaves as its pointer changes, never which transport is drawn.
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
 * Every pair of the player's visible controls — top bar, transport, timeline, times, dock, Skip and the up-next card's
 * buttons — whose rectangles intersect.
 */
async function overlaps(page) {
  return page.evaluate(() => {
    const name = (element) =>
      element.getAttribute('aria-label') ||
      element.textContent?.trim().slice(0, 30) ||
      element.className;
    const controls = [
      ...document.querySelectorAll(
        '.player :is(header, .web-transport) :is(button, a, input, .cast-slot, .web-elapsed, .web-remaining, .web-time)',
      ),
    ].filter((element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    });
    const found = [];
    controls.forEach((a, i) => {
      for (const b of controls.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const p = a.getBoundingClientRect();
        const q = b.getBoundingClientRect();
        // A pixel of anti-aliasing at a shared edge is not an overlap.
        if (
          p.left < q.right - 1 &&
          q.left < p.right - 1 &&
          p.top < q.bottom - 1 &&
          q.top < p.bottom - 1
        )
          found.push(`${name(a)} × ${name(b)}`);
      }
    });
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

  // A touch-only phone, upright and on its side: Den's transport and no native controls, nothing over anything, and
  // every control a 44px target, also while the next episode counts down.
  for (const viewport of [
    { name: 'upright', width: 390, height: 844 },
    { name: 'on its side', width: 844, height: 390 },
  ]) {
    test(`a touch-only phone ${viewport.name} gets Den's transport alone, nothing over it (${engine})`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await launch(browserType);
      try {
        const page = await touchPage(browser, browserType, viewport);
        const video = await openPlaying(page, '?next&resume=52');
        expect(await page.evaluate((q) => matchMedia(q).matches, FINE_POINTER)).toBe(false);
        await expect(video).not.toHaveAttribute('controls', '');
        await showControls(page);
        await expect(page.getByRole('navigation', { name: 'Playback controls' })).toBeVisible();
        expect(await overlaps(page)).toEqual([]);
        expect(await smallTargets(page)).toEqual([]);
        // The phone gets what the desktop gets: play from the beginning (among the options), and Den's own fullscreen.
        await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
        await showControls(page);
        await page.getByRole('button', { name: 'More playback options' }).tap();
        await expect(page.getByRole('menuitem', { name: 'Play from beginning' })).toBeVisible();
        // A tap outside the sheet, which covers the dock, closes it.
        const title = await page.locator('.player header b').boundingBox();
        await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
        await expect(page.getByRole('menuitem', { name: 'Play from beginning' })).toHaveCount(0);
        await expect(page.getByTestId('player-close-count')).toHaveText('0');

        await expect(page.getByRole('button', { name: 'Stay' })).toBeVisible({ timeout: 30_000 });
        expect(await overlaps(page)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }

  // A tap on the picture shows the controls, a second hides them, and neither pauses; untouched, they hide again.
  test(`a tap shows or hides the controls and never pauses (${engine})`, async () => {
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
    const browser = await launch(browserType);
    try {
      const page = await touchPage(browser, browserType, { width: 390, height: 844 });
      const video = await openPlaying(page);
      const player = page.locator('.player');
      // Left alone while it plays, the controls hide on their own.
      await expect(player).toHaveClass(/web-controls-hidden/, { timeout: 10_000 });
      await tapPicture(page);
      await expect(player).not.toHaveClass(/web-controls-hidden/);
      expect(await video.evaluate((v) => v.paused)).toBe(false);
      await tapPicture(page);
      await expect(player).toHaveClass(/web-controls-hidden/);
      expect(await video.evaluate((v) => v.paused)).toBe(false);
      // Touching the controls keeps them up; left alone again, they go.
      await tapPicture(page);
      await page.getByRole('button', { name: 'Pause', exact: true }).tap();
      await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
      await page.getByRole('button', { name: 'Play', exact: true }).tap();
      await expect(player).not.toHaveClass(/web-controls-hidden/);
      await expect(player).toHaveClass(/web-controls-hidden/, { timeout: 10_000 });
    } finally {
      await browser.close();
    }
  });

  // A finger drag moves the timeline to any second, not in ten-second steps, and seeks once, where it lets go.
  test(`a finger drags the timeline to the second and seeks where it lets go (${engine})`, async () => {
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
    const browser = await launch(browserType);
    try {
      const page = await touchPage(browser, browserType, { width: 390, height: 844 });
      const video = await openPlaying(page);
      await showControls(page);
      const timeline = page.getByLabel('Playback position');
      await expect(timeline).toHaveAttribute('step', 'any');
      const before = await video.evaluate((v) => v.currentTime);
      // What the engine's own range does under a dragging finger: pointerdown, inputs as it moves, change at the end.
      await timeline.evaluate((input) => {
        input.dispatchEvent(
          new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }),
        );
        for (const value of ['20', '33.5']) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await expect(timeline).toHaveAttribute('aria-valuetext', /^0:33 /);
      // Not sought while the finger is still down.
      expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(before + 2);
      await timeline.evaluate((input) =>
        input.dispatchEvent(new Event('change', { bubbles: true })),
      );
      await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThanOrEqual(33);
      expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(40);
    } finally {
      await browser.close();
    }
  });

  // A touchscreen laptop: touch is the primary pointer, a trackpad is there too. Den's transport throughout, as the
  // trackpad goes (tablet mode) and comes back: never the native controls, never two at once.
  test(`a hybrid device keeps Den's transport as its pointer changes (${engine})`, async () => {
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
      await expect(page.locator('.player')).toHaveClass(/web-touch-player/);
      await expect(video).not.toHaveAttribute('controls', '');
      await showControls(page);
      await expect(transport).toBeVisible();
      expect(await overlaps(page)).toEqual([]);
      expect(await video.evaluate((v) => v.paused)).toBe(false);

      await page.evaluate(() => window.__finePointer(true));
      await expect(page.locator('.player')).not.toHaveClass(/web-touch-player/);
      await expect(video).not.toHaveAttribute('controls', '');
      await page.mouse.move(640, 300);
      await expect(transport).toBeVisible();
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

// An iPhone has no element fullscreen: Den's fullscreen hands the video to Apple's player, and Den's bar is back as
// that closes. WebKit here is a desktop build with element fullscreen, so the iPhone's answer is stood in for: no
// `fullscreenEnabled`, and a `webkitEnterFullscreen` on the video that records the hand-over.
test('an iPhone’s fullscreen is Apple’s player, and Den’s bar is back as it closes', async () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here');
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
      HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
        window.appleFullscreen = (window.appleFullscreen ?? 0) + 1;
      };
    });
    const page = await context.newPage();
    const video = await openPlaying(page);
    await showControls(page);
    await page.getByRole('button', { name: 'Enter fullscreen' }).tap();
    expect(await page.evaluate(() => window.appleFullscreen)).toBe(1);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    // Apple's player closes after the controls had gone behind it (a tap hides them here; waiting for them to hide on
    // their own needs the fixture playing, which Linux WebKit does not always do): they are back, over the same video.
    await tapPicture(page);
    await expect(page.locator('.player')).toHaveClass(/web-controls-hidden/);
    await video.evaluate((v) => v.dispatchEvent(new Event('webkitendfullscreen')));
    await expect(page.locator('.player')).not.toHaveClass(/web-controls-hidden/);
    await expect(page.getByRole('navigation', { name: 'Playback controls' })).toBeVisible();
    await expect(video).not.toHaveAttribute('controls', '');
  } finally {
    await browser.close();
  }
});

/** A touch-only phone: mobile emulation where the engine has it (Firefox has none; touch alone makes it coarse). */
async function touchPage(browser, browserType, viewport) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: browserType !== firefox,
  });
  return context.newPage();
}

/** Tap the picture as a finger does: between the toast lane at the top and the transport at its centre. */
async function tapPicture(page) {
  const box = await page.locator('.player video').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.38);
}

/** The controls showing, by a tap on the picture if they had hidden. */
async function showControls(page) {
  const player = page.locator('.player');
  if (/web-controls-hidden/.test((await player.getAttribute('class')) ?? ''))
    await tapPicture(page);
  await expect(player).not.toHaveClass(/web-controls-hidden/);
}

/**
 * Every visible control of the top bar, the transport and the dock smaller than a 44px target, by name and size. Den's
 * shared `Button`s (the up-next card's) take their box from the app stylesheet, which this fixture does not load.
 */
async function smallTargets(page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.player :is(header, .web-transport) :is(button, a, input:not(.web-volume))',
      ),
    ]
      .filter(
        (element) =>
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== 'hidden' &&
          !element.classList.contains('den-button'),
      )
      .map((element) => {
        const r = element.getBoundingClientRect();
        const name = element.getAttribute('aria-label') ?? element.textContent?.trim();
        return { name, w: r.width, h: r.height };
      })
      // The timeline is as wide as the screen allows; it is its height a finger needs.
      .filter((target) => target.h < 44 || (target.w < 44 && target.name !== 'Playback position'))
      .map((target) => `${target.name} ${Math.round(target.w)}×${Math.round(target.h)}`),
  );
}
