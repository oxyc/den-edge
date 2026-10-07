import { test, expect, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

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

async function trackIntervals(page, mockVisibility = false) {
  await page.addInitScript((replaceVisibility) => {
    const intervals = new Map();
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const handle = set(callback, delay, ...args);
      intervals.set(handle, delay);
      return handle;
    };
    window.clearInterval = (handle) => {
      intervals.delete(handle);
      clear(handle);
    };
    window.playerFixtureIntervals = intervals;
    if (replaceVisibility) {
      let visibility = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
      window.setPlayerFixtureVisibility = (next) => {
        visibility = next;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    }
  }, mockVisibility);
}

async function mockPlayer(page, { onSession, onSkip, releases = [] } = {}) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(
    `${ORIGIN}/skipdb/**`,
    onSkip ?? ((route) => route.fulfill({ status: 404, json: {} })),
  );
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(
    `${ORIGIN}/direct/session`,
    onSession ?? ((route) => route.fulfill({ status: 201, json: session })),
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
    expect(
      await page.evaluate(() =>
        [...window.playerFixtureIntervals.values()].filter((delay) => delay === 250),
      ),
    ).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('native polling sleeps with a paused or hidden player', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await trackIntervals(page, true);
    await mockPlayer(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );
    const timers = () =>
      page.evaluate(() =>
        [...window.playerFixtureIntervals.values()].filter(
          (delay) => delay === 250 || delay === 500,
        ),
      );
    await page.locator('.player video').evaluate(async (video) => {
      await video.play();
      video.dispatchEvent(new Event('playing'));
    });
    await expect.poll(timers).toContain(250);

    expect(
      await page.locator('.player video').evaluate((video) => {
        video.dispatchEvent(new Event('waiting'));
        return [...window.playerFixtureIntervals.values()];
      }),
    ).toContain(500);
    expect(
      await page.evaluate(() => {
        window.setPlayerFixtureVisibility('hidden');
        return [...window.playerFixtureIntervals.values()].filter(
          (delay) => delay === 250 || delay === 500,
        );
      }),
    ).toEqual([]);

    await page.evaluate(() => window.setPlayerFixtureVisibility('visible'));
    await expect.poll(timers).toContain(250);
    await page.locator('.player video').evaluate((video) => video.pause());
    await expect.poll(timers).toEqual([]);
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
    await expect(page.locator('select[aria-label="Release"] option')).toHaveCount(2);

    await page.locator('select[aria-label="Release"]').selectOption('other.mkv');
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

    expect(
      await page.evaluate(() => ({
        source: window.retainedPlayerVideo.getAttribute('src'),
        network: window.retainedPlayerVideo.networkState,
      })),
    ).toEqual({ source: null, network: 0 });
  } finally {
    await browser.close();
  }
});
