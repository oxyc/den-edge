// A segment scan den-edge starts for the episode playing reaches that play (#1201): the first /skipdb answer is a
// miss while the scan runs, the player asks again on the Apple TV's schedule (`refreshSkipSegmentsAfterScan`: ~45 s
// after the first answer), and the detected intro then counts down and skips as any other. The page's clock is
// fast-forwarded past the 45 s rather than waited out; every other wait is on player or network state.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'scan1',
  playlist: '/direct/s/scan1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};
/** What den-edge answers once the scan is in: remux's intro, in SkipDB's shape. */
const detected = {
  segments: { intro: { start_ms: 0, end_ms: 40_000, match: 'detected', confidence: 0.9 } },
};
/** den-edge's miss while a scan may still land: no `x-den-skipdb`, kept 30 s. */
const pending = (route) =>
  route.fulfill({
    status: 404,
    headers: { 'cache-control': 'public, max-age=30' },
    json: { error: 'not_found' },
  });

/** `onSkip(route, n)` answers the n-th /skipdb request (from 0); `asked` lists their paths in order. */
async function mockPlayer(page, onSkip) {
  const asked = [];
  await guardNetwork(page);
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith('/external_ids')
        ? { imdb_id: 'tt42' }
        : path.includes('/season/')
          ? { episodes: [{ episode_number: 1, name: 'Episode one', runtime: 1 }] }
          : { id: 42, name: 'The Series', first_air_date: '2001-01-01', runtime: 1, genres: [] },
    });
  });
  await page.route(`${ORIGIN}/skipdb/**`, (route) => {
    const n = asked.push(new URL(route.request().url()).pathname) - 1;
    return onSkip(route, n);
  });
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/session`, (route) =>
    route.fulfill({ status: 201, json: session }),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
  await page.route(`${ORIGIN}/direct/s/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' || request.method() === 'POST')
      return route.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return route.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  return asked;
}

const position = (page) => page.locator('.player video').evaluate((video) => video.currentTime);

/** At least one more second of playback, so the player's ticks have seen whatever came before this. */
async function playOn(page) {
  const from = await position(page);
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThan(from + 1);
}

test('a scan pending at the first ask counts down and skips once a later ask finds it', async ({
  page,
}) => {
  await page.clock.install();
  const asked = await mockPlayer(page, (route, n) =>
    n === 0 ? pending(route) : route.fulfill({ json: detected }),
  );
  await page.goto(`${ORIGIN}/test/player.html?series&replaceEpisode&autoSkip`);

  const skip = page.getByRole('button', { name: 'Skip Intro', exact: true });
  const countdown = page.locator('.auto-skip-in');
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1);
  await playOn(page);
  expect(asked).toHaveLength(1);
  await expect(skip).toHaveCount(0);

  await page.clock.fastForward(46_000);
  await expect.poll(() => asked.length, { timeout: 20_000 }).toBe(2);
  expect(asked).toEqual(['/skipdb/tt42/1/1', '/skipdb/tt42/1/1']);
  // The #1208 grace: an 8 s visible countdown, then the skip itself.
  await expect(countdown).toHaveText(/^Auto-skip in [1-8]s$/, { timeout: 20_000 });
  await expect(skip).toBeVisible();
  expect(await position(page)).toBeLessThan(40);
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(39.5);
  expect(asked).toHaveLength(2);
});

test('replacing the episode starts its re-asks over: the old schedule asks nothing', async ({
  page,
}) => {
  await page.clock.install();
  let answerSecond;
  const second = new Promise((resolve) => (answerSecond = resolve));
  const asked = await mockPlayer(page, async (route, n) => {
    if (n === 1) await second;
    return pending(route).catch(() => undefined);
  });
  await page.goto(`${ORIGIN}/test/player.html?series&replaceEpisode&autoSkip`);
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1);
  await playOn(page);

  await page.getByTestId('replace-player-episode').evaluate((button) => button.click());
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(2);
  expect(asked[1]).toBe('/skipdb/tt42/2/1');
  await playOn(page);

  // Past the outgoing episode's 45 s while the new one's first answer is still out: nothing is asked.
  await page.clock.fastForward(46_000);
  await playOn(page);
  expect(asked).toHaveLength(2);

  // Its own first answer starts its own schedule, which asks for it alone.
  answerSecond();
  await playOn(page);
  expect(asked).toHaveLength(2);
  await page.clock.fastForward(46_000);
  await expect.poll(() => asked.length, { timeout: 20_000 }).toBe(3);
  expect(asked[2]).toBe('/skipdb/tt42/2/1');
});

test('a settled miss is not asked again', async ({ page }) => {
  await page.clock.install();
  const asked = await mockPlayer(page, (route) =>
    route.fulfill({
      status: 404,
      headers: { 'cache-control': 'public, max-age=30', 'x-den-skipdb': 'none' },
      json: { error: 'not_found' },
    }),
  );
  await page.goto(`${ORIGIN}/test/player.html?series&replaceEpisode&autoSkip`);
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1);
  await playOn(page);
  await page.clock.fastForward(46_000);
  await playOn(page);
  await page.clock.fastForward(120_000);
  await playOn(page);
  expect(asked).toHaveLength(1);
});
