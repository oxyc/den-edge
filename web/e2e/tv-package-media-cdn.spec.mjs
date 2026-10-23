import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';

const API = 'https://den-tv-api.example.invalid';
const MEDIA = 'https://den-tv-media.example.invalid';
const media = new URL('./media/hls/', import.meta.url);
const cors = {
  'access-control-allow-origin': E2E_ORIGIN,
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};

test.skip(
  process.env.DEN_TIZEN_VERSION === '3.0',
  'the Tizen 3 viewer intentionally ships no HLS/MSE path',
);

test('packaged HLS can use a distinct media CDN without leaking library headers', async ({
  page,
}) => {
  const mediaRequests = [];
  const mediaControlRequests = [];
  const apiRequests = [];
  const ended = [];
  const violations = [];
  const pageErrors = [];
  await page.addInitScript(() => {
    globalThis.__tvCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__tvCspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  page.on('request', (request) => {
    if (request.url().startsWith(`${MEDIA}/`))
      mediaRequests.push({ url: request.url(), headers: request.headers() });
    if (request.url().startsWith(`${API}/`))
      apiRequests.push({ url: request.url(), headers: request.headers() });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path === '/tmdb/3/movie/42/external_ids')
      return route.fulfill({ headers: cors, json: { imdb_id: 'tt42' } });
    if (path === '/config') return route.fulfill({ headers: cors, json: {} });
    if (path.startsWith('/skipdb/')) return route.fulfill({ status: 404, headers: cors, json: {} });
    if (path.startsWith('/den/config/subtitles/'))
      return route.fulfill({ headers: cors, json: { subtitles: [] } });
    if (path === '/den/~deadbeef/playback')
      return route.fulfill({
        status: 201,
        headers: cors,
        json: {
          url: `${MEDIA}/hls/master.m3u8`,
          release: { label: 'Distinct CDN fixture', filename: 'cdn.mkv', size: 1 },
          session: {
            id: 'packaged-cdn',
            playlist: `${MEDIA}/hls/master.m3u8`,
            duration: 60,
            audioTrack: 0,
            audioTracks: [],
            endUrl: `${API}/den/~deadbeef/playback`,
            heartbeatUrl: `${API}/den/~deadbeef/playback/heartbeat`,
            reportUrl: `${API}/den/~deadbeef/playback/report`,
          },
        },
      });
    if (path.endsWith('/end') || request.method() === 'DELETE') {
      ended.push(path);
      return route.fulfill({ status: 204, headers: cors });
    }
    if (path.startsWith('/playback/')) return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  await page.route(`${MEDIA}/**`, async (route) => {
    if (route.request().method() !== 'GET') {
      mediaControlRequests.push({ url: route.request().url(), method: route.request().method() });
      return route.fulfill({ status: 204, headers: cors });
    }
    const path = new URL(route.request().url()).pathname;
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return route.fulfill({
      headers: cors,
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, media)),
    });
  });
  await page.goto(
    '/package/test/player.html?playback=%2Fden%2F~deadbeef%2Fplayback&scout=%2Fden%2F~deadbeef&grant=deadbeef%3Afixture-secret&resume=12',
  );
  const video = page.locator('.player video');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);
  const resumedAt = await video.evaluate((element) => element.currentTime);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(resumedAt + 0.5);
  await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Unidentified',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'keyCode', { value: 461 });
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await expect(video).toHaveCount(0);
  await expect.poll(() => ended.length).toBe(1);
  expect(ended).toEqual(['/den/~deadbeef/playback/end']);
  violations.push(...(await page.evaluate(() => globalThis.__tvCspViolations)));
  expect(mediaRequests.some(({ url }) => url.endsWith('/hls/master.m3u8'))).toBe(true);
  expect(mediaRequests.some(({ url }) => url.endsWith('/hls/init.mp4'))).toBe(true);
  expect(mediaRequests.some(({ url }) => /\/hls\/seg\d+\.m4s$/.test(url))).toBe(true);
  expect(mediaControlRequests).toEqual([]);
  expect(
    apiRequests.find(({ url }) => url.endsWith('/den/~deadbeef/playback'))?.headers['x-den-grant'],
  ).toBe('deadbeef:fixture-secret');
  expect(
    mediaRequests.every(
      ({ headers }) =>
        !Object.keys(headers).some((name) => /^x-den-/.test(name) || name === 'authorization'),
    ),
  ).toBe(true);
  expect(violations).toEqual([]);
  expect(pageErrors).toEqual([]);
});
