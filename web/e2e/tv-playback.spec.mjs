import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';

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

async function routePlayback(page, { onSession, releases = [] } = {}) {
  const ended = [];
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
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
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
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

test('TV remote plays HLS, pauses, seeks, flushes progress and closes through Back', async ({
  page,
}) => {
  const ended = await routePlayback(page, { releases: [session.release, alternate] });
  await page.goto(`${ORIGIN}/test/player.html?resume=12&next=1`);

  const video = page.locator('.player video');
  await expect(video).toBeVisible();
  await expect(page.locator('.tv-transport')).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(12);

  expect(await remoteKey(page, 'MediaTrackNext', 176)).toBe(true);
  await expect(page.getByTestId('player-next-count')).toHaveText('1');

  // TV engines commonly expose only a numeric remote code and the key name "Unidentified".
  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
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
  await expect(page.locator('.player')).toHaveClass(/tv-controls-hidden/, { timeout: 5_000 });
  await expect(page.locator('.tv-transport')).toHaveAttribute('inert', '');

  // The first Select only reveals controls; it must not activate the Close button focused before idle hiding.
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  await expect(page.locator('.player')).not.toHaveClass(/tv-controls-hidden/);
  await expect(video).toHaveCount(1);

  // Freeze the idle clock while checking deterministic focus traversal.
  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await transport.first().focus();
  await expect(transport.first()).toBeFocused();
  expect(await remoteKey(page, 'ArrowRight', 39)).toBe(true);
  await expect(transport.nth(1)).toBeFocused();

  // Down enters the metadata controls; horizontal presses can then reach every source/track picker.
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('footer') !== null))
    .toBe(true);
  const footerSelects = page.locator('footer select');
  await expect(footerSelects).toHaveCount(3);
  for (let n = 0; n < 2; n += 1) expect(await remoteKey(page, 'ArrowRight', 39)).toBe(true);
  await expect(footerSelects.last()).toBeFocused();
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  // Escape and hardware Back each cancel track-picker editing without closing playback.
  expect(await remoteKey(page, 'Escape', 27)).toBe(true);
  await expect(video).toHaveCount(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('0');
  await expect(footerSelects.last()).toBeFocused();
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  expect(await remoteKey(page, 'Unidentified', 10009)).toBe(true);
  await expect(video).toHaveCount(1);
  await expect(page.getByTestId('player-close-count')).toHaveText('0');
  await expect(footerSelects.last()).toBeFocused();
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  expect(await remoteKey(page, 'ArrowDown', 40)).toBe(true);
  expect(await remoteKey(page, 'Enter', 13)).toBe(true);
  await expect(footerSelects.last()).toHaveValue('en');

  expect(await remoteKey(page, 'Unidentified', 415)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await expect(page.locator('.player')).toHaveClass(/tv-controls-hidden/, { timeout: 5_000 });
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
    .toBeGreaterThan(1);

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
