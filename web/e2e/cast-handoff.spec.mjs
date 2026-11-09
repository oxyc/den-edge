// Casting from a title already playing in the page: the real player and the real built cast page, with a stub of
// Google's Cast SDK standing in for Chrome's device list and the receiver.
//
// On the first Chromecast tried for real, pressing "Cast to a TV" stopped the TorBox stream playing in the page,
// asked Hearth again as a first-generation Chromecast (so a Remux session of another release came back), and left a
// cast page that loaded nothing until Google's own button inside it was pressed — a button that was not showing.
// What casting should do: keep the video playing until a receiver is actually chosen, ask for what that receiver
// plays only then, and hand it the delivery that was playing when it can take it.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const MEDIA = 'https://media.test';
const LAN = 'https://lan.test:8449';
const SID = 'AbCdEfGhIjKlMnOpQrStUv';
const SIG = 'sIgNaTuReSiGnAtUrE0123';
const PATH = `/remux/s/${SID}/${SIG}`;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));

async function serveHls(route, emptyStatus = 200) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
  if (request.method() !== 'GET' || !file?.match(/^(?:media\.m3u8|init\.mp4|seg\d+\.m4s)$/))
    return route.fulfill({ status: emptyStatus, headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({
    contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    headers: { 'access-control-allow-origin': '*' },
    body: await readFile(new URL(file, hls)),
  });
}

/**
 * Google's sender as the cast page sees it: one receiver on the network once discovery starts, and a Cast session
 * that starts when `requestSession` is called — which only a press inside the cast page may do. Every LOAD the
 * receiver is sent is kept in `window.loads`; with `hang`, the receiver never answers one.
 */
const sdk = (hang, idleFirst = false) => `
  window.loads = [];
  window.endedSessions = 0;
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
  let state = 'NO_DEVICES_AVAILABLE';
  let session = null;
  const context = {
    setOptions() {
      setTimeout(() => { state = 'NOT_CONNECTED'; fire('caststatechanged', { castState: state }); }, 50);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getCurrentSession() { return session; },
    getCastState() { return state; },
    endCurrentSession() { window.endedSessions += 1; session = null; },
    requestSession() {
      if (!navigator.userActivation.isActive) return Promise.reject('no user activation');
      session = {
        loadMedia(request) {
          window.loads.push({
            url: request.media.contentId,
            segments: request.media.hlsSegmentFormat,
            videoSegments: request.media.hlsVideoSegmentFormat,
            currentTime: request.currentTime,
            tracks: request.media.tracks,
            activeTrackIds: request.activeTrackIds,
          });
          if (${hang}) return new Promise(() => {});
          // A real receiver: the load is accepted while RemotePlayer still says IDLE and no media status has come in,
          // then it reports playing.
          if (${idleFirst})
            setTimeout(() => {
              window.remoteChange?.();
              setTimeout(() => {
                Object.assign(window.remotePlayer, { playerState: 'PLAYING', duration: 100, currentTime: 1 });
                window.remoteChange?.();
              }, 200);
            }, 0);
          return Promise.resolve();
        },
        getMediaSession() { return null; },
        getCastDevice() { return { friendlyName: 'Living Room TV' }; },
      };
      state = 'CONNECTED';
      setTimeout(() => fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' }), 0);
      return Promise.resolve();
    },
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => context },
    CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged', CAST_STATE_CHANGED: 'caststatechanged' },
    RemotePlayer: function () {
      window.remotePlayer = this;
      Object.assign(this, { playerState: 'IDLE', currentTime: 0, duration: 0, isPaused: false });
    },
    RemotePlayerController: function () {
      this.addEventListener = (type, fn) => { window.remoteChange = fn; };
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
  built = mkdtempSync(join(tmpdir(), 'den-cast-handoff-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
    stdio: 'ignore',
  });
});
test.afterAll(() => rmSync(built, { recursive: true, force: true }));

/** Hearth's Remux answer, as it sends one: the public playlist outside, the home-network base beside it. */
const remuxAnswer = {
  url: `${MEDIA}${PATH}/master.m3u8`,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  publicBase: MEDIA,
  lanBase: LAN,
  castOrigin: CAST,
  session: {
    id: SID,
    duration: 60,
    video: { codec: 'h264', transcoded: false },
    audioTrack: 0,
    audioTracks: [],
    endUrl: PATH,
    heartbeatUrl: `${PATH}/heartbeat`,
    reportUrl: `${PATH}/report`,
  },
};

/**
 * The player playing a title through Hearth, TorBox's managed HLS in the page. `castAnswer` is what Hearth answers
 * the request made for a receiver.
 */
/** How long the player gives a session moved to the cast page to start playing, shortened for these tests. */
const CAST_PLAY_MS = 1_500;

async function open({
  castAnswer,
  initialAnswer = {
    url: TORBOX,
    release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
  },
  hang = false,
  idleFirst = false,
  subtitle = false,
  clock = false,
}) {
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
  const asked = { managed: [], castReports: [], lanProbes: [], subtitles: [] };
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/den/config/playback`, (r) => {
    const request = r.request().postDataJSON();
    asked.managed.push(request);
    if (request.player === 'cast')
      return typeof castAnswer === 'function'
        ? castAnswer(r, request)
        : r.fulfill({ json: castAnswer });
    return r.fulfill({ json: initialAnswer });
  });
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (r) => {
    asked.subtitles.push(r.request().url());
    return subtitle
      ? r.fulfill({
          json: { subtitles: [{ lang: 'en', url: '/den/config/subtitle/1.srt' }] },
        })
      : r.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route(`${ORIGIN}/den/config/subtitle/1.srt`, (r) => {
    asked.subtitles.push(r.request().url());
    return r.fulfill({ body: '1\n00:00:01,000 --> 00:00:02,000\nHello!\n' });
  });
  await page.route(`${ORIGIN}/den/config/cast-subtitle`, (r) => {
    asked.subtitles.push(r.request().url());
    return r.fulfill({
      status: 201,
      json: { url: `${CAST}/subtitle/${'a'.repeat(64)}.vtt` },
    });
  });
  // The release list, on the page's own route and, once casting, on the relay's.
  for (const route of ['direct', 'remux'])
    await page.route(`${ORIGIN}/${route}/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/playback/outcome`, (r) => r.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/playback/cast`, (r) => {
    asked.castReports.push(r.request().postDataJSON());
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
  // The session's public listener serves the initial Remux fixture and answers its session bookkeeping.
  await page.route(`${MEDIA}/**`, (r) => serveHls(r, r.request().method() === 'GET' ? 200 : 204));
  // At home: the player's page reaches den-remux's home-network address, but the browser keeps the cross-origin
  // cast page off the local network.
  await page.route(`${LAN}/**`, async (r) => {
    const request = r.request();
    const fromCastPage = request.frame().url().startsWith(CAST);
    asked.lanProbes.push(fromCastPage ? 'cast page' : 'player');
    if (fromCastPage) return r.abort('addressunreachable');
    return serveHls(r);
  });
  await context.route('https://www.gstatic.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: sdk(hang, idleFirst) }),
  );
  await context.route(`${CAST}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const type = file.endsWith('.html')
      ? 'text/html'
      : file.endsWith('.js')
        ? 'text/javascript'
        : 'text/css';
    // A request still on its way when the test ends may find the build removed: refused, not thrown into the next test.
    const body = await readFile(join(built, file)).catch(() => undefined);
    return body ? r.fulfill({ contentType: type, body }) : r.abort().catch(() => undefined);
  });
  const query = new URLSearchParams({
    playback: '/den/config/playback',
    castPlayMs: String(CAST_PLAY_MS),
  });
  if (subtitle) query.set('subtitleLanguage', 'en');
  if (clock) await page.clock.install();
  await page.goto(`${ORIGIN}/test/player.html?${query}`);
  return { browser, page, asked };
}

const castFrame = (page) => page.frameLocator(`iframe[src^="${CAST}"]`);
async function castLoads(page) {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(CAST));
  if (!frame) return [];
  try {
    return (await frame.evaluate(() => window.loads)) ?? [];
  } catch (error) {
    if (
      frame.isDetached() ||
      /Frame was detached|Execution context was destroyed/.test(String(error))
    )
      return [];
    throw error;
  }
}

/** Wait for the in-page video to be past `seconds`. */
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

/** Move over the picture as a viewer does before pressing chrome that has auto-hidden while they watched. */
async function revealPlayerControls(page) {
  const box = await page.locator('.player').boundingBox();
  if (!box) throw new Error('player has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(50);
}

/** Press the Cast button, which is the cast page's own, shown in the bar once it has found the receiver. */
async function chooseReceiver(page, asked) {
  await revealPlayerControls(page);
  const cast = castFrame(page).getByRole('button', { name: 'Cast to a TV' });
  await expect(cast).toBeVisible({ timeout: 15_000 });
  // Offered, not chosen: what was playing plays on, and nothing new was asked of Hearth.
  const offeredAt = await playingPast(page, 0);
  await playingPast(page, offeredAt + 1);
  expect(asked.managed).toHaveLength(1);
  await cast.click();
}

test('casting keeps TorBox playing until a Chromecast is chosen, then hands that stream to it', async () => {
  const { browser, page, asked } = await open({
    castAnswer: {
      url: TORBOX,
      release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
    },
  });
  try {
    // Past the first five seconds, under which a start position is not carried.
    await playingPast(page, 6);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    await chooseReceiver(page, asked);

    await expect.poll(() => asked.managed.length).toBe(2);
    const cast = asked.managed[1];
    expect(cast).toMatchObject({ player: 'cast', filename: 'fixture.mkv' });
    expect(cast).not.toHaveProperty('directFailed');
    // Asked as the receiver most households now have, not as a first-generation stick: HEVC and HDR included.
    expect(cast.playable.hevcMain10).toBeGreaterThan(0);
    expect(cast.playable.hdr).toBe(true);

    await expect.poll(() => castLoads(page)).toHaveLength(1);
    const [load] = await castLoads(page);
    expect(load.url).toBe(TORBOX);
    // TorBox's playlist is MPEG-TS: told FMP4, a receiver cannot parse it.
    expect(load).toMatchObject({ segments: 'ts', videoSegments: 'mpeg2_ts' });
    // From where the page had got to.
    expect(load.currentTime).toBeGreaterThan(6);
    // The receiver has it now: the page's own video is gone, and the player says where it plays.
    await expect(page.locator('.player video')).toHaveCount(0);
    await expect(page.getByText('Casting to Living Room TV')).toBeVisible();
  } finally {
    await browser.close();
  }
});

// Reported 2026-11-08 (den-edge 0.271.209): Hearth accepted a TorBox release for the receiver, the cast page loaded
// it, and within a second the TV quit Default Media Receiver for its home screen while the page said "Returning
// here". The receiver accepts a load before its first media status, so RemotePlayer still reads IDLE with no
// idleReason; that was taken for a stop, which ended the Cast session.
test('a receiver that has not yet reported on an accepted load keeps its Cast session', async () => {
  const { browser, page, asked } = await open({
    idleFirst: true,
    castAnswer: {
      url: TORBOX,
      release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
    },
  });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    await page.waitForTimeout(1_000);
    const frame = page.frames().find((candidate) => candidate.url().startsWith(CAST));
    expect(await frame.evaluate(() => window.endedSessions)).toBe(0);
    // Nothing asked of Hearth after the receiver's own: no return to this page, no second cast.
    expect(asked.managed.map((request) => request.player)).toEqual(['hls.js', 'cast']);
    await expect(page.locator('.player video')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// A release the receiver can't take is asked for once more with none named, and Hearth's pick is cast instead
// (2026-11-09: a 4K HEVC release, which no Cast receiver plays from TorBox's MPEG-TS).
test('a release the receiver can’t take is replaced by one it can, picked by Hearth', async () => {
  const { browser, page, asked } = await open({
    castAnswer: (r, request) =>
      request.filename
        ? r.fulfill({
            status: 409,
            json: { error: 'direct_unavailable', cause: 'torbox_receiver_unsupported' },
          })
        : r.fulfill({
            json: {
              url: `${TORBOX}&h264`,
              release: { label: 'Fixture 1080p', filename: 'fixture-1080p.mkv', size: 1 },
            },
          }),
  });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    expect(asked.managed.slice(1)).toMatchObject([
      { player: 'cast', filename: 'fixture.mkv' },
      { player: 'cast' },
    ]);
    expect(asked.managed[2].filename).toBeUndefined();
    expect((await castLoads(page))[0].url).toContain('&h264');
  } finally {
    await browser.close();
  }
});

// A TorBox stream is cast as TorBox only: Den Remux is used only when the viewer picks it, since it is not a usable
// path to a Chromecast for remote households. Hearth's refusal is named, and nothing is remuxed in its place.
test('a TorBox stream the receiver can’t take is refused and named, never cast through Remux', async () => {
  const { browser, page, asked } = await open({
    castAnswer: (r, request) =>
      request.directOnly
        ? r.fulfill({
            status: 409,
            json: { error: 'direct_unavailable', cause: 'torbox_receiver_unsupported' },
          })
        : r.fulfill({
            json: { ...remuxAnswer, degraded: true, directFailure: 'torbox_receiver_unsupported' },
          }),
  });
  try {
    await playingPast(page, 2);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    await chooseReceiver(page, asked);

    // The release playing, then the best one the receiver can take: neither, here.
    await expect.poll(() => asked.managed.length).toBe(3);
    expect(asked.managed[1]).toMatchObject({ player: 'cast', filename: 'fixture.mkv' });
    expect(asked.managed[1]).toHaveProperty('directOnly');
    expect(asked.managed[2]).toMatchObject({ player: 'cast' });
    expect(asked.managed[2].filename).toBeUndefined();
    await expect(
      page.getByText('The Chromecast can’t play this release as TorBox streams it'),
    ).toBeVisible();
    await page.waitForTimeout(CAST_PLAY_MS * 2);
    expect(await castLoads(page)).toHaveLength(0);
    expect(asked.managed).toHaveLength(3);
  } finally {
    await browser.close();
  }
});

// Reported 2026-11-08 on Den Remux with a subtitle on: the page asked Hearth again and again (cast, here, cast, …)
// and the TV never played. A handoff is one ask for the receiver, and none after it.
test('casting a Remux session with a subtitle on asks Hearth once for the receiver, and no more', async () => {
  const { browser, page, asked } = await open({
    initialAnswer: remuxAnswer,
    castAnswer: remuxAnswer,
    subtitle: true,
  });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    await page.waitForTimeout(CAST_PLAY_MS * 2);
    expect(asked.managed.map((request) => request.player)).toEqual(['hls.js', 'cast']);
    expect(await castLoads(page)).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('a selected OpenSubtitles track stays on TorBox and is handed to Chromecast as WebVTT', async () => {
  const castAnswer = {
    url: TORBOX,
    release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
  };
  const { browser, page, asked } = await open({ castAnswer, subtitle: true });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    expect(asked.managed[1]).not.toHaveProperty('directFailed');
    const [load] = await castLoads(page);
    expect(load.url).toBe(TORBOX);
    expect(load.activeTrackIds).toEqual([1]);
    expect(load.tracks).toEqual([
      expect.objectContaining({
        trackId: 1,
        type: 'TEXT',
        subtype: 'SUBTITLES',
        language: 'en',
        trackContentType: 'text/vtt',
        trackContentId: `${CAST}/subtitle/${'a'.repeat(64)}.vtt`,
      }),
    ]);
    expect(asked.subtitles.filter((url) => url.endsWith('/cast-subtitle'))).toHaveLength(2);
  } finally {
    await browser.close();
  }
});

test('at home a Remux session reaches the receiver on the home-network address the player reached', async () => {
  const { browser, page, asked } = await open({
    initialAnswer: remuxAnswer,
    castAnswer: remuxAnswer,
  });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    const [load] = await castLoads(page);
    // The receiver is on the home network: it is handed the home address, which the router does not need to loop.
    expect(load.url).toBe(`${LAN}${PATH}/master.m3u8`);
    expect(load).toMatchObject({ segments: 'fmp4', videoSegments: 'fmp4' });
    expect(asked.lanProbes).toContain('player');
    expect(asked.lanProbes, 'the cast page was not asked to prove it').not.toContain('cast page');
  } finally {
    await browser.close();
  }
});

test('a receiver that never starts is reported as a Cast session failure, not an unreachable home network', async () => {
  const { browser, page, asked } = await open({
    castAnswer: {
      url: TORBOX,
      release: { label: 'Fixture 2160p', filename: 'fixture.mkv', size: 1 },
    },
    hang: true,
    // The wait for the receiver to start is the player's own timer (`castPlayMs`): the test moves the clock past it.
    clock: true,
  });
  try {
    await playingPast(page, 2);
    await chooseReceiver(page, asked);
    await expect.poll(() => castLoads(page)).toHaveLength(1);
    // Past the (shortened) wait for the receiver to start, then closed: the visit's cast report goes.
    await page.clock.fastForward(CAST_PLAY_MS);
    await revealPlayerControls(page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => asked.castReports).toHaveLength(1);
    expect(asked.castReports[0]).toMatchObject({
      kind: 'chromecast',
      reached: 'attempted',
      failed: true,
      failReason: 'session_error',
    });
  } finally {
    await browser.close();
  }
});
