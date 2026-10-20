import { expect, test } from '@playwright/test';
import { AVPLAY_FIXTURE_SCRIPT, callsNamed, chooseSubtitle, remoteKey } from './avplay-fixture.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const API = 'https://den-tv-api.example.invalid';
const cors = {
  'access-control-allow-origin': E2E_ORIGIN,
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};
const playbackSession = {
  sid: 'packaged-avplay-1',
  playlist: '/direct/s/packaged-avplay-1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Packaged AVPlay fixture', filename: 'packaged-avplay.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [
    { language: 'en', name: 'English', channels: 2 },
    { language: 'es', name: 'Spanish', channels: 2 },
  ],
  subtitles: [{ language: 'en', name: 'English' }],
};

async function routePackageAvplay(page) {
  const sdkRequests = [];
  const apiRequests = [];
  const ended = [];
  await page.route(
    (url) => url.pathname.endsWith('/$WEBAPIS/webapis/webapis.js'),
    (route) => {
      sdkRequests.push(route.request().url());
      return route.fulfill({ contentType: 'text/javascript', body: AVPLAY_FIXTURE_SCRIPT });
    },
  );
  await page.route(`${API}/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiRequests.push(`${request.method()} ${path}`);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path === '/tmdb/3/movie/42/external_ids')
      return route.fulfill({ headers: cors, json: { imdb_id: 'tt42' } });
    if (path === '/config') return route.fulfill({ headers: cors, json: {} });
    if (path.startsWith('/skipdb/')) return route.fulfill({ status: 404, headers: cors, json: {} });
    if (path === '/direct/session')
      return route.fulfill({ status: 201, headers: cors, json: playbackSession });
    if (path === '/direct/releases')
      return route.fulfill({ headers: cors, json: { releases: [playbackSession.release] } });
    if (request.method() === 'DELETE' || path.endsWith('/end')) {
      ended.push(path);
      return route.fulfill({ status: 204, headers: cors });
    }
    if (request.method() === 'POST') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 404, headers: cors, json: { error: 'not_found' } });
  });
  return { apiRequests, ended, sdkRequests };
}

test('packaged Tizen loads the Samsung bridge before the app and plays through AVPlay under CSP', async ({
  page,
}) => {
  const cspViolations = [];
  await page.addInitScript(() => {
    window.__avplayCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__avplayCspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
  });
  const routed = await routePackageAvplay(page);
  await page.goto('/package/test/player.html?resume=12');

  await expect.poll(() => routed.sdkRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.__avplayFixture.installedBeforeApp)).toBe(true);
  const video = page.locator('.player video');
  await expect(video).toHaveClass(/den-avplay-placeholder/);
  await expect(page.locator('object.den-avplay-plane[type="application/avplayer"]')).toHaveCount(1);
  await expect.poll(() => callsNamed(page, 'prepareAsync')).toHaveLength(1);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(12);
  expect((await callsNamed(page, 'open'))[0]?.[1]).toBe(
    `${API}/direct/s/packaged-avplay-1/sig/master.m3u8`,
  );
  expect(routed.apiRequests).toContain('POST /direct/session');

  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);
  expect(await remoteKey(page, 'Unidentified', 415)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await chooseSubtitle(page, 'English');
  await expect
    .poll(() => callsNamed(page, 'setSelectTrack'))
    .toContainEqual(['setSelectTrack', 'TEXT', 21, 'PLAYING']);

  cspViolations.push(...(await page.evaluate(() => window.__avplayCspViolations)));
  expect(cspViolations).toEqual([]);
  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(video).toHaveCount(0);
  await expect.poll(() => routed.ended).toHaveLength(1);
  await expect.poll(() => callsNamed(page, 'close')).toHaveLength(1);
});
