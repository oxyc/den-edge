// den-edge#234: the status line while a stream is slow to start. The session route is held open on a promise this
// test controls, so "Finding…" is seen, then — once four real seconds have passed — "Opening…" with its elapsed
// clock, proving the 4s line change without timing the whole test against an arbitrary network delay. The session
// is then let through with a large release's label and size so "Starting <label>…" names it, with the media
// itself held a beat so that line has a real window to be seen in before the first frame clears it.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';

const ORIGIN = 'http://127.0.0.1:5198';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);

const LARGE_RELEASE_BYTES = 58 * 1024 ** 3;
const session = {
  sid: 'd1',
  playlist: '/direct/s/d1/sig/master.m3u8',
  duration: 60,
  release: { label: '4K • REMUX • 58 GB', filename: 'fixture.mkv', size: LARGE_RELEASE_BYTES },
  video: { codec: 'vp9', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};

test('the startup notice counts the wait, names a large release once open, and clears at the first frame', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({
      userAgent: CHROME_MAC,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    // Held open until released below, so this test controls exactly when the session answers.
    let releaseSession;
    const sessionGate = new Promise((resolve) => (releaseSession = resolve));
    await page.route(`${ORIGIN}/direct/session`, async (r) => {
      await sessionGate;
      await r.fulfill({ status: 201, json: session });
    });
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
    await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
      const request = r.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'DELETE') return r.fulfill({ status: 204 });
      if (request.method() === 'POST') return r.fulfill({ status: 204 });
      const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
      // A beat on the media itself, so there is a real window with a session open but no first frame yet — long
      // enough for "Starting …" to be observed before playback begins.
      if (file === 'init.mp4' || file.endsWith('.m4s'))
        await new Promise((resolve) => setTimeout(resolve, 600));
      return r.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html`);

    await expect(page.getByText('Finding a release this browser can play…')).toBeVisible();
    // Four real seconds, held open: NOTICE_DELAY_MS (startupNotice.ts) is exactly this.
    await new Promise((resolve) => setTimeout(resolve, 4_200));
    await expect(page.getByText('Opening the release…', { exact: false })).toBeVisible();
    await expect(page.locator('.startup .clock')).toBeVisible();

    releaseSession();
    await expect(page.getByText('Starting 4K • REMUX • 58 GB…', { exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('58.0 GB', { exact: false })).toBeVisible();

    // Gone once the first frame arrives, over the video rather than in its place.
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );
    await expect(page.locator('.startup')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// den-edge#234 (the owner's second note): a bare spinner during the wait is the actual complaint. Every media
// file on this route answers slowly — a throttled link — so there is a real (if brief, for this tiny fixture)
// window between hls.js's `FRAG_LOADED` for the first segment and the first frame actually rendering. A
// MutationObserver installed before the page's own scripts run catches that window even if it is only one
// animation frame wide, which `expect().toBeVisible()`'s own slower polling is not guaranteed to.
test('the live buffering line shows real bytes and a rate before the first frame, on a throttled segment route', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({
      userAgent: CHROME_MAC,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    // Records every distinct line the status element has shown, including ones too brief for polling to see.
    await page.addInitScript(() => {
      window.__statusHistory = [];
      const seen = new Set();
      new MutationObserver(() => {
        const text = document.querySelector('[role="status"]')?.textContent ?? '';
        if (text && !seen.has(text)) {
          seen.add(text);
          window.__statusHistory.push(text);
        }
        // `document.documentElement` doesn't exist yet when this init script runs; observe `document`
        // itself instead, which always does — it reports the same descendant mutations once there is a tree.
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await guardNetwork(page);
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    await page.route(`${ORIGIN}/direct/session`, (r) => r.fulfill({ status: 201, json: session }));
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
    await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
      const request = r.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'DELETE') return r.fulfill({ status: 204 });
      if (request.method() === 'POST') return r.fulfill({ status: 204 });
      const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
      // The throttle: every media file this slow, so there is a real window with some bytes in hand and the
      // first frame still to come.
      if (file === 'init.mp4' || file.endsWith('.m4s'))
        await new Promise((resolve) => setTimeout(resolve, 700));
      return r.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html`);

    // Cleared once the first frame actually renders.
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );
    await expect(page.locator('.startup')).toHaveCount(0);

    // Real bytes — "Buffering <label> — N.N MB" (a rate joins it once hls.js has enough of a sample to trust
    // one, which this fixture's tiny, near-instant transfers don't reliably give) — were shown at some point
    // before that, not a bare "Starting…" the whole time and not a spinner.
    const history = await page.evaluate(() => window.__statusHistory);
    expect(history.some((line) => line.includes(`Buffering ${session.release.label}`))).toBe(true);
    expect(history.some((line) => line.includes('MB'))).toBe(true);
  } finally {
    await browser.close();
  }
});
