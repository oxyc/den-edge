import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { E2E_ORIGIN as ORIGIN, E2E_PORT } from './base-url.mjs';

const media = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'tv1',
  playlist: '/direct/s/tv1/sig/master.m3u8',
  duration: 60,
  release: { label: 'TV fixture 1080p', filename: 'tv-fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [
    { language: 'en', name: 'English', channels: 2 },
    { language: 'es', name: 'Spanish', channels: 2 },
  ],
  subtitles: [{ language: 'en', name: 'English' }],
};
const alternate = { label: 'TV fixture 720p', filename: 'tv-fixture-720.mkv', size: 2 };
const mediaServers = new Set();

test.afterEach(async () => {
  await Promise.all(
    [...mediaServers].map(
      (server) =>
        new Promise((resolve) => {
          const timeout = setTimeout(resolve, 1_000);
          server.closeAllConnections();
          server.close(() => {
            clearTimeout(timeout);
            resolve(undefined);
          });
        }),
    ),
  );
  mediaServers.clear();
});

async function nativeMediaServer(expired, { holdProbeMaster = false } = {}) {
  let closedHeld = 0;
  let gone = 0;
  let ends = 0;
  let masters = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const file = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
    if (file === 'end') {
      ends += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (expired()) {
      gone += 1;
      response.writeHead(410, { 'Content-Type': 'application/json' });
      response.end('{"error":"session_gone"}');
      return;
    }
    if (/^seg(?:1[2-9]|2[0-9])\.m4s$/.test(file)) {
      response.once('close', () => {
        if (!expired()) closedHeld += 1;
      });
      while (!expired() && !response.destroyed)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (response.destroyed) return;
      gone += 1;
      response.writeHead(410, { 'Content-Type': 'application/json' });
      response.end('{"error":"session_gone"}');
      return;
    }
    if (file === 'master.m3u8') {
      masters += 1;
      if (holdProbeMaster && masters === 2) {
        // Keep the probe inside response-body consumption until the player lifecycle aborts it.
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        response.write('#EXTM3U\n');
        await new Promise((resolve) => response.once('close', resolve));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
      return;
    }
    if (file !== 'media.m3u8' && file !== 'init.mp4' && !/^seg[0-9]+\.m4s$/.test(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = await readFile(new URL(file, media));
      response.writeHead(200, {
        'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      });
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  mediaServers.add(server);
  server.once('close', () => mediaServers.delete(server));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native media server has no port');
  return {
    closedHeld: () => closedHeld,
    ends: () => ends,
    gone: () => gone,
    masters: () => masters,
    playlist: `http://127.0.0.1:${address.port}/master.m3u8`,
    server,
  };
}

async function repeatedMediaPlaylist(minutes = 10) {
  const source = await readFile(new URL('media.m3u8', media), 'utf8');
  const segments = source.match(/#EXTINF:[^\n]+\nseg[0-9]+\.m4s/g) ?? [];
  // One cycle beyond the requested wall-clock duration lets the assertion observe the full requested minute while
  // playback is still live, rather than passing thirty seconds early or racing a natural end.
  const cycles = Math.ceil((minutes * 60) / (segments.length * 2)) + 1;
  const body = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle) body.push('#EXT-X-DISCONTINUITY');
    body.push(`#EXT-X-MAP:URI="init.mp4?cycle=${cycle}"`);
    for (const segment of segments)
      body.push(segment.replace(/(seg[0-9]+\.m4s)$/, `$1?cycle=${cycle}`));
  }
  body.push('#EXT-X-ENDLIST');
  return body.join('\n');
}

async function routePlayback(page, { onSession, onMedia, releases = [], skipSegments } = {}) {
  const ended = [];
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) =>
    skipSegments
      ? route.fulfill({ json: { segments: skipSegments } })
      : route.fulfill({ status: 404, json: {} }),
  );
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(
    `${ORIGIN}/direct/session`,
    onSession ?? ((route) => route.fulfill({ status: 201, json: session })),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) => route.fulfill({ json: { releases } }));
  await page.route(`${ORIGIN}/direct/s/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' || path.endsWith('/end')) {
      ended.push(path);
      return route.fulfill({ status: 204 });
    }
    if (request.method() === 'POST') return route.fulfill({ status: 204 });
    const file = path.split('/').pop();
    const handled = await onMedia?.(route, { path, file });
    if (handled) return;
    if (path.endsWith('/master.m3u8'))
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n',
      });
    return route.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, media)),
    });
  });
  return ended;
}

async function remoteKey(page, key, keyCode) {
  return page.evaluate(
    ({ key, keyCode }) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { key, keyCode },
  );
}

async function remoteKeyBurst(page, key, keyCode, count) {
  return page.evaluate(
    ({ key, keyCode, count }) => {
      const target = document.activeElement ?? document.body;
      return Array.from({ length: count }, () => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: keyCode });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      });
    },
    { key, keyCode, count },
  );
}

test('webOS native playback does not wait on its advertised but silent frame callback', async ({
  page,
}) => {
  test.skip(
    process.env.DEN_TV_PLATFORM === 'tizen',
    'Tizen uses AVPlay; its readiness boundary is covered by tv-avplay.spec.mjs.',
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager',
    });
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
    HTMLVideoElement.prototype.cancelVideoFrameCallback = () => undefined;
    // Hold the browser's naturally fast fixture `loadeddata` delivery until the assertion has observed the startup
    // state. The production boundary remains the real event; this only makes both sides of that boundary observable.
    const add = HTMLMediaElement.prototype.addEventListener;
    const remove = HTMLMediaElement.prototype.removeEventListener;
    const held = new Map();
    HTMLMediaElement.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'loadeddata') return add.call(this, type, listener, options);
      const listeners = held.get(this) ?? [];
      listeners.push(listener);
      held.set(this, listeners);
    };
    HTMLMediaElement.prototype.removeEventListener = function (type, listener, options) {
      if (type !== 'loadeddata') return remove.call(this, type, listener, options);
      const listeners = held.get(this);
      if (listeners)
        held.set(
          this,
          listeners.filter((heldListener) => heldListener !== listener),
        );
    };
    window.releaseFixtureLoadedData = (element) => {
      const event = new Event('loadeddata');
      for (const listener of held.get(element) ?? []) {
        if (typeof listener === 'function') listener.call(element, event);
        else listener.handleEvent(event);
      }
      held.delete(element);
    };
  });
  // This case proves Den's webOS readiness boundary, not WebKit's fixture decoder. Keep the playlist request open so
  // a busy CI runner cannot reject the tiny HLS fixture and independently exercise the release-fallback path while
  // the synthetic webOS pipeline below is deciding that its first frame is ready. Real native HLS is played by the
  // following test.
  const ended = await routePlayback(page, { onMedia: async () => true });
  await page.goto(`${ORIGIN}/test/player.html`);

  const video = page.locator('.player video');
  await expect(video).toBeVisible();
  await expect(page.locator('.startup')).toHaveCount(1);
  await video.evaluate((element) => window.releaseFixtureLoadedData(element));

  await expect(page.locator('.startup')).toHaveCount(0);
  await expect(page.getByText('The connection was gone too long')).toHaveCount(0);
  expect(ended).toEqual([]);
});

test('TV remote plays HLS, pauses, seeks, flushes progress and closes through Back', async ({
  page,
}) => {
  let opening;
  const ended = await routePlayback(page, {
    releases: [session.release, alternate],
    onSession: (route) => {
      opening = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: session });
    },
  });
  await page.goto(`${ORIGIN}/test/player.html?resume=12&next=1`);

  const video = page.locator('.player video');
  await expect(video).toBeVisible();
  await expect(page.locator('.tv-transport')).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  // Desktop preview uses hls.js, while an LG uses its native engine. The platform remains explicit in either case.
  expect(opening).toMatchObject({ player: 'hls.js', platform: 'webos' });

  expect(await remoteKey(page, 'MediaTrackNext', 176)).toBe(true);
  await expect(page.getByTestId('player-next-count')).toHaveText('1');

  // TV engines commonly expose only a numeric remote code and the key name "Unidentified".
  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await expect(page.getByRole('button', { name: /^Resume from / })).toHaveCount(0);
  await expect
    .poll(async () => {
      const value = await page.getByTestId('player-progress').textContent();
      return JSON.parse(value ?? '{}').seconds ?? 0;
    })
    .toBeGreaterThan(0);

  const beforeSeek = await video.evaluate((element) => element.currentTime);
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(beforeSeek + 8);

  expect(await remoteKey(page, 'Unidentified', 415)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);

  const transport = page.locator('.tv-transport button');
  await transport.last().focus();
  await expect(page.locator('.tv-transport')).toHaveAttribute('inert', '', { timeout: 10_000 });

  // The LG Magic Remote reveals controls by aiming, without requiring a click on an invisible target.
  await page.mouse.move(320, 240);
  await expect(page.locator('.tv-transport')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.tv-transport')).toHaveAttribute('inert', '', { timeout: 10_000 });

  // The first Select only reveals controls; it must not activate the Close button focused before idle hiding.
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  await expect(page.locator('.tv-transport')).not.toHaveAttribute('inert', '');
  await expect(video).toHaveCount(1);
  const playPause = page.locator('.tv-play-pause');
  await expect(playPause).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  // Freeze the idle clock while checking deterministic focus traversal.
  await transport.first().focus();
  await expect(transport.first()).toBeFocused();
  await expect(transport.first()).toHaveCSS('outline-style', 'none');
  await expect(transport.first()).toHaveCSS('box-shadow', 'none');
  await expect(transport.first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await remoteKey(page, 'ArrowUp', 38)).toBe(true);
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  await expect(timeline).toBeFocused();
  const beforeTimelineSeek = await video.evaluate((element) => element.currentTime);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(beforeTimelineSeek + 8);
  await transport.first().focus();
  expect(await remoteKey(page, 'ArrowRight', 39)).toBe(true);
  await expect(transport.nth(1)).toBeFocused();

  // The transport and AVKit-style actions are one horizontal remote sequence, even though they are laid out as
  // separate visual rows. Optional actions may disappear, so the boundary follows the first one actually shown.
  await transport.last().focus();
  expect(await remoteKey(page, 'ArrowRight', 39)).toBe(true);
  const firstPlayerAction = page.getByRole('button', { name: /^Audio track:/ });
  await expect(firstPlayerAction).toBeFocused();
  expect(await remoteKey(page, 'ArrowLeft', 37)).toBe(true);
  await expect(transport.last()).toBeFocused();

  // Down enters the metadata controls; horizontal presses can then reach every source/track picker.
  await transport.nth(1).focus();
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('footer') !== null))
    .toBe(true);
  const audioPicker = page.getByRole('button', { name: /^Audio track:/ });
  const subtitlePicker = page.getByRole('button', { name: /^Subtitles:/ });
  // Down lands on Audio, matching AVKit's custom-action order; one horizontal move reaches Subtitles.
  await expect(audioPicker).toBeVisible();
  await expect(subtitlePicker).toBeVisible();
  expect(await remoteKey(page, 'ArrowRight', 39)).toBe(true);
  await expect(subtitlePicker).toBeFocused();
  await expect(subtitlePicker).toHaveCSS('outline-style', 'none');
  await expect(subtitlePicker).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(subtitlePicker).toHaveCSS('color', 'rgb(0, 0, 0)');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: /^Subtitles:/ })).toBeVisible();
  // Escape and hardware Back each cancel track-picker editing without closing playback.
  expect(await remoteKey(page, 'Escape', 27)).toBe(true);
  await expect(video).toHaveCount(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('0');
  await expect(page.getByRole('menu', { name: /^Subtitles:/ })).toHaveCount(0);
  await expect(subtitlePicker).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: /^Subtitles:/ })).toBeVisible();
  expect(await remoteKey(page, 'Unidentified', 10009)).toBe(true);
  await expect(video).toHaveCount(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('0');
  await expect(page.getByRole('menu', { name: /^Subtitles:/ })).toHaveCount(0);
  await expect(subtitlePicker).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: /^Subtitles:/ })).toBeVisible();
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(subtitlePicker).toHaveAccessibleName('Subtitles: English');

  // Down past AVKit-style custom actions opens playback details; Back dismisses that panel before the player.
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  await expect(page.getByRole('region', { name: 'Playback details' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Movie details' })).toBeFocused();
  expect(await remoteKey(page, 'ArrowUp', 38)).toBe(true);
  await expect(page.getByRole('region', { name: 'Playback details' })).toHaveCount(0);
  await expect(subtitlePicker).toBeFocused();
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  await expect(page.getByRole('link', { name: 'Movie details' })).toBeFocused();
  expect(await remoteKey(page, 'Back', 461)).toBe(true);
  await expect(page.getByRole('region', { name: 'Playback details' })).toHaveCount(0);
  await expect(video).toHaveCount(1);

  expect(await remoteKey(page, 'Unidentified', 415)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await expect(page.locator('.tv-transport')).toHaveAttribute('inert', '', { timeout: 10_000 });
  expect(await remoteKeyBurst(page, 'Back', 461, 2)).toEqual([true, true]);
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  await expect.poll(() => ended.length).toBe(1);

  // A closed decoder/session does not poison the next player mount.
  await page.reload();
  await expect
    .poll(() => page.locator('.player video').evaluate((element) => element.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
});

test('TV Skip Intro remains actionable after the ordinary transport hides', async ({ page }) => {
  await routePlayback(page, {
    skipSegments: {
      intro: { start_ms: 0, end_ms: 55_000, confidence: 0.9 },
    },
  });
  await page.goto(`${ORIGIN}/test/player.html?resume=12`);

  const video = page.locator('.player video');
  const skip = page.getByRole('button', { name: 'Skip Intro' });
  await expect(skip).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tv-transport')).toHaveAttribute('inert', '', { timeout: 10_000 });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThanOrEqual(54.5);
  await expect(skip).toHaveCount(0);
});

test('TV Back closes cleanly while a playback session is still loading', async ({ page }) => {
  let requested = false;
  let answer;
  const held = new Promise((resolve) => (answer = resolve));
  await routePlayback(page, {
    onSession: async (route) => {
      requested = true;
      await held;
      await route.fulfill({ status: 201, json: session }).catch(() => undefined);
    },
  });
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect(page.locator('.player')).toBeVisible();
  await expect.poll(() => requested).toBe(true);

  // The remote module is lazy. The first handled Back both proves it loaded and closes the pending player.
  await expect.poll(() => remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(page.locator('.player')).toHaveCount(0);
  answer();
  await page.waitForTimeout(100);
  await expect(page.locator('.player')).toHaveCount(0);
});

test('TV remote retries a refused session and reaches real HLS playback', async ({ page }) => {
  let attempts = 0;
  await routePlayback(page, {
    onSession: (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } })
        : route.fulfill({ status: 201, json: session });
    },
  });
  await page.goto(`${ORIGIN}/test/player.html`);
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  // With no picture controls yet, Down enters at Close and continues spatially to the recovery action.
  await remoteKey(page, 'ArrowDown', 40);
  await remoteKey(page, 'ArrowDown', 40);
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.locator('.player video').evaluate((video) => video.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
  expect(attempts).toBe(2);
});

test('TV visibility suspension flushes progress and releases its session', async ({ page }) => {
  const ended = await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(6);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  await expect.poll(() => ended.length).toBe(1);
  await expect
    .poll(
      async () =>
        JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}').seconds ?? 0,
    )
    .toBeGreaterThan(0);
});

test('TV resumes real HLS in a fresh session after the playing session disappears', async ({
  page,
  browserName,
}) => {
  test.setTimeout(browserName === 'webkit' ? 120_000 : 60_000);
  const starts = [];
  let sessions = 0;
  let failedSegments = 0;
  let faultSession = 0;
  const native =
    browserName === 'webkit' ? await nativeMediaServer(() => faultSession === 1) : null;
  const ended = await routePlayback(page, {
    onSession: async (route) => {
      starts.push(JSON.parse(route.request().postData() ?? '{}'));
      sessions += 1;
      await route.fulfill({
        status: 201,
        json: {
          ...session,
          sid: `tv${sessions}`,
          playlist:
            native && sessions === 1 ? native.playlist : `/direct/s/tv${sessions}/sig/master.m3u8`,
        },
      });
    },
    onMedia: async (route, { file }) => {
      if (!file?.match(/^seg[0-9]+\.m4s$/)) return false;
      if (sessions !== faultSession) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return false;
      }
      failedSegments += 1;
      await route.fulfill({ status: 410, json: { error: 'session_gone' } });
      return true;
    },
  });
  await page.goto(`${ORIGIN}/test/player.html?resume=12`);

  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  if (browserName === 'webkit') {
    faultSession = 1;
    await expect.poll(native.gone).toBeGreaterThan(0);
    const resume = page.getByRole('button', { name: /^Resume from / });
    await expect(resume).toBeVisible({ timeout: 80_000 });
    await resume.click();
    await expect.poll(() => sessions).toBe(2);
    expect(starts[1].startAt).toBeGreaterThan(12);
    expect(starts[1].startAt).toBeLessThan(30);
    await expect.poll(native.ends).toBe(1);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(starts[1].startAt);
    expect(await remoteKey(page, 'Back', 461)).toBe(true);
    await expect(video).toHaveCount(0);
    await expect.poll(() => ended.length).toBe(1);
    await new Promise((resolve) => native.server.close(resolve));
    return;
  }
  await video.evaluate(
    (element) =>
      new Promise((resolve) => {
        element.addEventListener('seeked', resolve, { once: true });
        element.currentTime = 7;
      }),
  );
  faultSession = 1;
  await expect.poll(() => failedSegments).toBeGreaterThan(0);
  const resume = page.getByRole('button', { name: /^Resume from / });
  await expect(resume).toBeVisible({ timeout: 30_000 });
  await expect(resume).not.toHaveText('Resume from 0:00');
  expect(failedSegments).toBeGreaterThan(0);

  await resume.click();
  await expect.poll(() => sessions).toBe(2);
  expect(starts[1].startAt).toBeGreaterThan(6);
  expect(starts[1].startAt).toBeLessThan(10);
  await expect.poll(() => ended.length).toBe(1);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(starts[1].startAt);

  await video.evaluate(
    (element) =>
      new Promise((resolve) => {
        element.addEventListener('seeked', resolve, { once: true });
        element.currentTime = 0;
      }),
  );
  const firstFaultCount = failedSegments;
  faultSession = 2;
  await expect.poll(() => failedSegments).toBeGreaterThan(firstFaultCount);
  const fromStart = page.getByRole('button', { name: 'Resume from 0:00' });
  await expect(fromStart).toBeVisible({ timeout: 30_000 });
  await fromStart.click();
  await expect.poll(() => sessions).toBe(3);
  expect(starts[2].startAt).toBeUndefined();
  await expect.poll(() => ended.length).toBe(2);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test('TV cancels a native expiry probe when playback closes', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'native HLS lifecycle control');
  // Playwright's Linux WebKit has no native HLS decoder and correctly takes Den's hls.js path. Exercise this
  // native-only lifecycle where the engine really provides it (macOS WebKit), instead of making canPlayType lie and
  // claiming a decoder integration that CI cannot run.
  const nativeHls = await page.evaluate(
    () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '',
  );
  test.skip(!nativeHls, 'this WebKit build has no native HLS decoder');
  test.setTimeout(60_000);
  const native = await nativeMediaServer(() => false, { holdProbeMaster: true });
  await routePlayback(page, {
    onSession: (route) =>
      route.fulfill({ status: 201, json: { ...session, playlist: native.playlist } }),
  });
  // Observe the signal passed to the real probe fetch. A WebKit fetch abort does not guarantee that its pooled
  // HTTP socket closes, so the browser's abort signal is the deterministic contract—not Node's connection event.
  await page.addInitScript((playlist) => {
    const nativeFetch = window.fetch.bind(window);
    window.__nativeProbeStarts = 0;
    window.__nativeProbeAborts = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === playlist && init?.signal) {
        window.__nativeProbeStarts += 1;
        init.signal.addEventListener(
          'abort',
          () => {
            window.__nativeProbeAborts += 1;
          },
          { once: true },
        );
      }
      return nativeFetch(input, init);
    };
  }, native.playlist);
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  // Wait for Player's first-frame proof by offering `waiting` on successive browser tasks. currentTime alone is not
  // that proof on a loaded CI runner. The first accepted stall and hardware Back still happen in one task, so a real
  // `playing` event cannot cancel the synthetic stall between two Playwright round trips.
  const closed = await video.evaluate(async (element) => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      element.dispatchEvent(new Event('waiting'));
      if (window.__nativeProbeStarts) {
        const started = window.__nativeProbeStarts;
        const beforeBack = window.__nativeProbeAborts;
        const event = new KeyboardEvent('keydown', {
          key: 'Back',
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'keyCode', { value: 461 });
        (document.activeElement ?? document.body).dispatchEvent(event);
        return { started, beforeBack, prevented: event.defaultPrevented };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { started: 0, beforeBack: window.__nativeProbeAborts, prevented: false };
  });
  expect(closed).toEqual({ started: 1, beforeBack: 0, prevented: true });
  await expect(video).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__nativeProbeAborts)).toBe(1);
  await expect(page.getByRole('button', { name: /^Resume from / })).toHaveCount(0);
});

test('TV repeatedly suspends and reopens without leaking playback sessions', async ({ page }) => {
  let sessions = 0;
  const ended = await routePlayback(page, {
    onSession: async (route) => {
      sessions += 1;
      await route.fulfill({
        status: 201,
        json: {
          ...session,
          sid: `cycle${sessions}`,
          playlist: `/direct/s/cycle${sessions}/sig/master.m3u8`,
        },
      });
    },
  });

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await page.goto(`${ORIGIN}/test/player.html`);
    const video = page.locator('.player video');
    await expect
      .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(video).toHaveCount(0);
    await expect(page.getByTestId('player-close-count')).toHaveText('1');
    await expect.poll(() => ended.length).toBe(cycle);
  }

  expect(sessions).toBe(3);
  expect(new Set(ended)).toEqual(
    new Set(['/direct/s/cycle1/sig/end', '/direct/s/cycle2/sig/end', '/direct/s/cycle3/sig/end']),
  );
});

test('@soak TV plays a discontinuous real-media fixture for ten minutes at wall-clock speed', async ({
  browser,
  browserName,
  page,
}, testInfo) => {
  test.skip(!process.env.DEN_TV_PLAYBACK_SOAK, 'set DEN_TV_PLAYBACK_SOAK=1 for the real-time soak');
  const configured = process.env.DEN_TV_PLAYBACK_SOAK_MINUTES;
  const minutes = configured === undefined ? 10 : Number(configured);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60)
    throw new Error('DEN_TV_PLAYBACK_SOAK_MINUTES must be a finite number from 1 through 60');
  test.setTimeout((minutes * 60 + 90) * 1_000);
  const playlist = await repeatedMediaPlaylist(minutes);
  let sessions = 0;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const startedAt = Date.now();
  const ended = await routePlayback(page, {
    onSession: async (route) => {
      sessions += 1;
      await route.fulfill({
        status: 201,
        json: { ...session, duration: minutes * 60, playlist: '/direct/s/soak/sig/master.m3u8' },
      });
    },
    onMedia: async (route, { file }) => {
      if (file === 'media.m3u8') {
        await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: playlist });
        return true;
      }
      if (file?.match(/^seg[0-9]+\.m4s$/)) {
        const url = new URL(route.request().url());
        const segment = Number(file.match(/[0-9]+/)?.[0] ?? 0);
        const cycle = Number(url.searchParams.get('cycle') ?? 0);
        await new Promise((resolve) => setTimeout(resolve, (cycle * 7 + segment * 13) % 41));
      }
      return false;
    },
  });
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  const target = minutes * 60;
  // Persisted progress is floored to whole seconds. Cross the next whole second before Back so the
  // subsequent saved-position assertion cannot race a valid 60.1s media clock being reported as 60s.
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), {
      timeout: (minutes * 60 + 60) * 1_000,
      intervals: [5_000],
    })
    .toBeGreaterThanOrEqual(target + 1);
  expect(sessions).toBe(1);
  expect(await remoteKey(page, 'Back', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  await expect.poll(() => ended.length).toBe(1);
  await expect
    .poll(
      async () =>
        JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}').seconds ?? 0,
    )
    .toBeGreaterThan(target);
  const summary = {
    engine: browserName,
    engineVersion: browser.version(),
    port: E2E_PORT,
    requestedMinutes: minutes,
    realElapsedMs: Date.now() - startedAt,
    mediaTime: await page
      .getByTestId('player-progress')
      .evaluate((element) => JSON.parse(element.textContent ?? '{}').seconds ?? 0),
    sessionCount: sessions,
    endCount: ended.length,
    unexpectedPageErrors: pageErrors,
  };
  const summaryPath = testInfo.outputPath('playback-soak-summary.json');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await testInfo.attach('playback-soak-summary', {
    path: summaryPath,
    contentType: 'application/json',
  });
  expect(pageErrors).toEqual([]);
});
