// den-remux copies AV1 for a browser that reports it decodes it, naming it in the master by its long `av01…` codec
// string and, for HDR, `VIDEO-RANGE=PQ` (oxyc/den#40). Codec lab measures whether a browser decodes AV1; this asks
// whether it takes Remux's own copy. The fixtures under `media/remux-av1/` are what a real Remux session served —
// master, media playlist, init and segments, unedited — written by den-hearth's end-to-end tests:
//
//   REMUX_E2E_DUMP=<dir> cargo test -p den-remux av1_ -- --ignored
//
// `sdr/` is `av1-sdr.mkv` (8-bit BT.709, no VIDEO-RANGE) and `pq/` is `av1.mkv` (10-bit HDR10, VIDEO-RANGE=PQ), each
// 30 s of 320×180 test pattern with Opus audio Remux converts to AAC. They play through the player as a session does,
// hls.js outside WebKit and the browser's own HLS in it, and must show frames past three seconds with no MediaError
// and no failure reported to den-remux.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const media = new URL('./media/remux-av1/', import.meta.url);

const session = (n) => ({
  sid: n,
  playlist: `/direct/s/${n}/sig/master.m3u8`,
  duration: 30,
  release: { label: 'AV1 fixture', filename: 'av1.mkv', size: 1 },
  video: { codec: 'av1', transcoded: false, width: 320, height: 180, tonemapped: false },
  audioTrack: 0,
  audioTracks: [],
});

/** The player on Remux's own `fixture` (`sdr` or `pq`) in `browserType`; what it asked for and what it reported. */
async function play(browserType, fixture, launch, contextOptions = {}) {
  const browser = await browserType.launch(launch);
  const asked = { sessions: [], served: [], failures: [] };
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...contextOptions,
    });
    const page = await context.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
    await page.route(`${ORIGIN}/direct/session`, (r) => {
      asked.sessions.push(r.request().postDataJSON());
      return r.fulfill({ status: 201, json: session(`a${asked.sessions.length}`) });
    });
    await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
      const request = r.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        const body = request.postData() ?? '';
        if (path.endsWith('/report') && body.includes('"code"')) asked.failures.push(body);
        return r.fulfill({ status: 204 });
      }
      const file = path.split('/').pop();
      asked.served.push(file);
      return r.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(`${fixture}/${file}`, media)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html`);
    const video = page.locator('.player video');
    await expect
      .poll(() => video.evaluate((v) => (v.paused ? -1 : v.currentTime)), { timeout: 30_000 })
      .toBeGreaterThan(3);
    const shown = await video.evaluate((v) => ({
      error: v.error && { code: v.error.code, message: v.error.message },
      width: v.videoWidth,
      height: v.videoHeight,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
    }));
    return { asked, shown };
  } finally {
    await browser.close();
  }
}

/** What every case holds to: Remux's master was the one played, frames were shown, nothing failed. */
function playedClean({ asked, shown }) {
  expect(asked.served).toEqual(
    expect.arrayContaining(['master.m3u8', 'media.m3u8', 'init.mp4', 'seg0.m4s']),
  );
  expect(shown.error).toBeNull();
  expect(asked.failures).toEqual([]);
  expect(asked.sessions).toHaveLength(1);
  // The picture, not just the audio clock: the copy's own size, and frames decoded past the opening second.
  expect([shown.width, shown.height]).toEqual([320, 180]);
  expect(shown.frames).toBeGreaterThan(24);
}

const chromiumLaunch = {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--autoplay-policy=no-user-gesture-required'],
};

test('Chromium plays Remux’s SDR AV1 copy through hls.js', async () => {
  const result = await play(chromium, 'sdr', chromiumLaunch, { userAgent: CHROME_MAC });
  playedClean(result);
  expect(result.asked.sessions[0].player).toBe('hls.js');
  // den-remux copies AV1 only for a browser that reports it: this one did.
  expect(result.asked.sessions[0].playable.av1).toBeGreaterThan(0);
});

test('Chromium plays Remux’s HDR10 AV1 copy (VIDEO-RANGE=PQ) through hls.js', async () => {
  const result = await play(chromium, 'pq', chromiumLaunch, { userAgent: CHROME_MAC });
  playedClean(result);
  expect(result.asked.sessions[0].player).toBe('hls.js');
  expect(result.asked.sessions[0].playable.av1Main10).toBeGreaterThan(0);
  // Whether this Chromium says it shows PQ (Media Capabilities) depends on its display; decoding doesn't.
  test.info().annotations.push({
    type: 'av1Hdr',
    description: String(result.asked.sessions[0].playable.av1Hdr),
  });
});

test.describe('WebKit', () => {
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

  for (const fixture of ['sdr', 'pq']) {
    test(`WebKit plays Remux’s ${fixture === 'sdr' ? 'SDR' : 'HDR10'} AV1 copy where it decodes AV1`, async () => {
      // WebKit decodes AV1 only where the platform does (Apple silicon from M3 on; GStreamer's dav1d on Linux), and
      // says so: where it says no, den-remux would never have copied AV1 for it.
      const probe = await webkit.launch();
      const type = `video/mp4; codecs="av01.0.00M.${fixture === 'sdr' ? '08' : '10'}"`;
      const decodes = await (
        await probe.newPage()
      ).evaluate(
        (type) =>
          globalThis.MediaSource?.isTypeSupported(type) ||
          document.createElement('video').canPlayType(type) !== '',
        type,
      );
      await probe.close();
      test.skip(!decodes, 'this WebKit reports no AV1 decoder');
      const result = await play(webkit, fixture);
      playedClean(result);
      test
        .info()
        .annotations.push({ type: 'player', description: result.asked.sessions[0].player });
    });
  }
});
