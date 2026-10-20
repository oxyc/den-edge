import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';

const API = 'https://den-tv-api.example.invalid';
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

async function routePackagedPlayback(page) {
  const requests = [];
  const ended = [];
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
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
    if (url.pathname === '/den/config/playback')
      return route.fulfill({
        headers: cors,
        json: { url: session.playlist, release: session.release },
      });
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
  });
  return { ended, requests };
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

test('packaged Tizen plays cross-origin HLS, resumes and ends only through the API origin', async ({
  page,
}) => {
  const packageApiRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/package/') === false &&
      url.origin !== API &&
      /\/(?:tmdb|config|skipdb|direct|playback|remux)(?:\/|$)/.test(url.pathname)
    )
      packageApiRequests.push(request.url());
  });
  const { ended, requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?resume=12');
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  const resumedAt = await video.evaluate((element) => element.currentTime);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(resumedAt + 0.5);

  expect(requests).toContain('POST /direct/session');
  expect(requests).toContain('GET /direct/s/packaged-tv1/sig/master.m3u8');
  expect(
    requests.some((request) =>
      /GET \/direct\/s\/packaged-tv1\/sig\/.+\.(?:mp4|m4s)$/.test(request),
    ),
  ).toBe(true);
  expect(packageApiRequests).toEqual([]);

  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect.poll(() => ended.length).toBe(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
});

test('packaged managed playback resolves a relative media capability against the API', async ({
  page,
}) => {
  const misrouted = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== API && /^\/(?:den|direct)(?:\/|$)/.test(url.pathname))
      misrouted.push(request.url());
  });
  const { requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?playback=managed&resume=12');
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  const resumedAt = await video.evaluate((element) => element.currentTime);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(resumedAt + 0.5);

  expect(requests).toContain('POST /den/config/playback');
  expect(requests).toContain('GET /direct/s/packaged-tv1/sig/master.m3u8');
  expect(misrouted).toEqual([]);
  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
});

test('packaged Reel publishes its relative relay capability on the API origin', async ({
  page,
}) => {
  const misrouted = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== API && /^\/reel(?:\/|$)/.test(url.pathname)) misrouted.push(request.url());
  });
  const { requests } = await routePackagedPlayback(page);
  await page.goto('/package/test/player.html?reel=1');

  const capability = `m/s/${'a'.repeat(40)}?s=${'b'.repeat(24)}`;
  await expect(page.getByTestId('reel-media-url')).toHaveText(`${API}/reel/${capability}`);
  expect(requests).toContain('POST /reel/transport');
  expect(misrouted).toEqual([]);
});
