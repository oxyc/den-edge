// The browser player laid out as Apple's own ("A · Cinema"): close and title at the top with the one output slot at its
// right end, the transport over the middle of the picture on a touch screen, the timeline, then one dock row. A mouse
// gets the transport in the dock instead, hover reveal with the cursor hidden when idle, click to pause and double-click
// for fullscreen. Settings live behind ⋯, a bottom sheet on a phone and a popover elsewhere, each row with its value.
// On the real player, at phone, tablet and desktop sizes, in Chromium, Firefox and WebKit.
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

async function mockPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  // The next episode's streams, warmed before the advance.
  await page.route(`${ORIGIN}/scout/**`, (route) => route.fulfill({ json: { streams: [] } }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  await page.route(`${ORIGIN}/direct/session`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        sid: 'layout1',
        playlist: '/direct/s/layout1/sig/master.m3u8',
        duration: 60,
        release,
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [
          { language: 'eng', name: null, channels: 2, commentary: false },
          { language: 'swe', name: null, channels: 2, commentary: false },
        ],
        subtitles: [{ language: 'en', name: 'English' }],
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

const engines = [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
];

const PHONES = [
  { name: 'phone 320 upright', width: 320, height: 568 },
  { name: 'phone 375 upright', width: 375, height: 812 },
  { name: 'phone 430 upright', width: 430, height: 932 },
  { name: 'phone 812 on its side', width: 812, height: 375 },
];
const TABLETS = [
  { name: 'iPad 820 upright', width: 820, height: 1180 },
  { name: 'iPad 1180 on its side', width: 1180, height: 820 },
];
const DESKTOPS = [
  { name: 'desktop 1440', width: 1440, height: 900 },
  { name: 'desktop 1024', width: 1024, height: 720 },
];

async function launch(browserType) {
  return browserType.launch(
    browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
  );
}

/** A touch-only device (mobile emulation where the engine has it), or a mouse window. */
async function newPage(browser, browserType, viewport, touch) {
  const context = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch && browserType !== firefox,
  });
  // Fullscreen as a call, so every engine — headless or not — can say it was asked for.
  await context.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => true });
    Element.prototype.requestFullscreen = function () {
      window.fullscreenAsks = (window.fullscreenAsks ?? 0) + 1;
      return Promise.resolve();
    };
  });
  return context.newPage();
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

/** The controls showing: a tap above the transport on a touch screen, a mouse move otherwise. */
async function showControls(page, touch) {
  const player = page.locator('.player');
  if (!/web-controls-hidden/.test((await player.getAttribute('class')) ?? '')) return;
  const box = await page.locator('.player video').boundingBox();
  // Between the toast lane at the top and the transport at the centre.
  if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.38);
  else await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(player).not.toHaveClass(/web-controls-hidden/);
}

/** The dock's visible controls, left to right, with their names and boxes. */
async function dock(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.player .web-dock :is(button, a, input, .web-time)')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const r = element.getBoundingClientRect();
        return {
          name:
            element.getAttribute('aria-label') ?? element.textContent?.trim().replace(/\d/g, '#'),
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          height: r.height,
        };
      })
      .sort((a, b) => a.left - b.left),
  );
}

/** Every pair of the player's visible controls whose boxes intersect. */
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

/** Visible controls smaller than a 44px target; the timeline needs only its height. */
async function smallTargets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.player :is(header, .web-transport) :is(button, a, input)')]
      .filter(
        (element) => element.getClientRects().length && !element.classList.contains('den-button'),
      )
      .map((element) => {
        const r = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label'), w: r.width, h: r.height };
      })
      .filter((t) => t.h < 44 || (t.w < 44 && t.name !== 'Playback position'))
      .map((t) => `${t.name} ${Math.round(t.w)}×${Math.round(t.h)}`),
  );
}

/** Where the frame is drawn inside the video's box (`object-fit: contain`). */
async function pictureBox(page) {
  const video = page.locator('.player video');
  await expect.poll(() => video.evaluate((v) => v.videoWidth)).toBeGreaterThan(0);
  return video.evaluate((video) => {
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    return {
      top: box.top + (box.height - height) / 2,
      bottom: box.top + (box.height + height) / 2,
      left: box.left + (box.width - width) / 2,
      right: box.left + (box.width + width) / 2,
    };
  });
}

/**
 * The WCAG contrast of a toast action's text against its own chip, the chip laid over the toast and the toast over a
 * white picture behind it (the lightest a scene can be).
 */
async function contrastOnToast(action) {
  return action.evaluate((element) => {
    const rgba = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { r, g, b, a };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const luminance = ({ r, g, b }) => {
      const [R, G, B] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const toast = getComputedStyle(element.closest('.notice')).backgroundColor;
    const chip = getComputedStyle(element).backgroundColor;
    const ground = over(rgba(chip), over(rgba(toast), { r: 255, g: 255, b: 255, a: 1 }));
    const text = over(rgba(getComputedStyle(element).color), ground);
    const [light, dark] = [luminance(text), luminance(ground)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

const canPictureInPicture = (page) =>
  page.evaluate(
    () =>
      ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) ||
      'webkitSetPresentationMode' in HTMLVideoElement.prototype,
  );

for (const [engine, browserType] of engines) {
  const installed = () =>
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);

  for (const viewport of [...PHONES, ...TABLETS, ...DESKTOPS]) {
    const touch = !DESKTOPS.includes(viewport);
    test(`one dock row, nothing over anything (${engine}, ${viewport.name})`, async () => {
      installed();
      const browser = await launch(browserType);
      try {
        const page = await newPage(browser, browserType, viewport, touch);
        const video = await openPlaying(page, '?next&nextEpisode&resume=20');
        await expect(video).not.toHaveAttribute('controls', '');

        // Opening mid-title says where, in the one toast lane; on an upright phone it sits above the picture.
        const toast = page.locator('.web-toasts .notice');
        await expect(toast).toContainText('Resumed at 0:20');
        const startOver = toast.getByRole('button', { name: 'Start over' });
        await expect(startOver).toBeVisible();
        // Its offer reads against its own chip, whatever the picture behind it.
        expect(await contrastOnToast(startOver)).toBeGreaterThanOrEqual(4.5);
        if (touch && viewport.height > viewport.width && viewport.width < 528) {
          const picture = await pictureBox(page);
          const box = await toast.boundingBox();
          expect(box.y + box.height).toBeLessThanOrEqual(picture.top);
        }

        await showControls(page, touch);
        const pip = await canPictureInPicture(page);
        const row = await dock(page);
        // One row: every control in it shares its line.
        const middle = (control) => (control.top + control.bottom) / 2;
        for (const control of row)
          expect(Math.abs(middle(control) - middle(row[0]))).toBeLessThan(3);
        // Play or Pause, whichever it is now: WebKit may not have let the fixture autoplay.
        const names = row.map((control) => control.name.replace(/^(Play|Pause)$/, 'Play/Pause'));
        const phoneGeometry = viewport.width < 528;
        const pointerDock = !touch && !phoneGeometry;
        expect(names).toEqual([
          ...(pointerDock
            ? [
                'Play/Pause',
                'Rewind 10 seconds',
                'Forward 10 seconds',
                'Mute',
                ...(viewport.width >= 768 ? ['Volume'] : []),
                ...(viewport.width >= 640 ? ['#:## / #:##'] : []),
              ]
            : []),
          'Audio and subtitles: English, subtitles Off',
          'Next episode: S1 · E2',
          ...(pointerDock ? [] : ['Mute']),
          ...(pip ? ['Picture in picture'] : []),
          'Enter fullscreen',
          'More playback options',
        ]);
        // A touch screen's transport is over the picture, not in the dock.
        const centre = page.locator('.web-centre');
        if (pointerDock) await expect(centre).toBeHidden();
        else await expect(centre.getByRole('button', { name: /^(Play|Pause)$/ })).toBeVisible();
        // The labels show where there is room for them.
        const labelled = await page
          .locator('.web-dock .web-label')
          .first()
          .evaluate((label) => getComputedStyle(label).display !== 'none');
        expect(labelled).toBe(!phoneGeometry);

        expect(await overlaps(page)).toEqual([]);
        if (touch) expect(await smallTargets(page)).toEqual([]);
        // The release's name is in the options, never on the picture.
        await expect(page.getByText(release.label)).toHaveCount(0);
        // Close at the top left, the output slot's place at the right end.
        const close = await page.getByRole('button', { name: 'Close player' }).boundingBox();
        const output = await page.locator('.web-output').boundingBox();
        expect(close.x).toBeLessThan(viewport.width / 4);
        expect(output.x + output.width).toBeGreaterThan(viewport.width - 64);
        expect(output.width).toBeGreaterThanOrEqual(44);
      } finally {
        await browser.close();
      }
    });
  }

  // The options: a sheet on a phone, a popover anchored to ⋯ on a tablet or a desktop; each row with its value, and the
  // header naming the release and the path playing.
  for (const [viewport, touch, sheet] of [
    [PHONES[1], true, true],
    [PHONES[3], true, true],
    [TABLETS[0], true, false],
    [DESKTOPS[0], false, false],
  ]) {
    test(`the options are a ${sheet ? 'sheet' : 'popover'} with current values (${engine}, ${viewport.name})`, async () => {
      installed();
      const browser = await launch(browserType);
      try {
        const page = await newPage(browser, browserType, viewport, touch);
        await openPlaying(page, '?next&nextEpisode');
        await showControls(page, touch);
        const more = page.getByRole('button', { name: 'More playback options' });
        await (touch ? more.tap() : more.click());
        const menu = page.getByRole('menu', { name: 'More playback options' });
        await expect(menu).toBeVisible();
        if (sheet) await expect(menu).toHaveClass(/\bsheet\b/);
        else {
          await expect(menu).not.toHaveClass(/\bsheet\b/);
          // Beside its button, above the dock, inside the window.
          const box = await menu.boundingBox();
          const trigger = await more.boundingBox();
          expect(box.y + box.height).toBeLessThanOrEqual(trigger.y + 1);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        }
        await expect(menu.locator('.options-release')).toHaveText(release.label);
        await expect(menu.locator('.options-chip')).toHaveText('Den Remux');
        await expect(
          menu.getByRole('menuitem', { name: 'Audio & subtitles, English · Off' }),
        ).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: /^Stream, \S/ })).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: 'Play from beginning' })).toBeVisible();
        // A row opens its page in place, with the way back.
        await menu.getByRole('menuitem', { name: /^Audio & subtitles/ }).click();
        await expect(
          menu
            .getByRole('group', { name: 'Audio' })
            .getByRole('menuitemradio', { name: 'English' }),
        ).toHaveAttribute('aria-checked', 'true');
        await expect(
          menu
            .getByRole('group', { name: 'Subtitles' })
            .getByRole('menuitemradio', { name: 'Off' }),
        ).toHaveAttribute('aria-checked', 'true');
        await menu.getByRole('menuitem', { name: 'Back' }).click();
        await expect(menu.getByRole('menuitem', { name: /^Audio & subtitles/ })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        // WebKit's popover takes Escape as its own close request and leaves focus where it lands.
        if (browserType !== webkit) await expect(more).toBeFocused();
        await expect(page.locator('.player')).toHaveCount(1);
      } finally {
        await browser.close();
      }
    });
  }

  // Double-tap a side to seek ten seconds; each tap after it within the moment adds ten more.
  test(`double-tap seeks ten seconds, and taps after it add up (${engine})`, async () => {
    installed();
    const browser = await launch(browserType);
    try {
      const page = await newPage(browser, browserType, PHONES[1], true);
      const video = await openPlaying(page, '?resume=20');
      await video.evaluate((v) => v.pause());
      const from = await video.evaluate((v) => v.currentTime);
      const box = await video.boundingBox();
      const right = { x: box.x + box.width * 0.85, y: box.y + box.height * 0.25 };
      await page.touchscreen.tap(right.x, right.y);
      await page.touchscreen.tap(right.x, right.y);
      await page.touchscreen.tap(right.x, right.y);
      await expect(page.locator('.web-ripple')).toHaveText('+20 s');
      await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(from + 19);
      expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(from + 21);
      await expect(page.locator('.player')).not.toHaveClass(/web-controls-hidden/);
      // A tap in the middle on its own only shows or hides the controls.
      await page.waitForTimeout(700);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.25);
      await expect(page.locator('.player')).toHaveClass(/web-controls-hidden/);
      expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(from + 21);
    } finally {
      await browser.close();
    }
  });

  // A mouse moving reveals the controls; left still for 2.5 s they hide, and the cursor with them. Over the dock they
  // stay. A click on the picture pauses or plays; a double-click is fullscreen and leaves playback as it was.
  test(`a mouse reveals, idles, clicks and double-clicks (${engine})`, async () => {
    installed();
    const browser = await launch(browserType);
    try {
      const page = await newPage(browser, browserType, DESKTOPS[0], false);
      const video = await openPlaying(page);
      const player = page.locator('.player');
      await page.mouse.move(700, 400);
      await expect(player).not.toHaveClass(/web-controls-hidden/);
      const shownAt = Date.now();
      await expect(player).toHaveClass(/web-controls-hidden/, { timeout: 8_000 });
      expect(Date.now() - shownAt).toBeGreaterThan(2_000);
      expect(await player.evaluate((element) => getComputedStyle(element).cursor)).toBe('none');
      await page.mouse.move(720, 420);
      await expect(player).not.toHaveClass(/web-controls-hidden/);
      expect(await player.evaluate((element) => getComputedStyle(element).cursor)).not.toBe('none');
      await page.getByRole('button', { name: 'Enter fullscreen' }).hover();
      await page.waitForTimeout(3_500);
      await expect(player).not.toHaveClass(/web-controls-hidden/);

      await video.click({ position: { x: 300, y: 300 } });
      await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
      await expect(page.locator('.web-centre-glyph')).toBeVisible();
      await video.click({ position: { x: 300, y: 300 } });
      await expect.poll(() => video.evaluate((v) => v.paused)).toBe(false);
      await video.dblclick({ position: { x: 300, y: 300 } });
      await expect.poll(() => page.evaluate(() => window.fullscreenAsks)).toBe(1);
      await page.waitForTimeout(400);
      expect(await video.evaluate((v) => v.paused)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  // The keys: J/L (and the arrows) seek ten seconds and add up when pressed again, Up/Down change the volume with a
  // toast, C turns subtitles on and off, Shift+N plays the next episode. Tooltips name them.
  test(`keyboard shortcuts (${engine})`, async () => {
    installed();
    const browser = await launch(browserType);
    try {
      const page = await newPage(browser, browserType, DESKTOPS[0], false);
      const video = await openPlaying(page, '?next&nextEpisode&resume=40');
      await page.locator('.player').focus();
      // K toggles; WebKit may not have let the fixture autoplay, so it ends paused either way.
      const wasPaused = await video.evaluate((v) => v.paused);
      await page.keyboard.press('k');
      await expect.poll(() => video.evaluate((v) => v.paused)).toBe(!wasPaused);
      if (wasPaused) await page.keyboard.press('k');
      await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
      const from = await video.evaluate((v) => v.currentTime);
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      await expect(page.locator('.web-ripple')).toHaveText('−20 s');
      await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeLessThan(from - 19);
      await page.keyboard.press('l');
      await expect(page.locator('.web-ripple')).toHaveText('+10 s');

      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.web-toasts')).toContainText('Volume 95%');
      expect(await video.evaluate((v) => Math.round(v.volume * 100))).toBe(95);
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('.web-toasts')).toContainText('Volume 100%');

      const subtitles = page.locator('button.web-audio-subtitles');
      await expect(subtitles).toHaveAttribute('aria-label', /subtitles Off$/);
      await page.keyboard.press('c');
      await expect(subtitles).toHaveAttribute('aria-label', /subtitles English$/);
      await page.keyboard.press('c');
      await expect(subtitles).toHaveAttribute('aria-label', /subtitles Off$/);

      await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toHaveAttribute(
        'data-key',
        'F',
      );
      await page.keyboard.press('Shift+N');
      await expect(page.getByTestId('player-next-count')).toHaveText('1');
    } finally {
      await browser.close();
    }
  });

  // The end of an episode: the up-next card above the timeline, apart from every control, until Stay.
  for (const [viewport, touch] of [
    [PHONES[1], true],
    [PHONES[3], true],
    [DESKTOPS[0], false],
  ]) {
    test(`the up-next card sits clear of the controls (${engine}, ${viewport.name})`, async () => {
      installed();
      const browser = await launch(browserType);
      try {
        const page = await newPage(browser, browserType, viewport, touch);
        await openPlaying(page, '?next&nextEpisode&resume=52');
        const card = page.locator('.web-up-next');
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card.getByRole('status')).toHaveText('Next episode in 10 seconds');
        await expect(card.getByRole('link', { name: 'Play now: S1 · E2' })).toBeVisible();
        expect(await overlaps(page)).toEqual([]);
        const cardBox = await card.boundingBox();
        const timeline = await page.getByLabel('Playback position').boundingBox();
        expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(timeline.y + 1);
        // On a phone on its side the card stands in for the transport, which would meet it.
        if (viewport.height < 512) await expect(page.locator('.web-centre')).toBeHidden();
        await card.getByRole('button', { name: 'Stay' }).click();
        await expect(card).toBeHidden();
      } finally {
        await browser.close();
      }
    });
  }

  // The card describes the next episode from its season: still, runtime and title. The season is asked only as this
  // episode nears its end, never at open; and a season that doesn't list it leaves the card as it was, numbers alone.
  for (const listed of [true, false]) {
    test(`the up-next card ${listed ? 'shows the next episode’s still, title and runtime' : 'falls back to its numbers'} (${engine})`, async () => {
      installed();
      const browser = await launch(browserType);
      try {
        const page = await newPage(browser, browserType, PHONES[1], true);
        const video = await openPlaying(page, '?series&next&nextEpisode');
        const seasons = [];
        await page.route('**/tmdb/3/tv/42/season/1**', (route) => {
          seasons.push(route.request().url());
          return route.fulfill({
            json: {
              episodes: [
                { episode_number: 1, name: 'Low Tide', runtime: 52 },
                ...(listed
                  ? [
                      {
                        episode_number: 2,
                        name: 'The Undertow',
                        still_path: '/undertow.jpg',
                        runtime: 47,
                      },
                    ]
                  : []),
              ],
            },
          });
        });
        const stills = [];
        await page.route('https://image.tmdb.org/**', (route) => {
          stills.push(route.request().url());
          return route.fulfill({ status: 404, body: '' });
        });
        await page.waitForTimeout(1_500);
        expect(seasons).toEqual([]);
        await video.evaluate((v) => (v.currentTime = 45));
        const card = page.locator('.web-up-next');
        await expect(card).toBeVisible({ timeout: 30_000 });
        expect(seasons).toHaveLength(1);
        await expect(card).toContainText('Up next · S1 · E2');
        if (listed) {
          await expect(card).toContainText('The Undertow');
          await expect(card.locator('.web-up-next-runtime')).toHaveText('47 min');
          await expect(card.locator('img')).toHaveAttribute('src', /\/w300\/undertow\.jpg$/);
          expect(await overlaps(page)).toEqual([]);
        } else {
          await expect(card.locator('img')).toHaveCount(0);
          await expect(card).not.toContainText('Low Tide');
        }
      } finally {
        await browser.close();
      }
    });
  }

  // What is buffered past the play head shows as a lighter fill on the timeline, from the media's own ranges.
  for (const [viewport, touch] of [
    [PHONES[1], true],
    [TABLETS[1], true],
    [DESKTOPS[0], false],
  ]) {
    test(`the timeline shows what is buffered (${engine}, ${viewport.name})`, async () => {
      installed();
      const browser = await launch(browserType);
      try {
        const page = await newPage(browser, browserType, viewport, touch);
        const video = await openPlaying(page);
        await video.evaluate((v) => v.pause());
        const track = page.getByLabel('Playback position');
        const percent = (name) =>
          track.evaluate((el, n) => parseFloat(el.style.getPropertyValue(n)) || 0, name);
        await expect.poll(() => percent('--tv-buffered')).toBeGreaterThan(0);
        const bufferedEnd = await video.evaluate((v) => {
          for (let n = 0; n < v.buffered.length; n++)
            if (v.buffered.start(n) <= v.currentTime + 0.5 && v.currentTime <= v.buffered.end(n))
              return (v.buffered.end(n) / v.duration) * 100;
          return 0;
        });
        expect(Math.abs((await percent('--tv-buffered')) - bufferedEnd)).toBeLessThan(2);
        expect(await percent('--tv-buffered')).toBeGreaterThan(await percent('--tv-progress'));
      } finally {
        await browser.close();
      }
    });
  }
}
