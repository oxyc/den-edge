// Cast in one tap: the Cast button shows only once a Chromecast is on the network, and it is the cast page's own button
// (drawn over Den's button surface), so the one press opens Chrome's device list. Before, Cast was Den's button, then
// up to six seconds of "Looking for a Chromecast…", then a second "Choose your Chromecast" button in the cast page,
// because a press in the player is no user activation inside the cross-origin frame.
//
// The real player and the real built cast page, with a stub of Google's Cast SDK standing in for Chrome's device list
// and the receiver. The stub refuses `requestSession` without user activation, as Chrome does.
import { test, expect, chromium, firefox, webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const CDN = 'https://video.eu.tb-cdn.io';
const TORBOX = `${CDN}/stream/master.m3u8?token=fixture&scrobbling_enabled=false`;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
/** What Den's receiver says its TV plays: unlike any model profile, Dolby Vision 8 and E-AC-3 but no HDR10. */
const RECEIVER_PLAYABLE = {
  h264: 0x33,
  h264High10: 0,
  hevcMain: 150,
  hevcMain10: 150,
  hevcHighTier: 0,
  hdr: false,
  eac3: true,
  aacMultichannel: false,
  dolbyVision: { p5: false, p8: true },
  av1: 0,
  av1Main10: 0,
  av1Hdr: false,
  flac: true,
  aac71: false,
  vp9: false,
  vp9Profile2: false,
};
const DEN_APP = '5718B443';
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));

/**
 * Google's sender as the cast page sees it. `devices`: whether a receiver is on the network once discovery starts
 * (`window.__devices(bool)` changes it later). `connect`: what choosing one in Chrome's list comes to — `ok` (a session,
 * after `connectMs` of CONNECTING), `fail` (Chrome could not start one) or `gone` (the receiver went away). Every call
 * the cast page makes of the receiver is kept in `window.calls`, every LOAD in `window.loads`; the receiver plays a
 * loaded title on, a quarter second at a time, as the real one reports it. `interrupt`: a LOAD after the first is
 * answered as a receiver does, after the media it replaces reported once more and then went IDLE `INTERRUPTED`.
 * `refuse`: the receiver refuses every LOAD. `report`: Den's receiver on the custom namespace — `answer` says what its
 * TV plays (RECEIVER_PLAYABLE), `silent` never answers; unset, the session has no message channel, as before. The
 * application id the page launched is kept in `window.appId`, every message it sent in `window.sent`.
 */
const sdk = ({
  devices = true,
  connect = 'ok',
  connectMs = 300,
  interrupt = false,
  refuse = false,
  report,
} = {}) => `
  window.loads = [];
  window.calls = [];
  window.states = [];
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      HlsSegmentFormat: { FMP4: 'fmp4', TS: 'ts' },
      HlsVideoSegmentFormat: { FMP4: 'fmp4', MPEG2_TS: 'mpeg2_ts' },
      MetadataType: { GENERIC: 0 },
      StreamType: { BUFFERED: 'BUFFERED' },
      TrackType: { TEXT: 'TEXT' },
      TextTrackType: { SUBTITLES: 'SUBTITLES' },
      GenericMediaMetadata: function () {},
      MediaInfo: function (url, contentType) { this.contentId = url; this.contentType = contentType; },
      Track: function (id, type) { this.trackId = id; this.type = type; },
      LoadRequest: function (media) { this.media = media; },
      EditTracksInfoRequest: function (ids) { this.activeTrackIds = ids; },
    },
  };
  const listeners = {};
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  let discovering = false;
  let present = ${devices};
  let state = 'NO_DEVICES_AVAILABLE';
  let session = null;
  let loaded = false;
  let idleReason = null;
  const setState = (next) => {
    state = next;
    window.states.push(next);
    fire('caststatechanged', { castState: next });
  };
  window.__devices = (on) => {
    present = on;
    if (discovering && !session) setState(on ? 'NOT_CONNECTED' : 'NO_DEVICES_AVAILABLE');
  };
  const player = { currentTime: 0, duration: 60, isPaused: true, isConnected: false, volumeLevel: 1, isMuted: false, playerState: 'IDLE' };
  const changes = [];
  setInterval(() => {
    if (!session || !loaded) return;
    if (!player.isPaused) player.currentTime = Math.min(player.duration, player.currentTime + 0.25);
    player.playerState = player.isPaused ? 'PAUSED' : 'PLAYING';
    changes.forEach((fn) => fn());
  }, 250);
  const context = {
    setOptions(options) {
      window.appId = options.receiverApplicationId;
      discovering = true;
      setTimeout(() => { if (present) setState('NOT_CONNECTED'); }, 50);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getCurrentSession() { return session; },
    getCastState() { return state; },
    endCurrentSession(stop) {
      window.calls.push(stop ? 'stop' : 'leave');
      session = null;
      loaded = false;
      player.isConnected = false;
      fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
      setState(present ? 'NOT_CONNECTED' : 'NO_DEVICES_AVAILABLE');
    },
    requestSession() {
      if (!navigator.userActivation.isActive) return Promise.reject('no user activation');
      window.calls.push('requestSession');
      if (${JSON.stringify(connect)} === 'gone') return Promise.reject('receiver_unavailable');
      setState('CONNECTING');
      return new Promise((resolve, reject) => setTimeout(() => {
        if (${JSON.stringify(connect)} === 'fail') {
          setState('NOT_CONNECTED');
          return reject('session_error');
        }
        session = {
          loadMedia(request) {
            window.loads.push({ url: request.media.contentId, currentTime: request.currentTime });
            if (${refuse}) return Promise.reject('load_failed');
            if (${interrupt} && loaded)
              return new Promise((resolve) => setTimeout(() => {
                player.playerState = 'PLAYING';
                changes.forEach((fn) => fn());
                idleReason = 'INTERRUPTED';
                player.playerState = 'IDLE';
                changes.forEach((fn) => fn());
                idleReason = null;
                setTimeout(resolve, 100);
              }, 100));
            loaded = true;
            player.currentTime = request.currentTime || 0;
            player.isPaused = false;
            return Promise.resolve();
          },
          getMediaSession() {
            return loaded ? { idleReason, media: { tracks: [] }, editTracksInfo() {} } : null;
          },
          getCastDevice() { return { friendlyName: 'Living Room TV' }; },
        };
        if (${JSON.stringify(report ?? null)}) {
          const heard = {};
          window.sent = [];
          session.addMessageListener = (ns, fn) => { (heard[ns] = heard[ns] || []).push(fn); };
          session.removeMessageListener = (ns, fn) => { heard[ns] = (heard[ns] || []).filter((f) => f !== fn); };
          session.sendMessage = (ns, message) => {
            window.sent.push({ ns, message });
            if (${JSON.stringify(report)} === 'answer' && message.type === 'den-capabilities')
              setTimeout(() => (heard[ns] || []).forEach((fn) => fn(ns, JSON.stringify({
                type: 'den-capabilities',
                playable: ${JSON.stringify(RECEIVER_PLAYABLE)},
                details: { maxHeight: 2160 },
              }))), 200);
            return Promise.resolve();
          };
        }
        player.isConnected = true;
        setState('CONNECTED');
        fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
        resolve();
      }, ${connectMs}));
    },
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => context },
    CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged', CAST_STATE_CHANGED: 'caststatechanged' },
    RemotePlayer: function () { return player; },
    RemotePlayerController: function () {
      this.addEventListener = (_type, fn) => changes.push(fn);
      this.seek = () => window.calls.push('seek:' + Math.round(player.currentTime));
      this.playOrPause = () => { player.isPaused = !player.isPaused; window.calls.push(player.isPaused ? 'pause' : 'play'); };
      this.setVolumeLevel = () => window.calls.push('volume:' + player.volumeLevel);
      this.muteOrUnmute = () => { player.isMuted = !player.isMuted; window.calls.push(player.isMuted ? 'mute' : 'unmute'); };
    },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  } };
  const announce = setInterval(() => {
    if (!window.__onGCastApiAvailable) return;
    clearInterval(announce);
    window.__onGCastApiAvailable(true);
  }, 10);
`;

let built;
test.beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), 'den-cast-one-tap-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
    stdio: 'ignore',
  });
});
test.afterAll(() => rmSync(built, { recursive: true, force: true }));

/** `appId`: what den-edge writes into the page for `CAST_APP_ID` (`src/cast.rs`). */
async function serveFile(route, file, appId) {
  const type = file.endsWith('.html')
    ? 'text/html'
    : file.endsWith('.js')
      ? 'text/javascript'
      : 'text/css';
  // A request still on its way when its test ends (the lazily loaded hls.js) may find the build removed.
  let body = await readFile(join(built, file)).catch(() => undefined);
  if (body && appId && file === 'index.html')
    body = body
      .toString()
      .replace('name="den-cast-app" content=""', `name="den-cast-app" content="${appId}"`);
  return body ? route.fulfill({ contentType: type, body }) : route.abort().catch(() => undefined);
}

/** The player playing a title through Hearth as TorBox's managed HLS, with Cast on this box. */
async function open(
  browserType,
  {
    sdkOptions,
    userAgent = CHROME_MAC,
    viewport = { width: 1280, height: 800 },
    mobile = false,
    subtitle = false,
    // As Hearth does: every ask is a newly created TorBox stream, at its own signed URL.
    freshUrls = false,
    appId,
    query = '',
  } = {},
) {
  const browser = await browserType.launch(
    browserType === chromium
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ['--autoplay-policy=no-user-gesture-required'],
        }
      : {},
  );
  const context = await browser.newContext({
    // `null` keeps the engine's own: Safari's and Firefox's name no Chrome.
    ...(userAgent ? { userAgent } : {}),
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await guardNetwork(page);
  const asked = { managed: [], failures: [], castFrames: 0 };
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/den/config/playback`, (r) => {
    const request = r.request().postDataJSON();
    asked.managed.push(request);
    return r.fulfill({
      json: {
        url: freshUrls ? `${TORBOX}&stream=${asked.managed.length}` : TORBOX,
        release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
        // As Hearth answers: TorBox's embedded track, burned into the stream only when it was asked for by index.
        ...(subtitle
          ? {
              subtitleResync: { supported: false, reason: 'managed_delivery' },
              subtitles: [
                {
                  value: 'torbox:0',
                  language: 'en',
                  name: 'English',
                  source: 'built-in',
                  delivery: 'torbox',
                  torboxTrack: 0,
                },
              ],
              torboxSubtitle: request.subtitleTrack ?? null,
            }
          : {}),
      },
    });
  });
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (r) =>
    r.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  for (const route of ['direct', 'remux'])
    await page.route(`${ORIGIN}/${route}/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(/\/playback\/(?:outcome|cast)$/, (r) => r.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/diagnostics/failure`, (r) => {
    asked.failures.push(r.request().postDataJSON());
    return r.fulfill({ status: 204 });
  });
  await page.route(`${CDN}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  await context.route('https://www.gstatic.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: sdk(sdkOptions) }),
  );
  await context.route(`${CAST}/**`, (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/') asked.castFrames += 1;
    return serveFile(r, path === '/' ? 'index.html' : path.slice(1), appId);
  });
  await page.goto(
    `${ORIGIN}/test/player.html?playback=/den/config/playback&next${subtitle ? '&subtitleLanguage=en' : ''}${query}`,
  );
  return { browser, page, asked };
}

const castFrame = (page) => page.frameLocator(`iframe[src^="${CAST}"]`);
const castButton = (page) => castFrame(page).locator('#cast');
const frameOf = (page) => page.frames().find((frame) => frame.url().startsWith(CAST));
const receiver = (page, what) => frameOf(page)?.evaluate((key) => window[key] ?? [], what) ?? [];

async function playingPast(page, seconds) {
  await page.waitForFunction(
    (s) => {
      const video = document.querySelector('.player video');
      return video && !video.paused && video.currentTime > s;
    },
    seconds,
    { timeout: 30_000 },
  );
  return page.evaluate(() => document.querySelector('.player video').currentTime);
}

async function reveal(page) {
  const box = await page.locator('.player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
}

/** The frame lies exactly over Den's button surface for Cast. */
async function frameOverSlot(page) {
  return page.evaluate((cast) => {
    const slot = document.querySelector('.cast-slot')?.getBoundingClientRect();
    const frame = document.querySelector(`iframe[src^="${cast}"]`)?.getBoundingClientRect();
    if (!slot || !frame) return null;
    const near = (a, b) => Math.abs(a - b) < 1;
    return (
      near(slot.left, frame.left) &&
      near(slot.top, frame.top) &&
      near(slot.width, frame.width) &&
      near(slot.height, frame.height) &&
      slot.width >= 44
    );
  }, CAST);
}

test('the Cast button appears only once a Chromecast is on the network', async () => {
  const { browser, page } = await open(chromium, { sdkOptions: { devices: false } });
  try {
    await playingPast(page, 2);
    await expect.poll(() => frameOf(page)?.evaluate(() => !!window.calls)).toBe(true);
    await reveal(page);
    // Discovery runs in the background: nothing to press, and nothing said, while there is no receiver.
    await expect(castButton(page)).toBeHidden();
    await expect(page.locator('.cast-slot')).toHaveCount(0);
    await expect(page.getByText(/Chromecast/)).toHaveCount(0);

    await frameOf(page).evaluate(() => window.__devices(true));
    await reveal(page);
    await expect(castButton(page)).toBeVisible();
    await expect(castButton(page)).toHaveAccessibleName('Cast to a TV');
    await expect.poll(() => frameOverSlot(page)).toBe(true);

    // The receiver goes away again: so does the button.
    await frameOf(page).evaluate(() => window.__devices(false));
    await expect(page.locator('.cast-slot')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('one tap opens Chrome’s device list, connects, and the TV plays from where the page was', async () => {
  const { browser, page, asked } = await open(chromium);
  try {
    await playingPast(page, 6);
    await reveal(page);
    await expect(castButton(page)).toBeVisible();
    await expect.poll(() => frameOverSlot(page)).toBe(true);
    // Recorded in the frame as it changes: connecting is brief.
    await frameOf(page).evaluate(() => {
      window.drawn = [];
      new MutationObserver(() => window.drawn.push(document.documentElement.dataset.cast)).observe(
        document.documentElement,
        { attributes: true, attributeFilter: ['data-cast'] },
      );
    });

    await castButton(page).click();
    // The press was the frame's own: Chrome's list opened at once, with no second button and no search first.
    await expect.poll(() => receiver(page, 'calls')).toContain('requestSession');
    await expect(page.getByText('Looking for a Chromecast…')).toHaveCount(0);
    await expect(castFrame(page).getByText('Choose your Chromecast')).toHaveCount(0);

    await expect.poll(() => receiver(page, 'loads')).toHaveLength(1);
    const [load] = await receiver(page, 'loads');
    expect(load.url).toBe(TORBOX);
    expect(load.currentTime).toBeGreaterThan(6);
    expect(asked.managed.at(-1)).toMatchObject({ player: 'cast' });
    expect(await frameOf(page).evaluate(() => window.drawn)).toEqual(
      expect.arrayContaining(['connecting', 'connected']),
    );
    // Connected: filled, and named for the TV it casts to; the stage shows where it plays.
    await expect(castButton(page)).toHaveAccessibleName('Casting to Living Room TV');
    await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
    await expect(page.locator('.player video')).toHaveCount(0);
    expect(asked.castFrames, 'the same cast page throughout').toBe(1);
    // One hand-off is one ask of Hearth and one LOAD on the receiver, and nothing ends it afterwards (2026-11-08: a
    // second ask and LOAD seconds later ended the Cast session and the TV went back to its home screen).
    await page.waitForTimeout(3_000);
    expect(asked.managed.filter((request) => request.player === 'cast')).toHaveLength(1);
    expect(await receiver(page, 'loads')).toHaveLength(1);
    expect(await receiver(page, 'calls')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(stop|leave)$/)]),
    );
    // With no `CAST_APP_ID` and no opt-in, Google's receiver, asked nothing on Den's namespace.
    expect(await frameOf(page).evaluate(() => window.appId)).toBe('CC1AD845');
  } finally {
    await browser.close();
  }
});

/** Cast from the bar, and what the one ask for the receiver said it plays. */
async function castOnce(page, asked) {
  await playingPast(page, 2);
  await reveal(page);
  await castButton(page).click();
  await expect.poll(() => receiver(page, 'loads')).toHaveLength(1);
  await page.waitForTimeout(1_500);
  const cast = asked.managed.filter((request) => request.player === 'cast');
  expect(cast, 'one ask').toHaveLength(1);
  expect(await receiver(page, 'loads'), 'one LOAD').toHaveLength(1);
  await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
  return cast[0];
}

/** The Cast menu, opened from the connected button: Stop casting, and the model list or not. */
async function castMenu(page) {
  await castButton(page).click();
  await expect(page.getByRole('menuitem', { name: 'Stop casting' })).toBeVisible();
  return page.getByRole('menuitemradio');
}

for (const [how, options] of [
  ['the box names Den’s receiver (CAST_APP_ID)', { appId: DEN_APP }],
  ['this browser opted in (?cast-receiver=den)', { query: '&cast-receiver=den' }],
]) {
  test(`when ${how}, Den asks with what the receiver says it plays, and no model is asked for`, async () => {
    const { browser, page, asked } = await open(chromium, {
      ...options,
      sdkOptions: { report: 'answer' },
    });
    try {
      const ask = await castOnce(page, asked);
      expect(await frameOf(page).evaluate(() => window.appId)).toBe(DEN_APP);
      expect(await frameOf(page).evaluate(() => window.sent)).toEqual([
        { ns: 'urn:x-cast:fi.oxy.den', message: { type: 'den-capabilities' } },
      ]);
      expect(ask.playable).toEqual(RECEIVER_PLAYABLE);
      const models = await castMenu(page);
      await expect(models).toHaveCount(0);
      await expect(page.getByText('Which Chromecast is it?')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
}

test('a Den receiver that does not answer within two seconds is asked as the chosen model, list and all', async () => {
  const { browser, page, asked } = await open(chromium, {
    appId: DEN_APP,
    sdkOptions: { report: 'silent' },
  });
  try {
    const ask = await castOnce(page, asked);
    expect(await frameOf(page).evaluate(() => window.sent)).toHaveLength(1);
    // Chromecast with Google TV (4K), the default model.
    expect(ask.playable).toMatchObject({ h264: 0x33, hevcMain: 153, hdr: true, eac3: false });
    const models = await castMenu(page);
    await expect(models).toHaveCount(6);
    await expect(page.getByText('Which Chromecast is it?')).toBeVisible();
  } finally {
    await browser.close();
  }
});

// The TorBox stream playing here carries its built-in subtitle burned in. Cast asked for the release alone, so Hearth
// handed over a stream without it, the player asked again for the one with it, and the receiver was sent a second
// LOAD seconds after the first (2026-11-08: the TV then went back to its home screen).
test('casting a TorBox stream with its built-in subtitle on is one ask and one LOAD, subtitle included', async () => {
  const { browser, page, asked } = await open(chromium, { subtitle: true });
  try {
    await expect.poll(() => asked.managed.length).toBe(2);
    expect(asked.managed[1]).toMatchObject({ subtitleTrack: 0 });
    await playingPast(page, 2);
    await reveal(page);
    await castButton(page).click();
    await expect.poll(() => receiver(page, 'loads')).toHaveLength(1);
    await page.waitForTimeout(3_000);
    const cast = asked.managed.filter((request) => request.player === 'cast');
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({ filename: 'fixture.mkv', subtitleTrack: 0 });
    expect(await receiver(page, 'loads')).toHaveLength(1);
    expect(await receiver(page, 'calls')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(stop|leave)$/)]),
    );
  } finally {
    await browser.close();
  }
});

// The media a replacement LOAD interrupts reports once more while that LOAD is answered. That tick ended the cast page's
// note that a replacement was under way, so the INTERRUPTED after it read as the viewer stopping, and the Cast session
// was ended.
test('a replacement LOAD on the receiver never ends the Cast session', async () => {
  const { browser, page } = await open(chromium, { sdkOptions: { interrupt: true } });
  try {
    await playingPast(page, 2);
    await reveal(page);
    await castButton(page).click();
    await expect.poll(() => receiver(page, 'loads')).toHaveLength(1);
    await page.waitForTimeout(500);
    await page.evaluate(
      ([cast, url]) =>
        document.querySelector(`iframe[src^="${cast}"]`).contentWindow.postMessage(
          {
            type: 'den-load',
            id: `${url}&replacement`,
            media: { url: `${url}&replacement`, mode: 'cast', title: 'Fixture', external: true },
          },
          cast,
        ),
      [CAST, TORBOX],
    );
    await expect.poll(() => receiver(page, 'loads')).toHaveLength(2);
    await page.waitForTimeout(1_000);
    expect(await receiver(page, 'calls')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(stop|leave)$/)]),
    );
    await expect(page.locator('.player video')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// A TorBox stream stays TorBox: Den Remux only when the viewer picks it. One fresh TorBox stream is tried on the
// receiver, then the viewer is told and it plays here again, with the Cast session left for Stop casting.
test('a TorBox stream the receiver won’t load is retried once as TorBox, named, and never remuxed', async () => {
  const { browser, page, asked } = await open(chromium, {
    sdkOptions: { refuse: true },
    freshUrls: true,
  });
  try {
    await playingPast(page, 2);
    await reveal(page);
    await castButton(page).click();
    await expect(
      page.getByText(
        'The Chromecast couldn’t play this TorBox release, so it’s playing here again.',
      ),
    ).toBeVisible({ timeout: 15_000 });
    expect(await receiver(page, 'loads')).toHaveLength(2);
    const cast = asked.managed.filter((request) => request.player === 'cast');
    expect(cast).toHaveLength(2);
    expect(asked.managed.some((request) => request.directFailed)).toBe(false);
    expect(await receiver(page, 'calls')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(stop|leave)$/)]),
    );
    await playingPast(page, 0);
  } finally {
    await browser.close();
  }
});

test('Den’s transport drives the receiver, and Stop casting resumes here at its position', async () => {
  const { browser, page, asked } = await open(chromium);
  try {
    await playingPast(page, 3);
    await reveal(page);
    await castButton(page).click();
    await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
    const transport = page.getByRole('navigation', { name: 'Playback controls' });
    await expect(transport).toBeVisible();

    await transport.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => receiver(page, 'calls')).toContain('pause');
    await expect(transport.getByRole('button', { name: 'Play' })).toBeVisible();
    await transport.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => receiver(page, 'calls')).toContain('play');

    const before = await frameOf(page).evaluate(
      () => window.cast.framework.RemotePlayer().currentTime,
    );
    await transport.getByRole('button', { name: 'Forward 10 seconds' }).click();
    await expect
      .poll(async () =>
        (await receiver(page, 'calls')).some(
          (call) => call.startsWith('seek:') && Number(call.slice(5)) >= Math.floor(before) + 9,
        ),
      )
      .toBe(true);
    await transport.getByRole('button', { name: 'Mute' }).click();
    await expect.poll(() => receiver(page, 'calls')).toContain('mute');
    await transport.getByLabel('Volume').fill('0.5');
    await expect.poll(() => receiver(page, 'calls')).toContain('volume:0.5');

    // Pressed while connected, the Cast button offers Stop casting.
    await castButton(page).click();
    const stop = page.getByRole('menuitem', { name: 'Stop casting' });
    await expect(stop).toBeVisible();
    const at = await frameOf(page).evaluate(() => window.cast.framework.RemotePlayer().currentTime);
    await stop.click();
    await expect.poll(() => receiver(page, 'calls')).toContain('stop');

    // Back in this page, from the second the receiver had got to.
    await expect.poll(() => asked.managed.length).toBe(3);
    expect(asked.managed[2].player).not.toBe('cast');
    expect(asked.managed[2].startAt).toBeGreaterThanOrEqual(Math.floor(at) - 1);
    await playingPast(page, Math.floor(at) - 1);
    await expect(castButton(page)).toHaveAccessibleName('Cast to a TV');
    expect(asked.castFrames, 'the button is the same cast page').toBe(1);
  } finally {
    await browser.close();
  }
});

for (const [connect, says] of [
  ['fail', 'Couldn’t connect to the Chromecast. Press Cast to try again.'],
  ['gone', /^No Chromecast found on this network/],
]) {
  test(`a session that does not start (${connect}) says so in plain words, and playback carries on`, async () => {
    const { browser, page, asked } = await open(chromium, { sdkOptions: { connect } });
    try {
      const before = await playingPast(page, 2);
      await page.locator('.player video').evaluate((v) => (v.dataset.before = 'cast'));
      await reveal(page);
      await castButton(page).click();
      await expect(page.getByText(says)).toBeVisible();
      // Never silently stopped: the same element, still going.
      const video = page.locator('.player video[data-before="cast"]');
      await expect(video).toHaveCount(1);
      await expect
        .poll(() => video.evaluate((v) => (v.paused ? -1 : v.currentTime)))
        .toBeGreaterThan(before + 1);
      expect(asked.managed).toHaveLength(1);
      // The same failure reporter as every Cast failure.
      // The reporter is loaded on the first failure, which the dev server compiles only then.
      await expect
        .poll(() => asked.failures, { timeout: 15_000 })
        .toContainEqual(expect.objectContaining({ operation: 'cast', route: 'cast_receiver' }));
      // The retry is the Cast button itself, which still opens the list.
      await expect(castButton(page)).toHaveAccessibleName('Cast to a TV');
    } finally {
      await browser.close();
    }
  });
}

test('the keyboard reaches the Cast button in the bar, and Tab leaves it to the bar’s next control', async () => {
  const { browser, page } = await open(chromium);
  try {
    await playingPast(page, 2);
    await reveal(page);
    await expect(castButton(page)).toBeVisible();
    const before = page.getByRole('button', { name: 'Play from beginning' });
    await before.focus();
    await page.keyboard.press('Tab');
    await expect(castButton(page)).toBeFocused();
    // Den's own ring, on Den's surface.
    await expect(page.locator('.cast-slot')).toHaveClass(/cast-focused/);
    await page.keyboard.press('Shift+Tab');
    await expect(before).toBeFocused();
    await expect(page.locator('.cast-slot')).not.toHaveClass(/cast-focused/);
    await page.keyboard.press('Tab');
    await expect(castButton(page)).toBeFocused();
    // Forward out of the frame lands on a control of the player, not at the end of the document.
    await page.keyboard.press('Tab');
    await expect(castButton(page)).not.toBeFocused();
    expect(
      await page.evaluate(
        () =>
          !!document.activeElement?.closest('.player') &&
          document.activeElement?.tagName !== 'IFRAME',
      ),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(castButton(page)).toBeFocused();
    // Enter is a press too: Chrome's list opens from the keyboard.
    await page.keyboard.press('Enter');
    await expect.poll(() => receiver(page, 'calls')).toContain('requestSession');
    await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('on an Android phone the one tap casts, and Den’s transport is the remote', async () => {
  const { browser, page } = await open(chromium, {
    userAgent: CHROME_ANDROID,
    viewport: { width: 412, height: 915 },
    mobile: true,
  });
  try {
    await playingPast(page, 2);
    await expect(castButton(page)).toBeVisible();
    await expect.poll(() => frameOverSlot(page)).toBe(true);
    await castButton(page).tap();
    await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
    const transport = page.getByRole('navigation', { name: 'Playback controls' });
    await expect(transport).toBeVisible();
    await transport.getByRole('button', { name: 'Pause' }).tap();
    await expect.poll(() => receiver(page, 'calls')).toContain('pause');
  } finally {
    await browser.close();
  }
});

for (const [engine, browserType] of [
  ['Firefox', firefox],
  ['WebKit', webkit],
]) {
  test(`${engine} has no Cast sender: no cast page, no Cast button`, async () => {
    test.skip(!existsSync(browserType.executablePath()), `${engine} is not installed here`);
    const { browser, page, asked } = await open(browserType, { userAgent: null });
    try {
      // As every flow here waits for playback: a freshly launched Firefox or WebKit on a busy runner takes longer than
      // `expect.poll`'s default five seconds to start, which failed this case with the video playing at 0.6 s.
      await playingPast(page, 1);
      await reveal(page);
      await expect(page.locator('.cast-slot')).toHaveCount(0);
      await expect(page.locator(`iframe[src^="${CAST}"]`)).toHaveCount(0);
      expect(asked.castFrames).toBe(0);
    } finally {
      await browser.close();
    }
  });
}
