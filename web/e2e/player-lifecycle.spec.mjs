import { test, expect, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';
import { openOptionsPage } from './player-options.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'life1',
  playlist: '/direct/s/life1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};

async function trackIntervals(page) {
  await page.addInitScript(() => {
    const intervals = new Map();
    const intervalStacks = new Map();
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const handle = set(callback, delay, ...args);
      intervals.set(handle, delay);
      intervalStacks.set(handle, new Error().stack ?? '');
      return handle;
    };
    window.clearInterval = (handle) => {
      intervals.delete(handle);
      intervalStacks.delete(handle);
      clear(handle);
    };
    window.playerFixtureIntervals = intervals;
    window.playerFixturePlayerIntervals = (delays) =>
      [...intervals].flatMap(([handle, delay]) =>
        delays.includes(delay) &&
        intervalStacks.get(handle)?.includes('/src/components/Player.svelte')
          ? [delay]
          : [],
      );
  });
}

async function mockPlayer(
  page,
  {
    onSession,
    onSkip,
    onTmdb,
    releases = [],
    sessionAnswer = session,
    runtime,
    episodeRuntime,
  } = {},
) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => {
    if (onTmdb) return onTmdb(route);
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith('/external_ids')
        ? { imdb_id: 'tt42' }
        : path.includes('/season/')
          ? {
              episodes: [
                { episode_number: 1, name: 'Episode one', runtime: episodeRuntime },
                { episode_number: 2, name: 'Episode two', runtime: 3 },
              ],
            }
          : {
              id: 42,
              ...(episodeRuntime === undefined
                ? { title: 'The Movie', release_date: '2001-01-01' }
                : { name: 'The Series', first_air_date: '2001-01-01' }),
              runtime,
              genres: [],
            },
    });
  });
  await page.route(
    `${ORIGIN}/skipdb/**`,
    onSkip ?? ((route) => route.fulfill({ status: 404, json: {} })),
  );
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(
    `${ORIGIN}/direct/session`,
    onSession ?? ((route) => route.fulfill({ status: 201, json: sessionAnswer })),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) => route.fulfill({ json: { releases } }));
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

test('unknown media duration uses trusted title runtime only for the saved fraction', async ({
  page,
}) => {
  let releaseRuntime;
  let startRuntime;
  const held = new Promise((resolve) => {
    releaseRuntime = resolve;
  });
  const started = new Promise((resolve) => {
    startRuntime = resolve;
  });
  await mockPlayer(page, {
    sessionAnswer: { ...session, duration: 0 },
    onTmdb: async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/external_ids'))
        return route.fulfill({ json: { imdb_id: 'tt42' } });
      startRuntime();
      await held;
      return route.fulfill({
        json: {
          id: 42,
          title: 'The Movie',
          release_date: '2001-01-01',
          runtime: 2,
          genres: [],
        },
      });
    },
  });
  await page.goto(`${ORIGIN}/test/player.html`);
  await started;
  const video = page.locator('.player video');
  await page.waitForFunction(() => !document.querySelector('.player video')?.paused, undefined, {
    timeout: 30_000,
  });
  await video.evaluate((element) => {
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 0 });
    element.currentTime = 31;
    element.pause();
  });
  await expect(page.getByTestId('player-progress-writes')).toHaveText('0');
  releaseRuntime();

  await expect
    .poll(async () => {
      const saved = JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}');
      return saved.seconds === 31 ? saved.fraction : 0;
    })
    .toBeCloseTo(31 / 120, 2);
});

test('unknown episode duration prefers its exact runtime over the series estimate', async ({
  page,
}) => {
  await mockPlayer(page, {
    sessionAnswer: { ...session, duration: 0 },
    runtime: 10,
    episodeRuntime: 2,
  });
  await page.goto(`${ORIGIN}/test/player.html?series&episodes`);
  const video = page.locator('.player video');
  await page.waitForFunction(() => !document.querySelector('.player video')?.paused, undefined, {
    timeout: 30_000,
  });
  await video.evaluate((element) => {
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 0 });
    element.currentTime = 31;
    element.pause();
  });

  await expect
    .poll(async () => {
      const saved = JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}');
      return saved.seconds === 31 ? saved.fraction : 0;
    })
    .toBeCloseTo(31 / 120, 2);
});

test('late runtime from a replaced episode cannot become the active denominator', async ({
  page,
}) => {
  let releaseFirst;
  let startFirst;
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise((resolve) => {
    startFirst = resolve;
  });
  await mockPlayer(page, {
    sessionAnswer: { ...session, duration: 0 },
    onTmdb: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/external_ids')) return route.fulfill({ json: { imdb_id: 'tt42' } });
      if (path.endsWith('/season/1')) {
        startFirst();
        await firstHeld;
        return route
          .fulfill({ json: { episodes: [{ episode_number: 1, name: 'Old', runtime: 1 }] } })
          .catch(() => undefined);
      }
      if (path.endsWith('/season/2'))
        return route.fulfill({
          json: { episodes: [{ episode_number: 1, name: 'Current', runtime: 3 }] },
        });
      return route.fulfill({
        json: { id: 42, name: 'The Series', first_air_date: '2001-01-01', runtime: 10, genres: [] },
      });
    },
  });
  await page.goto(`${ORIGIN}/test/player.html?series&replaceEpisode`);
  await firstStarted;
  await page.getByTestId('replace-player-episode').evaluate((button) => button.click());
  const video = page.locator('.player video');
  await page.waitForFunction(() => !document.querySelector('.player video')?.paused, undefined, {
    timeout: 30_000,
  });
  await video.evaluate((element) => {
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 0 });
    element.currentTime = 31;
    element.pause();
  });
  await expect
    .poll(async () => {
      const saved = JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}');
      return saved.seconds === 31 && saved.playing === false ? saved.fraction : 0;
    })
    .toBeCloseTo(31 / 180, 3);

  releaseFirst();
  await video.evaluate(async (element) => {
    await element.play();
    element.currentTime = 32;
    element.pause();
  });
  await expect
    .poll(async () => {
      const saved = JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}');
      return saved.seconds === 32 && saved.playing === false ? saved.fraction : 0;
    })
    .toBeCloseTo(32 / 180, 3);
});

test('unknown media duration without trustworthy runtime remains fail-closed', async ({ page }) => {
  await mockPlayer(page, { sessionAnswer: { ...session, duration: 0 } });
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  await page.waitForFunction(() => !document.querySelector('.player video')?.paused, undefined, {
    timeout: 30_000,
  });
  await video.evaluate((element) => {
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 0 });
    element.currentTime = 31;
    element.pause();
  });

  await expect(page.getByTestId('player-progress-writes')).toHaveText('0');
});

test('playback progress clears startup and leaves no hls.js head poll behind', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await trackIntervals(page);
    await page.addInitScript(() => {
      HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
      HTMLVideoElement.prototype.cancelVideoFrameCallback = () => undefined;
    });
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );

    await expect(page.locator('.startup')).toHaveCount(0);
    expect(await page.evaluate(() => window.playerFixturePlayerIntervals([250]))).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a play writes its position within seconds of starting, and again on resume', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    const video = page.locator('.player video');
    const writes = page.getByTestId('player-progress-writes');
    const written = async () =>
      JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}');
    await page.waitForFunction(() => !document.querySelector('.player video')?.paused, undefined, {
      timeout: 30_000,
    });

    // The first part-way position goes out a moment after playback starts, not at the one-minute report.
    await expect(writes).toHaveText('1', { timeout: 5_000 });
    const first = await written();
    expect(first.seconds).toBeGreaterThanOrEqual(1);
    expect(first.fraction).toBeGreaterThan(0);
    expect(first.fraction).toBeLessThan(1);
    // Then nothing more while it plays on.
    await page.waitForTimeout(3_000);
    await expect(writes).toHaveText('1');

    // Pause and resume are producer truth, so both are written even when the media clock has not crossed into the
    // next whole second yet. Requiring movement here recreated the ambiguity this contract removes.
    await video.evaluate((element) => element.pause());
    await expect(writes).toHaveText('2');
    const paused = await written();
    expect(paused.playing).toBe(false);
    await video.evaluate((element) => element.play());
    await expect(writes).toHaveText('3', { timeout: 5_000 });
    const resumed = await written();
    expect(resumed.playing).toBe(true);
    expect(resumed.seconds).toBeGreaterThanOrEqual(paused.seconds);
    await page.waitForTimeout(3_000);
    await expect(writes).toHaveText('3');
  } finally {
    await browser.close();
  }
});

test('player polling sleeps while paused', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await trackIntervals(page);
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );
    expect(
      await page.locator('.player video').evaluate((video) => {
        let paused = false;
        Object.defineProperties(video, {
          paused: { configurable: true, get: () => paused },
          seeking: { configurable: true, get: () => false },
          ended: { configurable: true, get: () => false },
        });
        window.setPlayerFixturePaused = (next) => {
          paused = next;
          video.dispatchEvent(new Event(next ? 'pause' : 'playing'));
        };
        video.dispatchEvent(new Event('waiting'));
        return window.playerFixturePlayerIntervals([500]);
      }),
    ).toContain(500);
    expect(
      await page.locator('.player video').evaluate((video) => {
        window.setPlayerFixturePaused(true);
        video.dispatchEvent(new Event('waiting'));
        return window.playerFixturePlayerIntervals([250, 500]);
      }),
    ).toEqual([]);

    expect(
      await page.locator('.player video').evaluate((video) => {
        window.setPlayerFixturePaused(false);
        video.dispatchEvent(new Event('waiting'));
        return window.playerFixturePlayerIntervals([500]);
      }),
    ).toContain(500);
  } finally {
    await browser.close();
  }
});

test('loaded data and an advancing audio clock do not claim a dropped video frame', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
      HTMLVideoElement.prototype.cancelVideoFrameCallback = () => undefined;
      HTMLVideoElement.prototype.getVideoPlaybackQuality = () => ({
        creationTime: performance.now(),
        totalVideoFrames: 8,
        droppedVideoFrames: 8,
        corruptedVideoFrames: 0,
        totalFrameDelay: 0,
      });
    });
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );

    await expect(page.locator('.startup')).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

test('an old release’s late SkipDB answer does not reopen the new release’s request', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    const skipRequests = [];
    const releases = [session.release, { label: 'Fixture 720p', filename: 'other.mkv', size: 2 }];
    let sessions = 0;
    await mockPlayer(page, {
      releases,
      onSkip: async (route) => {
        skipRequests.push(route);
      },
      onSession: async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const release = body.filename === 'other.mkv' ? releases[1] : releases[0];
        sessions += 1;
        return route.fulfill({
          status: 201,
          json: {
            ...session,
            sid: `life${sessions}`,
            playlist: `/direct/s/life${sessions}/sig/master.m3u8`,
            release,
          },
        });
      },
    });
    await page.goto(`${ORIGIN}/test/player.html`);
    await expect.poll(() => skipRequests.length).toBe(1);
    await openOptionsPage(page, 'Stream');
    await expect(page.getByRole('menuitemradio')).toHaveCount(2);
    await page.getByRole('menuitemradio').filter({ hasText: 'other.mkv' }).click();
    await expect.poll(() => skipRequests.length).toBe(2);

    await skipRequests[0].fulfill({ status: 404, json: {} });
    await skipRequests[1].fulfill({ status: 404, json: {} });
    await page.locator('.player video').dispatchEvent('loadedmetadata');
    await page.waitForTimeout(500);

    expect(skipRequests).toHaveLength(2);
  } finally {
    await browser.close();
  }
});

test('closing native HLS empties the retained media element', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await page.locator('.player video').waitFor();
    await page.locator('.player video').evaluate((video) => {
      window.retainedPlayerVideo = video;
    });

    await page.getByRole('button', { name: 'Close' }).click();

    // `load()` with no source leaves networkState at NETWORK_NO_SOURCE (3) until the element's next task, when
    // resource selection settles it to NETWORK_EMPTY (0); a read in between sees the transient value.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          source: window.retainedPlayerVideo.getAttribute('src'),
          network: window.retainedPlayerVideo.networkState,
        })),
      )
      .toEqual({ source: null, network: 0 });
  } finally {
    await browser.close();
  }
});
