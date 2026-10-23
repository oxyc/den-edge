// Pressing Cast must never break what is playing.
//
// The player plays on a direct den-remux route; Cast used to move it to the relay and the cast page at once, before
// anything was known about a receiver. At home with no Chromecast awake that left the viewer on a cast page that
// could reach neither of its addresses, loading at 00:00 for good. The cast page here is a stub on its own origin
// that answers the player's messages the way the real one does in each case.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const MEDIA = 'https://media.test';
const CDN = 'https://video.eu.tb-cdn.io';
const LAN = 'http://192.168.86.20:8090';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);
const TEST_CAST_DISCOVERY_MS = 500;
const TEST_CAST_PLAY_MS = 1_000;

/**
 * The cast page, as far as the player can tell: `none` sees no receiver, `receiver` sees one but cannot play what is
 * loaded into it (an error), `silent` sees one and never plays what is loaded (no error either). Offered the choice
 * (`den-choose`), the viewer here picks the receiver at once: a Cast session starts with nothing loaded.
 */
const castPage = (mode, discoveryDelay = 0) => `<!doctype html><script>
  window.loads = [];
  addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'den-discover')
      setTimeout(() => parent.postMessage({ type: 'den-cast-availability', available: ${mode !== 'none'} }, event.origin), ${discoveryDelay});
    if (message.type === 'den-choose')
      parent.postMessage({ type: 'den-cast-session', state: 'started', profile: 'google-tv-4k' }, event.origin);
    if (message.type !== 'den-load') return;
    window.loads.push(message.media);
    if (${mode === 'none'})
      parent.postMessage({ type: 'den-cast-availability', id: message.id, available: false }, event.origin);
    else if (${mode === 'direct-fail'} && message.media.external)
      setTimeout(() => parent.postMessage({ type: 'den-error', id: message.id, message: 'Chromecast could not load this release' }, event.origin), 250);
    else if (${mode === 'direct-fail'})
      parent.postMessage({ type: 'den-cast', id: message.id, state: 'playing' }, event.origin);
    else if (${mode === 'receiver'})
      parent.postMessage({ type: 'den-error', id: message.id, message: 'hls.js networkError manifestLoadError' }, event.origin);
    else if (${mode === 'playing'})
      parent.postMessage({ type: 'den-cast', id: message.id, state: 'playing' }, event.origin);
  });
  parent.postMessage({ type: 'den-ready' }, '*');
</script>`;

/** Read the receiver stub without turning its normal replacement into a test failure. */
async function castLoads(page) {
  const cast = page.frames().find((frame) => frame.url().startsWith(CAST));
  if (!cast) return [];
  try {
    return await cast.evaluate(() => window.loads ?? []);
  } catch (error) {
    // The player deliberately replaces this frame as its Cast offer changes. Poll the replacement instead.
    if (
      cast.isDetached() ||
      /Frame was detached|Execution context was destroyed/.test(String(error))
    )
      return [];
    throw error;
  }
}

const session = (base, n) => ({
  sid: n,
  playlist: `/${base}/s/${n}/sig/master.m3u8`,
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'vp9', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
});

const lanSession = (n) => ({
  ...session('remux', n),
  sid: 'L'.repeat(22),
  playlist: `${LAN}/remux/s/${'L'.repeat(22)}/${'s'.repeat(22)}/master.m3u8`,
});

async function open(
  mode,
  {
    releases = [],
    managed = false,
    subtitleLanguage,
    lanHttp = false,
    viewport = { width: 1280, height: 800 },
    castDiscoveryDelay = 0,
  } = {},
) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    userAgent: CHROME_MAC,
    viewport,
  });
  const page = await context.newPage();
  await guardNetwork(page);
  const asked = { direct: [], managed: [], relay: [], ended: [] };
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/direct/session`, (r) => {
    asked.direct.push(r.request().postDataJSON());
    return r.fulfill({
      status: 201,
      json: lanHttp
        ? lanSession(`d${asked.direct.length}`)
        : session('direct', `d${asked.direct.length}`),
    });
  });
  await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases } }));
  await page.route(`${ORIGIN}/den/config/playback`, (r) => {
    const request = r.request().postDataJSON();
    asked.managed.push(request);
    if (request.directFailed === true)
      return r.fulfill({
        status: 200,
        json: {
          url: `${MEDIA}/remux/s/cast/sig/master.m3u8`,
          release: { label: 'Fixture Remux HLS', filename: 'fixture.mkv', size: 1 },
          publicBase: MEDIA,
          lanBase: `${ORIGIN}/lan`,
          castOrigin: CAST,
          hinted: true,
          session: {
            id: 'cast',
            playlist: '/remux/s/cast/sig/master.m3u8',
            duration: 60,
            release: { label: 'Fixture Remux HLS', filename: 'fixture.mkv', size: 1 },
            video: { codec: 'h264', transcoded: true },
            audioTrack: 0,
            audioTracks: [],
            subtitles: [],
            endUrl: '/remux/s/cast/sig',
            heartbeatUrl: '/remux/s/cast/sig/heartbeat',
            reportUrl: '/remux/s/cast/sig/report',
          },
        },
      });
    return r.fulfill({
      status: 200,
      json: {
        url: `${CDN}/stream/master.m3u8?token=fixture&scrobbling_enabled=false`,
        release: { label: 'Fixture direct HLS', filename: 'fixture.mkv', size: 1 },
      },
    });
  });
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (r) =>
    r.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.route(`${CDN}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') {
      asked.ended.push(path);
      return r.fulfill({ status: 204 });
    }
    // A real browser's navigator.sendBeacon, which endSession() now prefers: the beacon-compatible twin of
    // the DELETE above (beacon is POST-only). Normalized to the same base path so this still reads as one
    // way of saying "ended", whichever one actually fired.
    if (request.method() === 'POST' && path.endsWith('/end')) {
      asked.ended.push(path.slice(0, -'/end'.length));
      return r.fulfill({ status: 204 });
    }
    if (request.method() === 'POST') return r.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  await page.route(`${LAN}/remux/s/**`, async (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return r.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      headers: { 'access-control-allow-origin': '*' },
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
    r.fulfill({ contentType: 'text/html', body: castPage(mode, castDiscoveryDelay) }),
  );
  const query = new URLSearchParams({
    castDiscoveryMs: String(TEST_CAST_DISCOVERY_MS),
    castPlayMs: String(TEST_CAST_PLAY_MS),
  });
  if (managed) {
    // The complete app always reaches Hearth through the ordinary `/remux` face. A managed answer may still be a
    // direct TorBox capability, which must retain Chromecast even though an old Remux-only gate sees this route.
    query.set('playback', '/den/config/playback');
    query.set('remux', '/remux');
  }
  if (subtitleLanguage) query.set('subtitleLanguage', subtitleLanguage);
  await page.goto(`${ORIGIN}/test/player.html?${query}`);
  return { browser, page, asked };
}

test('managed direct HLS casts its capability, then asks Hearth once for Remux on failure', async () => {
  const { browser, page, asked } = await open('direct-fail', { managed: true });
  try {
    await playingPast(page, 3);
    const video = page.locator('.player video');
    await expect(video).toHaveAttribute('x-webkit-airplay', 'allow');
    const castButton = page.getByRole('button', { name: 'Cast to a TV' });
    await expect(castButton).toBeVisible();
    // Desktop's owned transport keeps output routing with the other circular playback actions, rather than leaving
    // Chromecast as unrelated header chrome. Pointer semantics are covered with the complete app stylesheet by the
    // cross-engine player test; this fixture intentionally mounts only the component's scoped CSS.
    await expect(castButton.locator('xpath=ancestor::footer')).toBeVisible();
    expect(asked.managed).toHaveLength(1);
    expect(asked.direct, 'direct TorBox-style HLS did not create a legacy Remux session').toEqual(
      [],
    );
    expect(asked.relay).toEqual([]);

    await clickCast(page);
    await expect.poll(() => asked.managed.length).toBeGreaterThanOrEqual(2);
    expect(asked.managed[1].player).toBe('cast');
    expect(asked.managed[1]).not.toHaveProperty('directFailed');
    let directLoad;
    await expect
      .poll(async () => {
        [directLoad] = await castLoads(page);
        return directLoad ?? null;
      })
      .not.toBeNull();
    expect(directLoad).toMatchObject({
      url: `${CDN}/stream/master.m3u8?token=fixture&scrobbling_enabled=false`,
      external: true,
      mode: 'cast',
    });
    expect(directLoad).not.toHaveProperty('lanUrl');
    expect(directLoad).not.toHaveProperty('speed');

    await expect.poll(() => asked.managed.length).toBe(3);
    expect(asked.managed[2]).toMatchObject({ player: 'cast', directFailed: true });
    await expect
      .poll(async () => {
        const loads = await castLoads(page);
        return loads.at(-1)?.url ?? '';
      })
      .toBe(`${MEDIA}/remux/s/cast/sig/master.m3u8`);
    expect(asked.direct, 'managed playback never posts to the legacy direct facade').toEqual([]);
    expect(asked.relay, 'Hearth, not Web, chooses the Remux implementation').toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a signed LAN HTTP session stays on Hearth and is handed directly to Chromecast', async () => {
  const { browser, page, asked } = await open('playing', { lanHttp: true });
  try {
    await playingPast(page, 3);
    await clickCast(page);
    await expect.poll(() => asked.direct.length).toBe(2);
    expect(asked.direct[1]).toMatchObject({ player: 'cast' });
    expect(asked.relay, 'LAN HTTP media does not need Edge public-media ingress').toEqual([]);

    await expect
      .poll(async () => {
        const loads = await castLoads(page);
        return loads.at(-1)?.url ?? '';
      })
      .toBe(`${LAN}/remux/s/${'L'.repeat(22)}/${'s'.repeat(22)}/master.m3u8`);
    const loads = await castLoads(page);
    expect(loads.at(-1)?.mode).toBe('cast');
  } finally {
    await browser.close();
  }
});

test('a selected subtitle never disqualifies TorBox before Cast', async () => {
  const { browser, page, asked } = await open('playing', {
    managed: true,
    subtitleLanguage: 'eng',
  });
  try {
    await playingPast(page, 3);
    await clickCast(page);
    await expect.poll(() => asked.managed.length).toBe(2);
    expect(asked.managed[1]).toMatchObject({ player: 'cast' });
    expect(asked.managed[1]).not.toHaveProperty('directFailed');
    await expect
      .poll(async () => {
        const loads = await castLoads(page);
        return loads.at(-1)?.url ?? '';
      })
      .toBe(`${CDN}/stream/master.m3u8?token=fixture&scrobbling_enabled=false`);
    expect(asked.managed).toHaveLength(2);
    expect(asked.direct).toEqual([]);
    expect(asked.relay).toEqual([]);
  } finally {
    await browser.close();
  }
});

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

/**
 * Reveal the auto-hiding transport the way a viewer does. It hides 3.5 s into playback; a viewer brings it back by
 * moving toward the controls, while Playwright otherwise teleports its synthetic click to a control that correctly no
 * longer receives pointer input underneath the video.
 */
async function revealControls(page) {
  await page.mouse.move(20, 20);
  await expect(page.locator('.player')).not.toHaveClass(/web-controls-hidden/);
}

/** Press Cast, an output action in the auto-hiding transport. */
async function clickCast(page) {
  await revealControls(page);
  await page.getByRole('button', { name: 'Cast to a TV' }).click();
}

async function playerGeometry(page) {
  return page.locator('.player').evaluate((player) => {
    const box = (selector) => {
      const rect = player.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { stage: box('.stage'), video: box('video') };
  });
}

/**
 * Record each Cast status the page renders (`window.castStatuses`), measured as the DOM changes. "Looking" lasts only
 * the fixture's discovery window, which a busy machine can spend before a test's next call reaches the page; read
 * from the test, that state is missed or measured as it is replaced.
 */
async function recordCastStatus(page) {
  await page.locator('.player').evaluate((player) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    window.castStatuses = [];
    new MutationObserver(() => {
      const notice = player.querySelector('.cast-status .notice');
      const text = notice?.querySelector('.notice-copy')?.textContent ?? null;
      if (text === null || text === window.castStatuses.at(-1)?.text) return;
      window.castStatuses.push({
        text,
        notice: box(notice),
        geometry: {
          stage: box(player.querySelector('.stage')),
          video: box(player.querySelector('video')),
        },
      });
    }).observe(player, { subtree: true, childList: true, characterData: true });
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 390, height: 844 },
]) {
  test(`Cast discovery keeps the ${viewport.name} video fixed through searching and no devices`, async () => {
    const { browser, page } = await open('none', {
      viewport,
      castDiscoveryDelay: 250,
    });
    try {
      await playingPast(page, 1);
      const idle = await playerGeometry(page);
      await recordCastStatus(page);

      await clickCast(page);
      await expect(page.getByText('No Chromecast found.')).toBeVisible();
      const statuses = await page.evaluate(() => window.castStatuses);
      expect(statuses.map((status) => status.text)).toEqual([
        'Looking for a Chromecast…',
        'No Chromecast found. Check that it is awake and on the same network as this device.',
      ]);
      const [searching, none] = statuses;
      expect(searching.geometry).toEqual(idle);
      expect(none.geometry).toEqual(idle);
      expect(none.notice).toEqual(searching.notice);
    } catch (error) {
      await page
        .context()
        .tracing.stop({ path: test.info().outputPath('page-trace.zip') })
        .catch(() => undefined);
      throw error;
    } finally {
      await browser.close();
    }
  });
}

test('Cast with no Chromecast on the network leaves the video playing', async () => {
  const { browser, page, asked } = await open('none');
  try {
    const before = await playingPast(page, 3);
    await clickCast(page);
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
    await revealControls(page);
    await page.getByRole('button', { name: /^Stream: / }).click();
    await page.getByRole('menuitemradio').filter({ hasText: 'other.mkv' }).click();
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
      await clickCast(page);
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
