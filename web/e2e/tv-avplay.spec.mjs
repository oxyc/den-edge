import { expect, test } from '@playwright/test';
import {
  callsNamed,
  chooseSubtitle,
  installAvplayInitScript,
  remoteKey,
} from './avplay-fixture.mjs';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';

test.skip(process.env.DEN_TV_PLATFORM !== 'tizen', 'Samsung AVPlay is a Tizen-only bridge');

const release = { label: 'AVPlay fixture 1080p', filename: 'avplay-fixture.mkv', size: 1 };

function session(sequence, audioTrack = 0) {
  return {
    sid: `avplay-${sequence}`,
    playlist: `/direct/s/avplay-${sequence}/sig/master.m3u8`,
    duration: 60,
    release,
    video: { codec: 'h264', transcoded: false },
    audioTrack,
    audioTracks: [
      { language: 'en', name: 'English', channels: 2 },
      { language: 'es', name: 'Spanish', channels: 2 },
    ],
    subtitles: [
      { language: 'en', name: 'English' },
      { language: 'es', name: 'Spanish' },
    ],
  };
}

async function routePlayback(page, externalSubtitles = undefined) {
  let sequence = 0;
  const ended = [];
  const reports = [];
  const sessionRequests = [];
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  await page.route(`${ORIGIN}/direct/session`, async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}');
    sessionRequests.push(request);
    sequence += 1;
    await route.fulfill({
      status: 201,
      json: { ...session(sequence, request.audioTrack ?? 0), externalSubtitles },
    });
  });
  await page.route(`${ORIGIN}/direct/s/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/report')) reports.push(JSON.parse(request.postData() ?? '{}'));
    if (request.method() === 'DELETE' || path.endsWith('/end')) {
      ended.push(path);
      return route.fulfill({ status: 204 });
    }
    if (request.method() === 'POST') return route.fulfill({ status: 204 });
    if (path.endsWith('/master.m3u8'))
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\nmedia.m3u8\n',
      });
    if (path.endsWith('/media.m3u8'))
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXTINF:60,\nsegment.mp4\n',
      });
    return route.fulfill({ status: 200, contentType: 'video/mp4', body: '' });
  });
  return { ended, sessionRequests, reports };
}

test('Samsung AVPlay bridges resume, transport, tracks, stale callbacks and visibility cleanup', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  const routed = await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html?resume=12`);

  const video = page.locator('.player video');
  await expect(page.locator('object.den-avplay-plane[type="application/avplayer"]')).toHaveCount(1);
  await expect.poll(() => callsNamed(page, 'prepareAsync')).toHaveLength(1);
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(12);
  expect((await callsNamed(page, 'seekTo')).some((call) => call[1] === 12_000)).toBe(true);

  // Samsung exposes the same useful transport as LG, not a decoder-specific row of text buttons. Prove the
  // timeline controls AVPlay itself: this is the behavior a viewer needs, rather than an assertion about CSS.
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  await expect(timeline).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rewind 10 seconds' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forward 10 seconds' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play from beginning' })).toBeVisible();
  const beforeTimelineSeek = await video.evaluate((element) => element.currentTime);
  await timeline.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(beforeTimelineSeek + 5);
  await expect
    .poll(async () => (await callsNamed(page, 'seekTo')).at(-1)?.[1] ?? 0)
    // A range step snaps to its next ten-second boundary (for example 12s -> 20s), rather than adding ten.
    .toBeGreaterThan((beforeTimelineSeek + 5) * 1000);
  await page.getByRole('button', { name: 'Play from beginning' }).click();
  await expect.poll(async () => (await callsNamed(page, 'seekTo')).at(-1)?.[1]).toBe(0);

  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await expect.poll(() => callsNamed(page, 'pause')).toHaveLength(1);
  const beforeSeek = await video.evaluate((element) => element.currentTime);
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(beforeSeek + 8);
  expect(await remoteKey(page, 'Unidentified', 415)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);

  const audio = page.getByLabel('Audio track');
  await audio.selectOption('1');
  await expect.poll(() => routed.sessionRequests).toHaveLength(2);
  await expect.poll(() => callsNamed(page, 'prepareAsync')).toHaveLength(2);
  await expect
    .poll(() => callsNamed(page, 'setSelectTrack'))
    .toContainEqual(['setSelectTrack', 'AUDIO', 12, 'PLAYING']);

  // Samsung can deliver queued callbacks after stop/close. Neither callback from the replaced mount may affect the
  // new session, even though the fixture deliberately retains every listener object.
  await page.evaluate(() => {
    window.__avplayFixture.staleError(0);
    window.__avplayFixture.staleEnd(0);
  });
  await expect(video).toHaveCount(1);
  await expect(page.getByText('This browser couldn’t play this release.')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.state())).toBe('PLAYING');

  await chooseSubtitle(page, 'English');
  await expect
    .poll(() => callsNamed(page, 'setSelectTrack'))
    .toContainEqual(['setSelectTrack', 'TEXT', 21, 'PLAYING']);
  await chooseSubtitle(page, 'Off');
  await expect
    .poll(() => callsNamed(page, 'setSilentSubtitle'))
    .toContainEqual(['setSilentSubtitle', true, 'PLAYING']);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(video).toHaveCount(0);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  await expect.poll(() => callsNamed(page, 'close')).toHaveLength(2);
  await expect.poll(() => routed.ended.length).toBe(2);
  await expect
    .poll(async () => {
      const value = await page.getByTestId('player-progress').textContent();
      return JSON.parse(value ?? '{}').seconds ?? 0;
    })
    .toBeGreaterThan(0);
});

test('Samsung displays external WebVTT captions at the AVPlay clock and clears them on Off', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  await routePlayback(page, [{ language: 'en', name: 'English', url: `${ORIGIN}/captions.vtt` }]);
  await page.route(`${ORIGIN}/captions.vtt`, (route) =>
    route.fulfill({
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nExternal <b>caption</b>\n',
    }),
  );
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  await chooseSubtitle(page, 'English');
  await expect(page.locator('.den-avplay-captions')).toHaveText('External caption');
  await chooseSubtitle(page, 'Off');
  await expect(page.locator('.den-avplay-captions')).toBeHidden();
});

test('Samsung serializes rapid seeks and coalesces them to the latest remote target', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  expect(await remoteKey(page, 'Unidentified', 19)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  const before = await video.evaluate((element) => element.currentTime);
  const existing = (await callsNamed(page, 'seekTo')).length;
  await page.evaluate(() => window.__avplayFixture.delaySeeks());
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);
  expect(await remoteKey(page, 'Unidentified', 417)).toBe(true);

  await expect.poll(() => callsNamed(page, 'seekTo')).toHaveLength(existing + 1);
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.pendingSeekCount())).toBe(1);
  expect(await video.evaluate((element) => element.currentTime)).toBeCloseTo(before + 30, 3);

  await page.evaluate(() => window.__avplayFixture.releaseSeek());
  await expect.poll(() => callsNamed(page, 'seekTo')).toHaveLength(existing + 2);
  expect((await callsNamed(page, 'seekTo')).at(-1)?.[1]).toBeCloseTo((before + 30) * 1000, 0);
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.pendingSeekCount())).toBe(1);
  await page.evaluate(() => window.__avplayFixture.releaseSeek());
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.pendingSeekCount())).toBe(0);
  await expect.poll(() => video.evaluate((element) => element.seeking)).toBe(false);
  expect(await video.evaluate((element) => element.currentTime)).toBeCloseTo(before + 30, 3);
  await expect(page.getByText('This release stopped responding.')).toHaveCount(0);
});

test('Samsung defers pause, track changes and teardown until an asynchronous seek finishes', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  const video = page.locator('.player video');
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);

  await page.evaluate(() => window.__avplayFixture.delaySeeks());
  video.evaluate((element) => {
    element.currentTime += 10;
  });
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.pendingSeekCount())).toBe(1);

  const pauseCalls = (await callsNamed(page, 'pause')).length;
  const subtitleCalls = (await callsNamed(page, 'setSilentSubtitle')).length;
  await video.evaluate((element) => element.pause());
  await chooseSubtitle(page, 'Spanish');
  expect(await callsNamed(page, 'pause')).toHaveLength(pauseCalls);
  expect(await callsNamed(page, 'setSilentSubtitle')).toHaveLength(subtitleCalls);
  await expect(page.getByText('This release stopped responding.')).toHaveCount(0);

  await page.evaluate(() => window.__avplayFixture.releaseSeek());
  await expect.poll(() => callsNamed(page, 'pause')).toHaveLength(pauseCalls + 1);
  await expect.poll(() => callsNamed(page, 'setSilentSubtitle')).toHaveLength(subtitleCalls + 1);

  await page.evaluate(() => {
    window.__avplayFixture.delaySeeks();
    const element = document.querySelector('.player video');
    element.currentTime += 10;
  });
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.pendingSeekCount())).toBe(1);
  const closeCalls = (await callsNamed(page, 'close')).length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await callsNamed(page, 'close')).toHaveLength(closeCalls);
  await page.evaluate(() => window.__avplayFixture.releaseSeek());
  await expect.poll(() => callsNamed(page, 'close')).toHaveLength(closeCalls + 1);
});

test('Samsung error reports retain the error enum without signed media details', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  const routed = await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  await page.evaluate(() =>
    window.__avplayFixture
      .latest()
      .onerrormsg(
        'PLAYER_ERROR_NOT_SUPPORTED_FILE',
        'Cannot open https://media.example.test/secret-path?token=private-capability',
      ),
  );
  await expect.poll(() => routed.reports.length).toBe(1);
  expect(routed.reports[0]).toMatchObject({ code: 4, message: 'PLAYER_ERROR_NOT_SUPPORTED_FILE' });
  expect(JSON.stringify(routed.reports)).not.toContain('private-capability');
  await expect(page.getByText('This browser couldn’t play this release.')).toBeVisible();
});

test('Samsung start failure is handled without an unhandled playback promise or private diagnostics', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  await page.addInitScript(() => {
    window.webapis.avplay.play = () => {
      throw new Error('Cannot open https://media.example.test/private?token=play-secret');
    };
  });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  const routed = await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect(
    page.getByText('This release stopped responding. Try it again, or pick another one.'),
  ).toBeVisible();
  expect(routed.reports.length).toBeGreaterThan(0);
  await expect.poll(() => callsNamed(page, 'close')).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(JSON.stringify([...routed.reports, ...warnings])).not.toContain('play-secret');
});

test('Samsung AVPlay forwards completion and distinguishes connection failures from format refusal', async ({
  page,
}) => {
  await installAvplayInitScript(page);
  const routed = await routePlayback(page);
  await page.goto(`${ORIGIN}/test/player.html`);
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);

  await page.evaluate(() => window.__avplayFixture.end());
  await expect
    .poll(async () => JSON.parse((await page.getByTestId('player-progress').textContent()) ?? '{}'))
    .toMatchObject({ fraction: 1, seconds: 60 });
  await expect.poll(() => page.evaluate(() => window.__avplayFixture.state())).toBe('IDLE');

  await page.reload();
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  // This case is a mid-playback interruption, not a failure before the first clock update.
  await expect
    .poll(() => page.locator('.player video').evaluate((video) => video.currentTime))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.__avplayFixture.error());
  await expect(page.getByRole('button', { name: /Resume from/ })).toBeVisible();

  await page.reload();
  await expect.poll(() => callsNamed(page, 'play')).toHaveLength(1);
  await page.evaluate(() => window.__avplayFixture.error('PLAYER_ERROR_NOT_SUPPORTED_FILE'));
  await expect(page.getByText('This browser couldn’t play this release.')).toBeVisible();
  await expect.poll(() => callsNamed(page, 'close')).toHaveLength(1);
  // The shared Player keeps the session identity for Retry/another release after an error. Back ends that
  // session; reloading the document above is not a component unmount and cannot establish this contract.
  expect(await remoteKey(page, 'Unidentified', 461)).toBe(true);
  await expect(page.getByTestId('player-close-count')).toHaveText('1');
  await expect.poll(() => routed.ended).toContain('/direct/s/avplay-3/sig/end');
});
