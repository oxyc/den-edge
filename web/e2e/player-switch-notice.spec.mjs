// den-edge#275: a guest who watched Fauda over a flaky connection hopped releases by hand dozens of times
// because an automatic switch (a decoder refusing a copy, or the link too slow to carry it) said nothing —
// the picture just paused and came back on another file. These two specs reproduce the two halves of the fix:
// an automatic switch now names itself (`autoSwitchNotice`/`autoSwitchedNotice`), and a mid-play stall shows
// the same live numbers the startup line already does (`bufferingWhilePlaying`) instead of a bare spinner.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);

async function routeMedia(page, { delayMs } = {}) {
  await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') return r.fulfill({ status: 204 });
    if (request.method() === 'POST') return r.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    const ms = delayMs?.(file);
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
}

// WebKit: this guest's own engine (iOS Chrome plays HLS through WebKit, same as Safari), and a decoder
// refusal needs no hls.js-specific wiring to reproduce — the video element's own `error` is what `broke()`
// reads regardless of which engine is loading the media behind it.
test.skip(
  !process.env.CI && !existsSync(webkit.executablePath()),
  'needs WebKit: npx playwright install webkit',
);

test('a session that errors mid-play names the switch, then names what it landed on', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt4565380' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    const releases = [
      { filename: 'a.mkv', label: '1080p • WEB-DL • 13 GB', plays: 'yes' },
      { filename: 'b.mkv', label: '720p • WEB • 3 GB', plays: 'yes' },
    ];
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases } }));
    let sessionsAsked = 0;
    const outcomes = [];
    await page.route(`${ORIGIN}/direct/session`, async (r) => {
      sessionsAsked += 1;
      const first = sessionsAsked === 1;
      // A real beat on the switch's own request: long enough for "trying another release…" to have a
      // window of its own before "playing … instead." replaces it, rather than both landing in the same tick.
      if (!first) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return r.fulfill({
        status: 201,
        json: {
          sid: first ? 'a1' : 'b1',
          playlist: `/direct/s/${first ? 'a1' : 'b1'}/sig/master.m3u8`,
          duration: 60,
          release: first ? releases[0] : releases[1],
          video: { codec: 'h264', transcoded: false },
          audioTrack: 0,
          audioTracks: [],
        },
      });
    });
    await page.route(`${ORIGIN}/playback/outcome`, async (r) => {
      outcomes.push(JSON.parse(r.request().postData() ?? '{}'));
      return r.fulfill({ status: 204 });
    });
    await routeMedia(page);
    await page.goto(`${ORIGIN}/test/player.html`);

    // The release list loaded enough to count: the picker shows both.
    await expect(page.locator('select[aria-label="Release"] option')).toHaveCount(2);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );

    // The decoder refusing what played: `broke()` reads `video.error`, which only a real failure sets, so
    // this overrides it the way a WebKit `MediaError 3` (`decode`) would, then fires the event `broke()`
    // actually listens for.
    await page.locator('video').evaluate((v) => {
      Object.defineProperty(v, 'error', {
        value: { code: 3, message: 'decode test' },
        configurable: true,
      });
      v.dispatchEvent(new Event('error'));
    });

    await expect(
      page.getByText(
        '1080p • WEB-DL • 13 GB couldn’t play here — trying another release… (1 of 2)',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        '1080p • WEB-DL • 13 GB couldn’t play here — playing 720p • WEB • 3 GB instead.',
      ),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => outcomes.at(-1)?.switchCount).toBe(1);
    expect(outcomes.at(-1)?.lastSwitchReason).toBe('decode');
  } finally {
    await browser.close();
  }
});

// Chromium/hls.js: the same throttle technique `player-startup-notice.spec.mjs` already proves works for
// the startup line, aimed at a segment well past the first frame instead of the first one, so there is a
// real mid-play stall — `waiting`, not `loadeddata` — to read live numbers from.
test('a throttled segment mid-play shows the buffering line with real numbers, then clears', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt4565380' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    await page.route(`${ORIGIN}/direct/session`, (r) =>
      r.fulfill({
        status: 201,
        json: {
          sid: 'a1',
          playlist: '/direct/s/a1/sig/master.m3u8',
          duration: 60,
          release: { label: '1080p • WEB-DL • 13 GB', filename: 'a.mkv', size: 13 * 1024 ** 3 },
          video: { codec: 'h264', transcoded: false },
          audioTrack: 0,
          audioTracks: [],
        },
      }),
    );
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
    // Only seg3 (6s in — well past the first frame, which plays from seg0/init) is held, long enough that the
    // buffer seg0–seg2 already built up runs dry before it lands: a real stall the viewer would otherwise see
    // as a bare spinner, not the throttle `player-startup-notice.spec.mjs` puts on every segment to delay the
    // first frame itself.
    // hls.js prefetches sequentially from the very start, so the delay has to outlast real playback actually
    // reaching seg3's own position (6s in) — issued at ~t0, not when the play head gets there — or it lands
    // before it is ever missed.
    await routeMedia(page, { delayMs: (file) => (file === 'seg3.m4s' ? 9_000 : 0) });
    await page.goto(`${ORIGIN}/test/player.html`);

    await expect(page.getByText('Buffering —', { exact: false })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('MB/s', { exact: false })).toBeVisible();
    // Clears once the held segment lands and playback carries on past where it stalled.
    await expect(page.getByText('Buffering —', { exact: false })).toHaveCount(0, {
      timeout: 25_000,
    });
  } finally {
    await browser.close();
  }
});
