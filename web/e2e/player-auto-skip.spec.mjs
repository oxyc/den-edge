// Auto-skip through the mounted production player: the Apple TV's contract (PlayerModel+Watchdog.swift
// `maybeAutoSkip`) — an 8 s visible countdown, Skip pressable throughout, playback interaction cancels, and the
// skip itself at the deadline. Every wait is on player state, never a fixed sleep.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'skip1',
  playlist: '/direct/s/skip1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};
/** The fixture video is 60 s; the intro is its first 40. */
const INTRO_END = 40;

async function mockPlayer(page, { confidence = 0.9, segments } = {}) {
  await guardNetwork(page);
  await routeTmdb(page, (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/external_ids')
        ? { imdb_id: 'tt42' }
        : { id: 42, title: 'The Movie', release_date: '2001-01-01', runtime: 1, genres: [] },
    }),
  );
  await page.route(`${ORIGIN}/skipdb/**`, (route) =>
    route.fulfill({
      json: {
        segments: segments ?? {
          intro: { start_ms: 0, end_ms: INTRO_END * 1000, match: 'exact', confidence },
        },
      },
    }),
  );
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
}

const position = (page) => page.locator('.player video').evaluate((video) => video.currentTime);
const seek = (page, to) =>
  page.locator('.player video').evaluate((video, at) => (video.currentTime = at), to);

test('counts down visibly, keeps Skip pressable and its name fixed, then skips at the deadline', async ({
  page,
}) => {
  // When the countdown first drew, and when the skip's seek began — to bound the grace length.
  await page.addInitScript(() => {
    const times = (window.autoSkipTimes = {});
    new MutationObserver(() => {
      times.shown ??= document.querySelector('.auto-skip-in') ? performance.now() : undefined;
    }).observe(document, { subtree: true, childList: true });
    document.addEventListener(
      'seeking',
      (event) => {
        if (event.target.currentTime >= 39) times.skipped ??= performance.now();
      },
      true,
    );
  });
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?autoSkip`);

  const skip = page.getByRole('button', { name: 'Skip Intro', exact: true });
  const countdown = page.locator('.auto-skip-in');
  await expect(countdown).toHaveText(/^Auto-skip in [1-8]s$/, { timeout: 30_000 });
  // The seconds are visible only: the button's accessible name stays "Skip Intro" throughout.
  await expect(skip).toBeVisible();
  await expect(countdown).toHaveAttribute('aria-hidden', 'true');
  // Said once, as it starts, with the grace length and how to refuse it.
  await expect(page.getByRole('status').filter({ hasText: 'Skips automatically' })).toHaveText(
    'Skips automatically in 8 seconds. Pause or seek to keep watching.',
  );
  expect(await position(page)).toBeLessThan(INTRO_END);

  await expect
    .poll(() => position(page), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(INTRO_END - 0.5);
  await expect(countdown).toHaveCount(0);
  await expect(skip).toHaveCount(0);
  const { shown, skipped } = await page.evaluate(() => window.autoSkipTimes);
  // Not before the 8 s deadline (less the countdown's own first paint), and not long after it.
  expect(skipped - shown).toBeGreaterThanOrEqual(7_500);
  expect(skipped - shown).toBeLessThan(12_000);

  // Scrubbing back into a segment already skipped offers the button again, never another countdown.
  await seek(page, 5);
  await expect(skip).toBeVisible();
  await expect.poll(() => position(page)).toBeGreaterThan(6);
  await expect(countdown).toHaveCount(0);
});

test('pausing cancels the countdown; the manual Skip still works afterwards', async ({ page }) => {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?autoSkip`);

  const skip = page.getByRole('button', { name: 'Skip Intro', exact: true });
  const countdown = page.locator('.auto-skip-in');
  await expect(countdown).toBeVisible({ timeout: 30_000 });

  await page.locator('.player').focus();
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('.player video').evaluate((v) => v.paused)).toBe(true);
  await expect(countdown).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Skips automatically' })).toHaveCount(0);
  await expect(skip).toBeVisible();

  // Playing on past where the deadline was: the cancelled kind is not counted down again.
  await page.keyboard.press('k');
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThan(10);
  expect(await position(page)).toBeLessThan(INTRO_END);
  await expect(countdown).toHaveCount(0);

  await skip.click();
  await expect.poll(() => position(page)).toBeGreaterThanOrEqual(INTRO_END - 0.5);
  await expect(skip).toHaveCount(0);
});

test('leaving the segment drops the countdown, re-entering restarts it, and turning the setting off retires it', async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?autoSkip`);

  const skip = page.getByRole('button', { name: 'Skip Intro', exact: true });
  const countdown = page.locator('.auto-skip-in');
  await expect(countdown).toBeVisible({ timeout: 30_000 });

  // A seek out of the segment is not "keep watching": it only drops this countdown.
  await seek(page, 45);
  await expect(skip).toHaveCount(0);
  await expect(countdown).toHaveCount(0);
  await seek(page, 1);
  await expect(countdown).toHaveText(/^Auto-skip in [78]s$/);

  // The synced setting turned off mid-countdown: the countdown goes at once and no skip follows.
  await page.getByTestId('auto-skip-off').dispatchEvent('click');
  await expect(countdown).toHaveCount(0);
  await expect(skip).toBeVisible();
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThan(11);
  expect(await position(page)).toBeLessThan(INTRO_END);
});

test('a low-confidence segment offers Skip but never counts down', async ({ page }) => {
  await mockPlayer(page, { confidence: 0.75 });
  await page.goto(`${ORIGIN}/test/player.html?autoSkip`);

  const skip = page.getByRole('button', { name: 'Skip Intro', exact: true });
  await expect(skip).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThan(10);
  await expect(page.locator('.auto-skip-in')).toHaveCount(0);
  expect(await position(page)).toBeLessThan(INTRO_END);
});

test('an outro in the front half of the title is never offered or counted down', async ({
  page,
}) => {
  // Credits at 5-30 s of a 60 s episode are implausible; the intro that follows is still offered.
  await mockPlayer(page, {
    segments: {
      outro: { start_ms: 5_000, end_ms: 30_000, match: 'exact', confidence: 0.9 },
      intro: { start_ms: 31_000, end_ms: 45_000, match: 'exact', confidence: 0.9 },
    },
  });
  await page.goto(`${ORIGIN}/test/player.html?autoSkip`);

  await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThan(8);
  await expect(page.getByRole('button', { name: 'Skip Credits', exact: true })).toHaveCount(0);
  await expect(page.locator('.auto-skip-in')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip Intro', exact: true })).toHaveCount(0);
  await seek(page, 32);
  await expect(page.getByRole('button', { name: 'Skip Intro', exact: true })).toBeVisible();
});

test('Skip and its countdown speak the interface language, after a live change too', async ({
  page,
}) => {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?autoSkip&languageControls`);
  // Changed live, as a profile's language is, while the player is already mounted.
  await page.getByTestId('interface-language-sv').dispatchEvent('click');

  const countdown = page.locator('.auto-skip-in');
  await expect(countdown).toHaveText(/^Hoppar över om [1-8] s$/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Hoppa över intro', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Hoppas över' })).toHaveText(
    'Hoppas över automatiskt om 8 sekunder. Pausa eller spola för att fortsätta titta.',
  );
  await expect(page.getByRole('button', { name: 'Skip Intro' })).toHaveCount(0);
  await expect(page.getByText(/Auto-skip|Skips automatically/)).toHaveCount(0);
});

test('Spanish Skip and countdown', async ({ page }) => {
  await mockPlayer(page);
  await page.goto(`${ORIGIN}/test/player.html?autoSkip&interfaceLanguage=es`);
  await expect(page.locator('.auto-skip-in')).toHaveText(/^Se omite en [1-8] s$/, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole('button', { name: 'Omitir introducción', exact: true }),
  ).toBeVisible();
});
