// Pressing Cast must never break what is playing.
//
// The player plays on a direct den-remux route; Cast used to move it to the relay and the cast page at once, before
// anything was known about a receiver. At home with no Chromecast awake that left the viewer on a cast page that
// could reach neither of its addresses, loading at 00:00 for good. The cast page here is a stub on its own origin
// that answers the player's messages the way the real one does in each case.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';

const ORIGIN = 'http://127.0.0.1:5198';
const CAST = 'https://cast.test';
const MEDIA = 'https://media.test';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);

/**
 * The cast page, as far as the player can tell: `none` sees no receiver, `receiver` sees one but cannot play what is
 * loaded into it (an error), `silent` sees one and never plays what is loaded (no error either).
 */
const castPage = (mode) => `<!doctype html><script>
  addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'den-discover')
      parent.postMessage({ type: 'den-cast-availability', available: ${mode !== 'none'} }, event.origin);
    if (message.type !== 'den-load') return;
    if (${mode === 'none'})
      parent.postMessage({ type: 'den-cast-availability', id: message.id, available: false }, event.origin);
    else if (${mode === 'receiver'})
      parent.postMessage({ type: 'den-error', id: message.id, message: 'hls.js networkError manifestLoadError' }, event.origin);
  });
  parent.postMessage({ type: 'den-ready' }, '*');
</script>`;

const session = (base, n) => ({
  sid: n,
  playlist: `/${base}/s/${n}/sig/master.m3u8`,
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'vp9', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
});

async function open(mode, { releases = [] } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    userAgent: CHROME_MAC,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await guardNetwork(page);
  const asked = { direct: [], relay: [], ended: [] };
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/direct/session`, (r) => {
    asked.direct.push(r.request().postDataJSON());
    return r.fulfill({ status: 201, json: session('direct', `d${asked.direct.length}`) });
  });
  await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases } }));
  await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') {
      asked.ended.push(path);
      return r.fulfill({ status: 204 });
    }
    if (request.method() === 'POST') return r.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  // The relay, which only a move to cast asks: its sessions carry the public address and the cast page.
  await page.route(`${ORIGIN}/remux/session`, (r) => {
    asked.relay.push(r.request().postDataJSON());
    return r.fulfill({
      status: 201,
      json: { ...session('remux', `r${asked.relay.length}`), publicBase: MEDIA, castOrigin: CAST },
    });
  });
  await page.route(`${ORIGIN}/remux/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${MEDIA}/**`, (r) => r.fulfill({ status: 204 }));
  await page.route(`${CAST}/**`, (r) =>
    r.fulfill({ contentType: 'text/html', body: castPage(mode) }),
  );
  await page.goto(`${ORIGIN}/test/player.html`);
  return { browser, page, asked };
}

/** Wait for the in-page video to be past `seconds`, mark it, and say where it is. */
async function playingPast(page, seconds) {
  await page.waitForFunction(
    (s) => (document.querySelector('.player video')?.currentTime ?? 0) > s,
    seconds,
    { timeout: 30_000 },
  );
  return page.evaluate(() => {
    const video = document.querySelector('.player video');
    video.dataset.before = 'cast';
    return video.currentTime;
  });
}

test('Cast with no Chromecast on the network leaves the video playing', async () => {
  const { browser, page, asked } = await open('none');
  try {
    const before = await playingPast(page, 3);
    await page.getByRole('button', { name: 'Cast to a TV' }).click();
    await expect(page.getByText('No Chromecast found.')).toBeVisible({ timeout: 15_000 });
    // The same element, never replaced, and still going: nothing was restarted or moved.
    const video = page.locator('.player video[data-before="cast"]');
    await expect(video).toHaveCount(1);
    await expect
      .poll(() => video.evaluate((v) => (v.paused ? -1 : v.currentTime)))
      .toBeGreaterThan(before + 3);
    expect(asked.relay, 'no session was moved to the relay').toEqual([]);
    expect(asked.direct).toHaveLength(1);
    expect(asked.ended, 'the playing session was not ended').toEqual([]);
    // Only information: dismissing it leaves playback as it is.
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('No Chromecast found.')).toHaveCount(0);
    await expect(video).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

// Another release picked mid-film is a new session. den-remux gives a browser one, and ended the playing one as soon
// as the new one was asked for, unless the request names it as the one replaced.
test('a release picked mid-film names the session it replaces, which the page ends once the new one is in', async () => {
  const { browser, page, asked } = await open('none', {
    releases: [
      { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1, plays: 'yes' },
      { label: 'Other 720p', filename: 'other.mkv', size: 1, plays: 'yes' },
    ],
  });
  try {
    await playingPast(page, 3);
    expect(asked.direct[0]).not.toHaveProperty('replaces');
    await page.getByRole('combobox', { name: 'Release' }).selectOption('other.mkv');
    await expect.poll(() => asked.direct.length).toBe(2);
    expect(asked.direct[1]).toMatchObject({
      filename: 'other.mkv',
      transcode: 'never',
      replaces: 'd1',
    });
    await expect.poll(() => asked.ended).toEqual(['/direct/s/d1/sig']);
  } finally {
    await browser.close();
  }
});

for (const [mode, what] of [
  ['receiver', 'fails to play'],
  ['silent', 'never plays'],
]) {
  test(`a cast-page session that ${what} goes back to the normal player at the same second`, async () => {
    test.setTimeout(mode === 'silent' ? 120_000 : 60_000);
    const { browser, page, asked } = await open(mode);
    try {
      const before = await playingPast(page, 7);
      await page.getByRole('button', { name: 'Cast to a TV' }).click();
      // A receiver was seen, so playback moved to the relay, starting where the video was.
      await expect.poll(() => asked.relay.length).toBe(1);
      expect(asked.relay[0].startAt).toBeGreaterThanOrEqual(Math.floor(before));
      // Another route's session may be another owner's at den-remux: not named as replaced.
      expect(asked.relay[0]).not.toHaveProperty('replaces');
      // Then back on the direct route, from that same second — not retried at the relay as a conversion.
      await expect.poll(() => asked.direct.length, { timeout: 60_000 }).toBe(2);
      const back = asked.direct[1];
      expect(back.startAt).toBeGreaterThanOrEqual(Math.floor(before));
      expect(back.startAt).toBeLessThan(before + 3);
      expect(back.playable, 'asked as the same browser, not as one that refused').toEqual(
        asked.direct[0].playable,
      );
      expect(back).not.toHaveProperty('replaces');
      await expect(page.locator('.player iframe[title="Den Cast player"]')).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const video = document.querySelector('.player video');
            return video && !video.paused ? video.currentTime : -1;
          }),
        )
        .toBeGreaterThanOrEqual(Math.floor(before));
      expect(asked.relay, 'the relay session was not retried').toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
}
