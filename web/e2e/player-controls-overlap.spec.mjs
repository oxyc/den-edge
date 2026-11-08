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

async function mockPlayer(page, { subtitles = false } = {}) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/scout/config/stream/**`, (route) =>
    route.fulfill({ json: { streams: [] } }),
  );
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
        // A subtitle rendition puts the subtitle picker in the bar too.
        ...(subtitles ? { subtitles: [{ language: 'en', name: 'English' }] } : {}),
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

async function openPlaying(page, query = '', options = {}) {
  await mockPlayer(page, options);
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
        // The phone gets what the desktop gets: play from the beginning, and Den's own fullscreen.
        await expect(page.getByRole('button', { name: 'Play from beginning' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();

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

// A phone held upright, with every control the bar can show (stream, play from beginning, next episode, subtitles,
// audio, AirPlay, mute, PiP, fullscreen): one row of them along the bottom, the stream, beginning and next at its left
// and the rest at its right, each a bare glyph on a 44px target, nothing over anything, and the release name clear of
// the picture. What the row has no room for is in its More menu, and works from there.
for (const [engine, browserType] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 430, height: 932 },
  ]) {
    test(`a phone upright gets one row of quiet controls, the label clear of the picture (${engine}, ${viewport.width}px)`, async () => {
      test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
      const browser = await launch(browserType);
      try {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
        // AirPlay, as WebKit on an iPhone offers it.
        await context.addInitScript(() => {
          Object.defineProperty(HTMLVideoElement.prototype, 'webkitShowPlaybackTargetPicker', {
            configurable: true,
            value() {},
          });
        });
        const page = await context.newPage();
        const video = await openPlaying(page, '?next&nextEpisode', { subtitles: true });
        await showControls(page);
        await expect(page.getByRole('button', { name: 'Subtitles: Off' })).toBeVisible();
        const layout = await uprightLayout(page);

        // One row: every bar control on the same line, the left group wholly left of the right one, at either end.
        const tops = layout.row.map((control) => control.top);
        expect(Math.max(...tops) - Math.min(...tops), JSON.stringify(layout.row)).toBeLessThan(3);
        const left = layout.row.filter((control) => LEFT_GROUP.test(control.name));
        const right = layout.row.filter((control) => !LEFT_GROUP.test(control.name));
        expect(left.map((control) => control.name)).toContain(layout.row[0].name);
        expect(right.length).toBeGreaterThanOrEqual(4);
        expect(Math.max(...left.map((c) => c.right))).toBeLessThanOrEqual(
          Math.min(...right.map((c) => c.left)),
        );
        expect(right.some((control) => control.name === 'Enter fullscreen')).toBe(true);
        expect(Math.max(...right.map((c) => c.right))).toBeGreaterThan(viewport.width - 24);
        expect(Math.min(...left.map((c) => c.left))).toBeLessThan(24);
        expect(Math.max(...right.map((c) => c.right))).toBeLessThanOrEqual(viewport.width);
        expect(Math.min(...left.map((c) => c.left))).toBeGreaterThanOrEqual(0);

        expect(layout.collisions).toEqual([]);
        expect(await overlaps(page)).toEqual([]);
        expect(layout.small).toEqual([]);
        expect(await smallTargets(page)).toEqual([]);
        // Bare glyphs, the play button alone filled.
        expect(layout.filled).toEqual([]);
        expect(layout.playFilled).toBe(true);
        // The release name is in the controls, not over the picture.
        expect(layout.labelOverPicture, JSON.stringify(layout.label)).toBe(false);

        // What did not fit is in the More menu, least used first: play from beginning, PiP, then mute and AirPlay.
        const pip = await video.evaluate(
          (v) => !!document.pictureInPictureEnabled || 'webkitSetPresentationMode' in v,
        );
        const more = page.getByRole('button', { name: 'More controls' });
        const names = layout.row.map((control) => control.name);
        expect(names).toContain('Next: S1 · E2');
        if (viewport.width >= 430 && pip) {
          // Nine controls, nine 44px places: nothing moves.
          await expect(more).toHaveCount(0);
          expect(names).toEqual(
            expect.arrayContaining(['Play from beginning', 'Picture in picture']),
          );
          return;
        }
        await expect(more).toBeVisible();
        await more.tap();
        const menu = page.getByRole('menu', { name: 'More controls' });
        await expect(menu.getByRole('menuitem', { name: 'Play from beginning' })).toBeVisible();
        const moved = await menu.getByRole('menuitem').allTextContents();
        const order = [
          'Play from beginning',
          ...(pip ? ['Picture in picture'] : []),
          'Mute',
          'AirPlay',
        ];
        expect(moved.map((item) => item.trim())).toEqual(order.slice(0, moved.length));
        for (const item of moved) expect(names).not.toContain(item.trim());
        // Moved only because the row had no room for them: back in it, they would not fit.
        expect((names.length - 1 + moved.length) * 44).toBeGreaterThan(layout.barWidth);
        const before = await video.evaluate((v) => v.currentTime);
        expect(before).toBeGreaterThan(1);
        await menu.getByRole('menuitem', { name: 'Play from beginning' }).tap();
        await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeLessThan(before);
      } finally {
        await browser.close();
      }
    });
  }
}

/** The bar's start: the stream, play from beginning and next episode. */
const LEFT_GROUP = /^(Stream: |Play from beginning$|Next: )/;

/**
 * The upright row's controls and how they sit: any two of the row, the transport and the timeline that intersect,
 * any target under 44×44, any secondary control with a filled background, and whether the release name crosses the
 * picture (the part of the video's box the frame fills).
 */
async function uprightLayout(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const name = (element) => element.getAttribute('aria-label') || element.textContent?.trim();
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { name: name(element), left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const meet = (p, q) =>
      p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
    const rowElements = [
      ...document.querySelectorAll('.player footer .controls :is(button, a, .cast-slot)'),
    ].filter(visible);
    const transportElements = [
      ...document.querySelectorAll('.player .full-tv-transport :is(button, input)'),
    ].filter(visible);
    const row = rowElements.map(box).sort((a, b) => a.left - b.left);
    const all = [...row, ...transportElements.map(box)];
    const collisions = [];
    for (let i = 0; i < all.length; i += 1)
      for (let j = i + 1; j < all.length; j += 1)
        if (meet(all[i], all[j])) collisions.push(`${all[i].name} × ${all[j].name}`);
    const small = all
      .filter((control) => control.name !== 'Playback position')
      .filter((control) => control.right - control.left < 44 || control.bottom - control.top < 44)
      .map((c) => `${c.name} ${Math.round(c.right - c.left)}×${Math.round(c.bottom - c.top)}`);
    const filledStyle = (element) => {
      const style = getComputedStyle(element);
      const transparent =
        style.backgroundColor === 'transparent' || /rgba\(.*,\s*0\)$/.test(style.backgroundColor);
      return !transparent || style.backgroundImage !== 'none';
    };
    const filled = [
      ...rowElements,
      ...transportElements.filter((element) => element.matches('button:not(.tv-play-pause)')),
    ]
      .filter(filledStyle)
      .map((element) => `${name(element)} ${getComputedStyle(element).backgroundColor}`);
    const play = document.querySelector('.player .tv-play-pause');
    const video = document.querySelector('.player video');
    const v = video.getBoundingClientRect();
    const scale = Math.min(v.width / video.videoWidth, v.height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    const picture = {
      left: v.left + (v.width - w) / 2,
      top: v.top + (v.height - h) / 2,
      right: v.left + (v.width + w) / 2,
      bottom: v.top + (v.height + h) / 2,
    };
    const release = document.querySelector('.player footer .release');
    const label = release && visible(release) ? box(release) : null;
    return {
      row,
      collisions,
      small,
      filled,
      playFilled: filledStyle(play),
      label: { label, picture },
      labelOverPicture: !!label && meet(label, picture),
      barWidth: document.querySelector('.player footer').getBoundingClientRect().width,
    };
  });
}

/** A touch-only phone: mobile emulation where the engine has it (Firefox has none; touch alone makes it coarse). */
async function touchPage(browser, browserType, viewport) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: browserType !== firefox,
  });
  return context.newPage();
}

/** Tap the middle of the picture, as a finger does. */
async function tapPicture(page) {
  const box = await page.locator('.player video').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** The controls showing, by a tap on the picture if they had hidden. */
async function showControls(page) {
  const player = page.locator('.player');
  if (/web-controls-hidden/.test((await player.getAttribute('class')) ?? ''))
    await tapPicture(page);
  await expect(player).not.toHaveClass(/web-controls-hidden/);
}

/**
 * Every visible control of the transport and the bar smaller than a 44px target, by name and size. Den's shared
 * `Button`s (AirPlay) take their 44px `den-button-icon` box from the app stylesheet, which this fixture does not load.
 */
async function smallTargets(page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.player .full-tv-transport :is(button, input), .player footer .controls :is(button, a, select)',
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
