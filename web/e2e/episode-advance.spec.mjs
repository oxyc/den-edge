// The next episode, through the real Library and Player: a series' episode played to its end advances to the next one
// in the same player. A viewer casting Chrome's tab to a Chromecast lost the "optimized for video" mode at every
// advance: Chrome remotes only a `<video>` element that stays fullscreen, and the Library remounted the player — and
// its video — for each episode. The video, its fullscreen and a Den Cast receiver now carry on into the next episode,
// while everything about the episode itself (progress, release, heading) is the next one's.
import { test, expect, chromium, webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeBigTmdb } from './big-library.mjs';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';

const SERIES = 2002;
const FILM = 1001;
const HEARTH = { install: `${ORIGIN}/den/hearthcfg/manifest.json`, base: '/den/hearthcfg' };
const ROUTES = { v: 1, addons: { den: [{ url: `${ORIGIN}/den` }] } };
const CDN = 'https://video.eu.tb-cdn.io';
const CAST = 'https://cast.test';
const DIRECT = `${ORIGIN}/direct`;
const PUBLIC = 'https://media.test';
const LAN = 'https://lan.test:8449';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));

/** TorBox's managed HLS for `item` (`e1`, `e2`, `film`): what Hearth hands the browser, and the receiver. */
const streamOf = (item) => `${CDN}/${item}/master.m3u8?scrobbling_enabled=false`;
const itemOf = (body) => (body.season === undefined ? 'film' : `e${body.episode}`);

/**
 * Google's sender as the cast page sees it (`cast-handoff.spec.mjs`), with a receiver that can be told to finish what
 * it plays: `window.finishReceiver()` reports the media session idle with FINISHED, as a receiver at an episode's end.
 */
const sdk = `
  window.loads = [];
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      HlsSegmentFormat: { FMP4: 'fmp4', TS: 'ts' },
      HlsVideoSegmentFormat: { FMP4: 'fmp4', MPEG2_TS: 'mpeg2_ts' },
      MetadataType: { GENERIC: 0 },
      StreamType: { BUFFERED: 'BUFFERED' },
      GenericMediaMetadata: function () {},
      MediaInfo: function (url, contentType) { this.contentId = url; this.contentType = contentType; },
      LoadRequest: function (media) { this.media = media; },
      EditTracksInfoRequest: function (ids) { this.activeTrackIds = ids; },
    },
  };
  const listeners = {};
  const fire = (type, event) => (listeners[type] || []).forEach((fn) => fn(event));
  let state = 'NO_DEVICES_AVAILABLE';
  let session = null;
  let idleReason = null;
  const remote = { playerState: 'IDLE', currentTime: 0, duration: 0, isPaused: false };
  const changed = [];
  window.finishReceiver = () => {
    remote.playerState = 'IDLE';
    idleReason = 'FINISHED';
    changed.forEach((fn) => fn());
  };
  const context = {
    setOptions() {
      setTimeout(() => { state = 'NOT_CONNECTED'; fire('caststatechanged', { castState: state }); }, 50);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getCurrentSession() { return session; },
    getCastState() { return state; },
    endCurrentSession() { session = null; },
    requestSession() {
      if (!navigator.userActivation.isActive) return Promise.reject('no user activation');
      session = {
        loadMedia(request) {
          window.loads.push({ url: request.media.contentId, title: request.media.metadata?.subtitle });
          idleReason = null;
          Object.assign(remote, { playerState: 'PLAYING', currentTime: 1, duration: 60 });
          setTimeout(() => changed.forEach((fn) => fn()), 0);
          return Promise.resolve();
        },
        getMediaSession() { return idleReason ? { idleReason } : null; },
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
    RemotePlayer: function () { return remote; },
    RemotePlayerController: function () { this.addEventListener = (type, fn) => changed.push(fn); },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  } };
  const announce = setInterval(() => {
    if (!window.__onGCastApiAvailable) return;
    clearInterval(announce);
    window.__onGCastApiAvailable(true);
  }, 10);
`;

/** TorBox's managed HLS for what `body` asks: Hearth's answer for an install with a TorBox key. */
const torboxAnswer = (body) => {
  const item = itemOf(body);
  return {
    url: streamOf(item),
    release: { label: `${item} 1080p`, filename: `${item}.mkv`, size: 1 },
  };
};

/**
 * Hearth's Den Remux answer for episode `n`, away from home: the playlist on the public listener, which the cast page
 * plays in its frame, and a home-network address that does not answer here. Each episode its own session.
 */
const remuxAnswer = (body) => {
  const sid = `AbCdEfGhIjKlMnOpQrStE${body.episode}`;
  const path = `/remux/s/${sid}/sIgNaTuReSiGnAtUrE0123`;
  return {
    url: `${PUBLIC}${path}/master.m3u8`,
    release: { label: `e${body.episode} 1080p`, filename: `e${body.episode}.mkv`, size: 1 },
    publicBase: PUBLIC,
    lanBase: LAN,
    castOrigin: CAST,
    session: {
      id: sid,
      duration: 60,
      video: { codec: 'h264', transcoded: false },
      audioTrack: 0,
      audioTracks: [],
      endUrl: path,
      heartbeatUrl: `${path}/heartbeat`,
      reportUrl: `${path}/report`,
    },
  };
};

/** One of the fixture's HLS files, by the name a playlist or segment request ends in. */
async function serveHls(route) {
  const name = new URL(route.request().url()).pathname.split('/').pop();
  const file = name === 'master.m3u8' ? 'media.m3u8' : name;
  if (!/\.(m3u8|mp4|m4s)$/.test(file)) return route.fulfill({ status: 204 });
  return route.fulfill({
    headers: {
      'access-control-allow-origin': '*',
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    },
    body: await readFile(new URL(file, hls)),
  });
}

/**
 * The Library on a series' page, its library listing Den Hearth, whose playback gives `answer` for each request — by
 * default TorBox's managed HLS of the episode asked for. With `cast` (the built cast page's directory) the page is
 * desktop Chrome's, on a direct den-remux route, with Google's sender stubbed. `asked.playback` is every playback
 * request's body; `asked.media` every media path fetched.
 */
async function open(browserType, { cast, answer = torboxAnswer } = {}) {
  const browser = await browserType.launch(
    browserType === chromium
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ['--autoplay-policy=no-user-gesture-required'],
        }
      : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(cast ? { userAgent: CHROME_MAC } : {}),
  });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeBigTmdb(page);
  // The IMDb id Den's sources are asked by, which the player looks up on its own.
  await page.route('**/tmdb/3/*/*/external_ids', (r) =>
    r.fulfill({ json: { imdb_id: 'tt0002002' } }),
  );
  const asked = { playback: [], media: [] };
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404, body: '' }));
  // Casting is offered from a page on a direct den-remux route, as at home: Den Remux there answers its health.
  await page.route('**/routes', (r) =>
    r.fulfill({
      json: cast ? { ...ROUTES, addons: { ...ROUTES.addons, remux: [{ url: DIRECT }] } } : ROUTES,
    }),
  );
  await page.route(`${DIRECT}/health`, (r) => r.fulfill({ json: { status: 'ok' } }));
  await page.route(`${DIRECT}/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/config`, (r) =>
    r.fulfill({ json: cast ? { castOrigin: CAST } : {} }),
  );
  await page.route(`${ORIGIN}${HEARTH.base}/**`, (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (path === `${HEARTH.base}/manifest.json`)
      return r.fulfill({ json: { id: 'com.den.hearth', version: '1.0.0', resources: ['stream'] } });
    if (path === `${HEARTH.base}/playback` && request.method() === 'OPTIONS')
      return r.fulfill({ status: 204 });
    if (path === `${HEARTH.base}/playback`) {
      const body = request.postDataJSON();
      asked.playback.push(body);
      return r.fulfill({ json: answer(body) });
    }
    return r.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route(`${ORIGIN}/remux/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (r) => r.fulfill({ status: 204 }));
  // Media is fetched by the page and by the cast page's frame alike.
  for (const host of [CDN, PUBLIC])
    await context.route(`${host}/**`, (r) => {
      asked.media.push(new URL(r.request().url()).pathname);
      return serveHls(r);
    });
  await context.route(`${LAN}/**`, (r) => r.abort('addressunreachable'));
  if (cast) {
    await context.route('https://www.gstatic.com/**', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: sdk }),
    );
    await context.route(`${CAST}/**`, async (r) => {
      const path = new URL(r.request().url()).pathname;
      const file = path === '/' ? 'index.html' : path.slice(1);
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : 'text/css';
      return r.fulfill({ contentType: type, body: await readFile(join(cast, file)) });
    });
  }
  const query = new URLSearchParams({
    page: 'title',
    type: 'tv',
    id: String(SERIES),
    plugin: HEARTH.install,
  });
  query.set('local', '');
  query.set('services', '');
  query.set('address', '');
  await page.goto(`${ORIGIN}/test/library.html?${query}`);
  return { browser, page, asked };
}

const player = (page) => page.locator('.player');
const pageVideo = (page) => page.locator('.player video');

/** The page's video playing past `seconds`. */
async function playingPast(page, seconds) {
  await expect
    .poll(() => pageVideo(page).evaluate((v) => (v.paused ? -1 : v.currentTime)), {
      timeout: 30_000,
    })
    .toBeGreaterThan(seconds);
}

/** The progress the library holds for `episode` of season 1 (`value` its fraction); null where it holds none. */
const progressOf = (page, episode) =>
  page.evaluate(
    ([series, episode]) => {
      const row = window
        .denTestRows()
        .find(
          (row) =>
            row.kind === 'ep' &&
            row.title.id === series &&
            row.season === 1 &&
            row.episode === episode,
        );
      return row ? JSON.parse(JSON.stringify(row.progress)) : null;
    },
    [SERIES, episode],
  );

/** Play the series from its page: Season 1's first episode. */
async function playFirstEpisode(page) {
  await page.getByRole('link', { name: /^Play/ }).first().click();
  await expect(player(page)).toHaveAttribute('aria-label', `Series ${SERIES} · S1 · E1`);
  await expect(page).toHaveURL(`${ORIGIN}/tv/${SERIES}-series-${SERIES}?season=1&episode=1&play=1`);
  await expect(player(page).getByRole('link', { name: 'Next: S1 · E2' })).toHaveAttribute(
    'href',
    `/tv/${SERIES}-series-${SERIES}?season=1&episode=2&play=1`,
  );
}

/** Put the playing video into element fullscreen, from a key press: the user activation fullscreen needs. */
async function enterFullscreen(page) {
  await page.evaluate(() => {
    const video = document.querySelector('.player video');
    // The element itself, tagged, so the one fullscreen after the advance can be told to be this very one.
    video.dataset.advanceMarker = 'episode-1';
    window.__episodeOneVideo = video;
    document.addEventListener('keydown', () => void video.requestFullscreen(), { once: true });
  });
  await page.keyboard.press('F9');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === window.__episodeOneVideo))
    .toBe(true);
}

for (const [name, browserType, available] of [
  ['Chromium (hls.js)', chromium, true],
  ['WebKit (native HLS)', webkit, existsSync(webkit.executablePath())],
]) {
  test(`the next episode plays in the same fullscreen video, reported as itself, on ${name}`, async () => {
    test.skip(!available, `${name} is not installed here`);
    const { browser, page, asked } = await open(browserType);
    try {
      await playFirstEpisode(page);
      await playingPast(page, 1);
      await enterFullscreen(page);

      // To the last seconds, where the end starts the up-next countdown and the advance follows it.
      await pageVideo(page).evaluate((v) => (v.currentTime = v.duration - 1.5));
      await expect
        .poll(() => asked.playback.map(itemOf), { timeout: 30_000 })
        .toEqual(['e1', 'e2']);
      expect(asked.playback[1]).toMatchObject({ season: 1, episode: 2 });
      // A new episode, not a replacement of the last one's session; and from its own start, not from the second the
      // finished one ended at, which Continue Watching still carries beside it.
      expect(asked.playback[1]).not.toHaveProperty('replaces');
      expect(asked.playback[1].startAt).toBeUndefined();
      await expect(player(page)).toHaveAttribute('aria-label', `Series ${SERIES} · S1 · E2`);
      await expect(page).toHaveURL(
        `${ORIGIN}/tv/${SERIES}-series-${SERIES}?season=1&episode=2&play=1`,
      );

      // Episode 2's stream, from its start, in the very element that was fullscreen — which still is.
      await expect.poll(() => asked.media.some((path) => path.startsWith('/e2/seg'))).toBe(true);
      await playingPast(page, 1);
      const after = await page.evaluate(() => {
        const video = document.querySelector('.player video');
        return {
          same: video === window.__episodeOneVideo,
          marker: video.dataset.advanceMarker,
          fullscreen: document.fullscreenElement === video,
          at: video.currentTime,
        };
      });
      expect(after).toMatchObject({ same: true, marker: 'episode-1', fullscreen: true });
      expect(after.at, 'episode 2 from its own start, not episode 1’s end').toBeLessThan(30);

      // Episode 1 is written as finished; episode 2's own position as episode 2, never over episode 1.
      await expect.poll(() => progressOf(page, 1)).toMatchObject({ value: 1, seconds: 60 });
      await pageVideo(page).evaluate((v) => v.pause());
      await expect
        .poll(async () => (await progressOf(page, 2))?.seconds ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);
      expect((await progressOf(page, 2)).value).toBeLessThan(0.5);
      expect(await progressOf(page, 1)).toMatchObject({ value: 1, seconds: 60 });
    } finally {
      await browser.close();
    }
  });
}

test('closing the player and playing another title opens a fresh player', async () => {
  const { browser, page, asked } = await open(chromium);
  try {
    await playFirstEpisode(page);
    await playingPast(page, 1);
    await page.evaluate(() => (window.__seriesVideo = document.querySelector('.player video')));
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(player(page)).toHaveCount(0);
    // Leaving the player takes its video with it.
    expect(await page.evaluate(() => window.__seriesVideo.isConnected)).toBe(false);

    await page.evaluate(
      (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
      `/movie/${FILM}`,
    );
    await expect(page.locator('h1')).toHaveText(`Film ${FILM}`);
    await page.getByRole('link', { name: /^Play/ }).first().click();
    await expect(player(page)).toHaveAttribute('aria-label', `Film ${FILM}`);
    await expect(page).toHaveURL(`${ORIGIN}/movie/${FILM}-film-${FILM}?play=1`);
    await playingPast(page, 1);
    expect(asked.playback.map(itemOf)).toEqual(['e1', 'film']);
    expect(
      await page.evaluate(() => document.querySelector('.player video') === window.__seriesVideo),
    ).toBe(false);
  } finally {
    await browser.close();
  }
});

test.describe('Den Cast', () => {
  let built;
  test.beforeAll(() => {
    built = mkdtempSync(join(tmpdir(), 'den-episode-advance-'));
    execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
      cwd: web,
      env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
      stdio: 'ignore',
    });
  });
  test.afterAll(() => rmSync(built, { recursive: true, force: true }));

  const castFrame = (page) => page.locator(`iframe[src^="${CAST}"]`);
  const castLoads = async (page) =>
    (await page
      .frames()
      .find((frame) => frame.url().startsWith(CAST))
      ?.evaluate(() => window.loads)) ?? [];

  test('an episode cast through Den’s Cast button advances on the same receiver', async () => {
    const { browser, page, asked } = await open(chromium, { cast: built });
    try {
      await playFirstEpisode(page);
      await playingPast(page, 1);
      await page.getByRole('button', { name: 'Cast to a TV' }).click();
      const choose = page
        .frameLocator(`iframe[src^="${CAST}"]`)
        .getByRole('button', { name: 'Choose your Chromecast' });
      await expect(choose).toBeVisible({ timeout: 15_000 });
      await choose.click();
      await expect.poll(() => castLoads(page)).toHaveLength(1);
      expect((await castLoads(page))[0]).toMatchObject({ url: streamOf('e1'), title: 'S1 · E1' });
      await castFrame(page).evaluate((frame) => (window.__castFrame = frame));

      // The receiver reaches episode 1's end: the countdown runs here, and the next episode goes to the same receiver.
      await page
        .frames()
        .find((frame) => frame.url().startsWith(CAST))
        .evaluate(() => window.finishReceiver());
      await expect.poll(() => castLoads(page), { timeout: 30_000 }).toHaveLength(2);
      expect((await castLoads(page))[1]).toMatchObject({ url: streamOf('e2'), title: 'S1 · E2' });
      const episodeTwo = asked.playback.filter((body) => body.episode === 2);
      expect(episodeTwo).toHaveLength(1);
      expect(episodeTwo[0]).toMatchObject({ player: 'cast', season: 1 });
      await expect(player(page)).toHaveAttribute('aria-label', `Series ${SERIES} · S1 · E2`);
      // One frame throughout, so the Cast session chosen in it is the one the next episode plays in; nothing plays here.
      expect(
        await page.evaluate(
          (cast) => document.querySelector(`iframe[src^="${cast}"]`) === window.__castFrame,
          CAST,
        ),
      ).toBe(true);
      await expect(pageVideo(page)).toHaveCount(0);
      await expect(
        page.frameLocator(`iframe[src^="${CAST}"]`).getByText('Living Room TV'),
      ).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  /** The cast page's own video, playing past `seconds`. */
  async function framePlayingPast(page, seconds) {
    await expect
      .poll(
        async () =>
          (await page
            .frames()
            .find((frame) => frame.url().startsWith(CAST))
            ?.evaluate(() => {
              const video = document.querySelector('video');
              return video && !video.paused ? video.currentTime : -1;
            })) ?? -1,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(seconds);
  }

  test('away from home, the next episode plays in the same fullscreen cast-page frame', async () => {
    const { browser, page, asked } = await open(chromium, { cast: built, answer: remuxAnswer });
    try {
      await playFirstEpisode(page);
      await framePlayingPast(page, 1);
      // The frame is what is fullscreen here: the video playing is inside it. A click is the activation it needs.
      await page.evaluate((cast) => {
        const frame = document.querySelector(`iframe[src^="${cast}"]`);
        window.__castFrame = frame;
        document
          .querySelector('.player header b')
          .addEventListener('click', () => void frame.requestFullscreen(), { once: true });
      }, CAST);
      await page.locator('.player header b').click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement === window.__castFrame))
        .toBe(true);

      await page
        .frames()
        .find((frame) => frame.url().startsWith(CAST))
        .evaluate(() => {
          const video = document.querySelector('video');
          video.currentTime = video.duration - 1.5;
        });
      await expect
        .poll(() => asked.playback.map((body) => body.episode), { timeout: 30_000 })
        .toEqual([1, 2]);
      await expect(player(page)).toHaveAttribute('aria-label', `Series ${SERIES} · S1 · E2`);
      await expect
        .poll(() => asked.media.some((path) => path.includes('StE2/') && path.endsWith('.m4s')))
        .toBe(true);
      await framePlayingPast(page, 1);
      expect(
        await page.evaluate(
          (cast) => ({
            same: document.querySelector(`iframe[src^="${cast}"]`) === window.__castFrame,
            fullscreen: document.fullscreenElement === window.__castFrame,
          }),
          CAST,
        ),
      ).toEqual({ same: true, fullscreen: true });
    } finally {
      await browser.close();
    }
  });
});
