import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';

const API = 'https://den-tv-api.example.invalid';
const SERVICE = 'https://den-tv-service.example.invalid';
const media = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'packaged-tv1',
  playlist: '/direct/s/packaged-tv1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Packaged TV fixture', filename: 'packaged-tv.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};

const cors = {
  'access-control-allow-origin': E2E_ORIGIN,
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};

async function routePackagedPlayback(page, { holdPlayback = false } = {}) {
  const requests = [];
  const misrouted = [];
  const ended = [];
  let releasePlayback = () => {};
  const playbackGate = holdPlayback
    ? new Promise((resolve) => (releasePlayback = resolve))
    : Promise.resolve();
  const handle = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${url.origin} ${request.method()} ${url.pathname}`);
    const servicePath =
      /^\/(?:capabilities|scout|tmdb|metadata|den|ratings|warnings|skipdb|subs|subtitles|atlas|reel|remux|direct)(?:\/|$)/.test(
        url.pathname,
      );
    const devicePath =
      /^\/(?:pair|inbox|lib|recovery|config|health|routes|grant|oauth|playback|sync|mcp|link|version)(?:\/|$)/.test(
        url.pathname,
      );
    if ((url.origin === API && servicePath) || (url.origin === SERVICE && devicePath))
      misrouted.push(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (/^\/tmdb\/3\/movie\/42\/external_ids$/.test(url.pathname))
      return route.fulfill({ headers: cors, json: { imdb_id: 'tt42' } });
    if (url.pathname === '/config') return route.fulfill({ headers: cors, json: {} });
    if (url.pathname.startsWith('/skipdb/'))
      return route.fulfill({ status: 404, headers: cors, json: {} });
    if (url.pathname === '/direct/session')
      return route.fulfill({ status: 201, headers: cors, json: session });
    if (url.pathname === '/direct/releases')
      return route.fulfill({ headers: cors, json: { releases: [] } });
    if (url.pathname === '/den/config/playback') {
      await playbackGate;
      return route.fulfill({
        headers: cors,
        json: { url: session.playlist, release: session.release },
      });
    }
    if (url.pathname === '/reel/transport') {
      const body = request.postDataJSON();
      return route.fulfill({
        headers: cors,
        json: {
          v: 2,
          capability: body.capability,
          ipv4HintWanted: false,
          attempts: [{ type: 'relay', url: `/reel/${body.capability}` }],
        },
      });
    }
    if (url.pathname.endsWith('/end') || request.method() === 'DELETE') {
      ended.push(url.pathname);
      return route.fulfill({ status: 204, headers: cors });
    }
    if (request.method() === 'POST') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname.startsWith('/direct/s/')) {
      const file = url.pathname.endsWith('/master.m3u8')
        ? 'media.m3u8'
        : url.pathname.split('/').pop();
      return route.fulfill({
        headers: cors,
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, media)),
      });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: 'not_found' } });
  };
  await page.route(`${API}/**`, handle);
  await page.route(`${SERVICE}/**`, handle);
  return { ended, misrouted, requests, releasePlayback };
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

test('Tizen 3 skips unsupported receipt work and offers its focusable linking recovery', async ({
  page,
}) => {
  test.skip(
    process.env.DEN_TIZEN_VERSION !== '3.0',
    'only the Tizen 3 package lacks managed-playback receipt crypto',
  );
  const receiptRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/test/receipt-ready'))
      receiptRequests.push(request.url());
  });
  const { misrouted, releasePlayback } = await routePackagedPlayback(page, {
    holdPlayback: true,
  });
  await page.goto('/package/test/player.html?playback=managed&receiptBoundary=1');

  await expect(
    page.getByText(
      'This TV cannot recover managed-playback progress after the page closes. Keep Den open, or link a phone or computer in Settings › Connections.',
      { exact: true },
    ),
  ).toBeVisible();
  const recovery = page.getByRole('button', { name: 'Connections' });
  await expect(recovery).toBeVisible();
  // The managed-playback request is still held: only real remote direction keys may move off the empty stage.
  await expect
    .poll(async () => {
      await remoteKey(page, 'ArrowDown', 40);
      return recovery.evaluate((element) => element === document.activeElement);
    })
    .toBe(true);
  // Native Enter activation supplies the browser's button click after the player's capture handler leaves the
  // focused action alone; a synthetic dispatchEvent has no default activation behaviour.
  await page.keyboard.press('Enter');
  releasePlayback();
  await expect(page.getByTestId('receipt-settings-count')).toHaveText('1');
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  expect(receiptRequests).toEqual([]);
  expect(misrouted).toEqual([]);
});

test('packaged Tizen plays cross-origin HLS, resumes and ends through the service origin', async ({
  page,
}) => {
  test.skip(
    process.env.DEN_TIZEN_VERSION === '3.0',
    'the Tizen 3 viewer intentionally ships no HLS/MSE path',
  );
  const escapedDenRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/package/') === false &&
      url.origin !== API &&
      url.origin !== SERVICE &&
      /\/(?:tmdb|config|skipdb|direct|playback|remux)(?:\/|$)/.test(url.pathname)
    )
      escapedDenRequests.push(request.url());
  });
  const { ended, misrouted, requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?resume=12');
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  const resumedAt = await video.evaluate((element) => element.currentTime);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(resumedAt + 0.5);

  expect(requests).toContain(`${SERVICE} POST /direct/session`);
  expect(requests).toContain(`${SERVICE} GET /direct/s/packaged-tv1/sig/master.m3u8`);
  expect(
    requests.some(
      (request) =>
        request.startsWith(`${SERVICE} GET /direct/s/packaged-tv1/sig/`) &&
        /\.(?:mp4|m4s)$/.test(request),
    ),
  ).toBe(true);
  expect(escapedDenRequests).toEqual([]);
  expect(misrouted).toEqual([]);

  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect.poll(() => ended.length).toBe(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
});

test('packaged managed playback routes its relative media capability through the service origin', async ({
  page,
}) => {
  test.skip(
    process.env.DEN_TIZEN_VERSION === '3.0',
    'the Tizen 3 viewer intentionally ships no HLS/MSE path',
  );
  const misrouted = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== SERVICE && /^\/(?:den|direct)(?:\/|$)/.test(url.pathname))
      misrouted.push(request.url());
  });
  const { misrouted: classifiedElsewhere, requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?playback=managed&resume=12');
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  const resumedAt = await video.evaluate((element) => element.currentTime);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(resumedAt + 0.5);

  expect(requests).toContain(`${SERVICE} POST /den/config/playback`);
  expect(requests).toContain(`${SERVICE} GET /direct/s/packaged-tv1/sig/master.m3u8`);
  expect(misrouted).toEqual([]);
  expect(classifiedElsewhere).toEqual([]);
  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
});

test('packaged Reel publishes its relative relay capability on the service origin', async ({
  page,
}) => {
  const misrouted = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== SERVICE && /^\/reel(?:\/|$)/.test(url.pathname))
      misrouted.push(request.url());
  });
  const { misrouted: classifiedElsewhere, requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?reel=1');

  const capability = `m/s/${'a'.repeat(40)}?s=${'b'.repeat(24)}`;
  await expect(page.getByTestId('reel-media-url')).toHaveText(`${SERVICE}/reel/${capability}`);
  expect(requests).toContain(`${SERVICE} POST /reel/transport`);
  expect(misrouted).toEqual([]);
  expect(classifiedElsewhere).toEqual([]);
});
