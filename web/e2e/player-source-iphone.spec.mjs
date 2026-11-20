// The stamp saying how a stream is delivered, on an iPhone, through the real app: a guest's Hearth, the title's page,
// Play, and the player as Library mounts it. Where WebKit plays HLS itself, a subtitle the viewer wants still starts
// on TorBox: only the viewer's own switch moves to Den Remux (`subtitle-system-player.spec.mjs`). The path is named in
// the player's options, whose Source page offers the switch to the other path where it may play, and, where it can't,
// the reason, with the switch shown and disabled.
import { test, expect, devices, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, GID, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';
import {
  openOptionsPage,
  revealControls,
  subtitlesButton,
  tapPhoneControl,
} from './player-options.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const TITLE = 1002;
const release = { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 };
const torboxAnswer = { url: `${ORIGIN}/torbox/t/media.m3u8`, release };
const remuxAnswer = {
  url: `${ORIGIN}/managed-remux/s/r1/sig/master.m3u8`,
  release,
  session: {
    id: 'r1',
    duration: 60,
    video: { codec: 'h264', transcoded: false },
    audioTrack: 0,
    audioTracks: [{ language: 'he', name: null, channels: 2, commentary: false }],
    subtitles: [{ language: 'sv', name: 'Svenska (in file)' }],
    endUrl: '/managed-remux/s/r1/sig',
    heartbeatUrl: '/managed-remux/s/r1/sig/heartbeat',
    reportUrl: '/managed-remux/s/r1/sig/report',
  },
};
const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Svenska (in file)",LANGUAGE="sv",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub0.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
media.m3u8
`;
const subMedia = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:60.0,
sub0.vtt
#EXT-X-ENDLIST
`;
const vtt =
  'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:30.000\nFrån filen.\n';

const contexts = [];

/**
 * Keep each context's own trace of a failure. These tests launch WebKit themselves, so the runner's trace holds none
 * of the page's network, console or snapshots.
 */
async function savePageTraces() {
  for (const [n, context] of contexts.entries())
    await context.tracing
      .stop({ path: test.info().outputPath(`page-${n + 1}-trace.zip`) })
      .catch(() => undefined);
}

/**
 * An iPhone: its viewport, touch and user agent, and its answer to "does this browser play HLS itself?" on every
 * platform (see `subtitle-system-player.spec.mjs`'s `iphone`): a fresh, unattached `<video>` says yes; the player's
 * own element keeps this engine's real answer, so it plays with what the engine has.
 */
async function iphone(browser, locale, { airPlay = false } = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale });
  contexts.push(context);
  await context.addInitScript((airPlay) => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      const answer = canPlayType.call(this, type);
      return answer || this.isConnected || !/mpegurl/i.test(type) ? answer : 'maybe';
    };
    if (!airPlay) return;
    const wireless = new WeakMap();
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', {
      configurable: true,
      get() {
        return wireless.get(this) ?? false;
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitShowPlaybackTargetPicker', {
      configurable: true,
      value() {
        window.airPlayPickerCalls = (window.airPlayPickerCalls ?? 0) + 1;
      },
    });
    window.setAirPlayAvailability = (availability) => {
      const video = document.querySelector('.player video');
      if (!video) return;
      const event = new Event('webkitplaybacktargetavailabilitychanged');
      Object.defineProperty(event, 'availability', { value: availability });
      video.dispatchEvent(event);
    };
    window.setAirPlayTarget = (active) => {
      const video = document.querySelector('.player video');
      if (!video) return;
      wireless.set(video, active);
      video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    };
    window.holdAirPlayMediaClock = () => {
      const video = document.querySelector('.player video');
      if (!video) return;
      window.airPlayMediaTime = video.currentTime;
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => window.airPlayMediaTime,
        set(value) {
          window.airPlayMediaTime = value;
        },
      });
      Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    };
    window.advanceAirPlayMediaClock = (seconds) => (window.airPlayMediaTime += seconds);
  }, airPlay);
  return context;
}

/** The title's one release as Scout lists it, with the video codec Scout read for it. */
const listedRelease = (codec) => ({
  url: `${ORIGIN}/den/p/ticket1`,
  behaviorHints: { filename: release.filename },
  attributes: { label: release.label, codec },
});

/**
 * A guest of a host whose Hearth answers playback with `hearth(body)`, the title in `originalLanguage`, and the media
 * of both paths served. Scout lists `streams` for the title where given, each list request counted in
 * `sourceLookups`. Returns every playback request body.
 */
async function guestPlayer(
  page,
  {
    hearth,
    originalLanguage,
    automaticSubtitles = false,
    playbackSourcePolicy,
    airPlayReports,
    streams,
    sourceLookups = [],
  },
) {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/external_ids')) return route.fulfill({ json: { imdb_id: 'tt42' } });
    const match = path.match(/\/movie\/(\d+)$/);
    if (!match) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(match[1]),
        title: `Movie ${match[1]}`,
        release_date: '2026-01-01',
        original_language: originalLanguage,
        overview: 'A movie, for the detail page to show.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18 }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        external_ids: { imdb_id: 'tt42' },
        imdb_id: 'tt42',
      },
    });
  });
  const playback = [];
  await page.route(`${ORIGIN}/den/~${GID}/playback`, (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    const body = request.postDataJSON();
    playback.push(body);
    return route.fulfill(hearth(body));
  });
  await page.route(`${ORIGIN}/remux/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  if (streams)
    await page.route(`${ORIGIN}/den/~${GID}/stream/movie/tt42.json`, (route) => {
      sourceLookups.push(route.request().url());
      return route.fulfill({ json: { streams } });
    });
  await page.route(`${ORIGIN}/playback/**`, (route) => {
    if (airPlayReports && new URL(route.request().url()).pathname.endsWith('/cast'))
      airPlayReports.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.route(`${ORIGIN}/torbox/t/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({
      contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(name, hls)),
    });
  });
  await page.route(`${ORIGIN}/managed-remux/s/r1/sig/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    const name = new URL(request.url()).pathname.split('/').pop();
    const body = { 'master.m3u8': master, 'sub0.m3u8': subMedia, 'sub0.vtt': vtt }[name];
    if (body)
      return route.fulfill({
        contentType: name.endsWith('.vtt') ? 'text/vtt' : 'application/vnd.apple.mpegurl',
        body,
      });
    return route.fulfill({
      contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(name, hls)),
    });
  });

  await page.goto(`${ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .tap();
  await expect
    .poll(
      () =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
      { timeout: 30_000 },
    )
    .toBe(true);
  if (automaticSubtitles) {
    const changes = (response) => new URL(response.url()).pathname.endsWith('/changes');
    const batch = (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/batch');
    await Promise.all([
      page.waitForResponse(changes, { timeout: 30_000 }),
      page.goto(`${ORIGIN}/settings`),
    ]);
    const subtitleLanguage = page.locator('#subtitle-language select');
    await expect(subtitleLanguage).toBeEnabled({ timeout: 30_000 });
    // Establish a real explicit preference first. A fresh library is already Automatic, so choosing Automatic from
    // a transient fail-closed Off rendering can correctly be a no-op and must not be used as proof of persistence.
    const [explicit] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      subtitleLanguage.selectOption('sv'),
    ]);
    expect(explicit.ok()).toBe(true);
    await expect(subtitleLanguage).toBeEnabled({ timeout: 30_000 });
    const [saved] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      subtitleLanguage.selectOption('__automatic'),
    ]);
    expect(saved.ok()).toBe(true);
    await expect(subtitleLanguage).toBeEnabled({ timeout: 30_000 });
    const interfaceLanguage = page.locator('#interface-language select');
    const [localized] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      interfaceLanguage.selectOption('sv'),
    ]);
    expect(localized.ok()).toBe(true);
    await expect(interfaceLanguage).toBeEnabled({ timeout: 30_000 });
    await Promise.all([page.waitForResponse(changes, { timeout: 30_000 }), page.reload()]);
    await expect(page.locator('#subtitle-language select')).toHaveValue('__automatic', {
      timeout: 30_000,
    });
    await expect(page.locator('#interface-language select')).toHaveValue('sv');
    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  }
  if (playbackSourcePolicy) {
    const changes = (response) => new URL(response.url()).pathname.endsWith('/changes');
    const batch = (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/batch');
    await Promise.all([
      page.waitForResponse(changes, { timeout: 30_000 }),
      page.goto(`${ORIGIN}/settings`),
    ]);
    const policy = page.locator('#playback-source-policy select');
    await expect(policy).toBeEnabled({ timeout: 30_000 });
    const [saved] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      policy.selectOption(playbackSourcePolicy),
    ]);
    expect(saved.ok()).toBe(true);
    await Promise.all([page.waitForResponse(changes, { timeout: 30_000 }), page.reload()]);
    await expect(page.locator('#playback-source-policy select')).toHaveValue(playbackSourcePolicy);
  }
  await page.goto(`${ORIGIN}/movie/${TITLE}`);
  const play = page
    .locator('[data-active="true"]')
    .getByRole('link', { name: automaticSubtitles ? 'Spela' : 'Play', exact: true });
  await expect(play).toBeVisible({ timeout: 30_000 });
  await play.tap();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.player video')?.currentTime ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
  return playback;
}

/**
 * The options' Source page, in Swedish, opened by taps as a finger does; the sheet it is on. The page's clock must be
 * installed before it loads. The controls hide 3 s after their last reveal and then pass taps to the picture; held
 * from the reveal to the tap on ⋯ they cannot hide in between, however slow the steps are (the open menu holds them
 * after that).
 */
async function swedishSourceSheet(page) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  await revealControls(page, { tap: true });
  const more = page.getByRole('button', { name: 'Fler uppspelningsalternativ' });
  expect(await tapLandsOnStamp(more)).toBe(true);
  await more.tap();
  await page.clock.resume();
  const sheet = page.getByRole('menu', { name: 'Fler uppspelningsalternativ' });
  await sheet.getByRole('menuitem', { name: /^Källa, / }).tap();
  return sheet;
}

/**
 * The player's next selected session, waited for from now. Hearth's answer reaches the route handler before the player
 * has applied it, and the player arms the replacement's AirPlay stall watch only as it selects it (`[Den playback]
 * selected`); a fake clock run between the two passes before that watch exists and fires nothing.
 */
const nextSelection = (page) =>
  page.waitForEvent('console', {
    predicate: (message) => message.text().startsWith('[Den playback] {"event":"selected"'),
    timeout: 30_000,
  });

/** What a tap at a control's centre lands on: the control itself (or something inside it), or what is over it. */
const tapLandsOnStamp = (stamp) =>
  stamp.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === el || el.contains(hit);
  });

test.describe('the delivery stamp on an iPhone, through the real app', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here');

  test('a subtitle wanted never starts on Den Remux; the switches from the sheet move between the paths', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'sv-SE')).newPage();
      await page.clock.install();
      // Hearth with TorBox: TorBox unless the request rules it out, TorBox alone when asked for it alone.
      const playback = await guestPlayer(page, {
        originalLanguage: 'he',
        automaticSubtitles: true,
        hearth: (body) => ({ json: body.directFailed ? remuxAnswer : torboxAnswer }),
      });
      // A Hebrew title in a Swedish browser wants Swedish subtitles, which the system player shows only from a
      // playlist. That never rules TorBox out: it plays, and nothing replaces it.
      expect(playback).toHaveLength(1);
      expect(playback[0]).toMatchObject({ player: 'native' });
      expect(playback[0]).not.toHaveProperty('directFailed');

      const stamp = page.getByTestId('playback-source');
      await expect(stamp).toHaveText('TorBox');
      await expect(page.locator('.player video')).not.toHaveAttribute('controls', '');
      await expect(page.locator('.player nav.web-transport')).toHaveCount(1);
      await page.waitForTimeout(1_000);
      expect(playback).toHaveLength(1);
      // Nothing is named showing that the system player could not show.
      expect(
        await page.evaluate(() =>
          [...(document.querySelector('.player video')?.textTracks ?? [])].some(
            (track) => track.mode === 'showing',
          ),
        ),
      ).toBe(false);

      const sheet = await swedishSourceSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText('Spelas direkt från TorBox');
      const toRemux = sheet.getByRole('menuitem', { name: 'Byt till Den Remux' });
      await expect(toRemux).not.toHaveAttribute('aria-disabled', 'true');
      expect(playback).toHaveLength(1);

      await toRemux.tap();
      await expect(stamp).toHaveText('Den Remux', { timeout: 30_000 });
      await expect(page.locator('.player video')).not.toHaveAttribute('controls', '');
      await expect(page.locator('.player nav.web-transport')).toHaveCount(1);
      expect(playback).toHaveLength(2);
      expect(playback[1]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });

      // And back, from the same page while Den Remux plays.
      const back = await swedishSourceSheet(page);
      await expect(back).toContainText('Spelas via Den Remux');
      await back.getByRole('menuitem', { name: 'Byt till TorBox' }).tap();
      await expect(stamp).toHaveText('TorBox', { timeout: 30_000 });
      await expect(page.locator('.player video')).not.toHaveAttribute('controls', '');
      await expect(page.locator('.player nav.web-transport')).toHaveCount(1);
      expect(playback[2]).toMatchObject({ directOnly: true, filename: 'fixture.mkv' });
      expect(playback[2]).not.toHaveProperty('directFailed');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  // Reported on an iPhone: an English and Italian release on TorBox started in Italian with no audio choice at all.
  // Hearth names no tracks for a release Scout never probed, and TorBox plays its first. Den Remux reads the file and
  // lists them, so the Audio section offers the switch to it.
  test('a TorBox stream that names no audio tracks offers Den Remux as its audio choice', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US')).newPage();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: (body) => ({ json: body.directFailed ? remuxAnswer : torboxAnswer }),
      });
      const stamp = page.getByTestId('playback-source');
      await expect(stamp).toHaveText('TorBox');
      const button = subtitlesButton(page);
      await tapPhoneControl(page, button);
      const audio = page.getByRole('group', { name: 'Audio' });
      const toRemux = audio.getByRole('menuitem', { name: /^Switch to Den Remux/ });
      await expect(toRemux).toContainText('TorBox plays its first audio track');
      await toRemux.tap();
      await expect(stamp).toHaveText('Den Remux', { timeout: 30_000 });
      expect(playback[1]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });

      // Den Remux names its tracks: they are the choice now, and the switch is gone.
      await tapPhoneControl(page, button);
      await expect(audio.getByRole('menuitemradio')).toHaveCount(1);
      await expect(audio.getByRole('menuitem', { name: /^Switch to Den Remux/ })).toHaveCount(0);
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('AirPlay gives Apple sole control while active, restores Den, and reports flapping', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const airPlayReports = [];
      await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: () => ({ json: torboxAnswer }),
        airPlayReports,
      });
      const video = page.locator('.player video');
      const controls = page.locator('.player nav.web-transport');
      await expect(video).not.toHaveAttribute('controls', '');
      await expect(controls).toHaveCount(1);

      await page.evaluate(() => window.setAirPlayAvailability('available'));
      const output = page.locator('.player .web-output .output-action');
      await expect(output).toBeVisible();
      await output.tap();
      await expect.poll(() => page.evaluate(() => window.airPlayPickerCalls ?? 0)).toBe(1);

      // The receiver disappears and returns before WebKit confirms a wireless target. Den keeps the picker usable,
      // records only bounded transition counts, and does not mistake the transient loss for the final outcome.
      await page.evaluate(() => window.setAirPlayAvailability('unavailable'));
      await expect(output).toBeDisabled();
      await page.evaluate(() => window.setAirPlayAvailability('available'));
      await expect(output).toBeEnabled();
      await output.tap();
      await expect.poll(() => page.evaluate(() => window.airPlayPickerCalls ?? 0)).toBe(2);
      await page.evaluate(() => window.setAirPlayTarget(true));

      // Apple's native transport is the only owner while AirPlay is active. The video element is not replaced, so
      // its HLS session and playhead survive the handoff.
      await expect(video).toHaveAttribute('controls', '');
      await expect(page.locator('.player > header, .player > footer')).toHaveCount(0);
      await expect(controls).toHaveCount(0);

      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(video).not.toHaveAttribute('controls', '');
      await expect(page.locator('.player > header.web-top')).toHaveCount(1);
      await expect(page.locator('.player > footer')).toHaveCount(0);
      await expect(controls).toHaveCount(1);

      await page.getByRole('button', { name: 'Close player' }).tap();
      await expect
        .poll(() => airPlayReports.find((report) => report.kind === 'airplay'))
        .toMatchObject({
          kind: 'airplay',
          reached: 'started',
          delivery: 'direct',
          availabilityChanges: 2,
          targetChanges: 2,
        });
      expect(airPlayReports.find((report) => report.kind === 'airplay')).not.toHaveProperty(
        'failed',
      );
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('an AirPlay receiver that disappears after selection is reported without identity', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const airPlayReports = [];
      await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: () => ({ json: remuxAnswer }),
        airPlayReports,
      });
      await page.evaluate(() => window.setAirPlayAvailability('available'));
      await page.locator('.player .web-output .output-action').tap();
      await page.evaluate(() => window.setAirPlayAvailability('unavailable'));
      await page.getByRole('button', { name: 'Close player' }).tap();

      await expect
        .poll(() => airPlayReports.find((report) => report.kind === 'airplay'))
        .toMatchObject({
          kind: 'airplay',
          reached: 'attempted',
          failed: true,
          failReason: 'receiver_unavailable',
          delivery: 'remux',
          availabilityChanges: 1,
        });
      expect(Object.keys(airPlayReports[0])).toEqual(
        expect.not.arrayContaining(['receiver', 'receiverName', 'url', 'address']),
      );
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('a stalled AirPlay TorBox stream retries a receiver-safe TorBox release', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const airPlayReports = [];
      // Before the page loads: a timer the page sets on the real clock cannot be cleared through the fake one. The
      // controls' 3 s hide timer, set while the player starts, then outlived the reveal that leaving AirPlay makes, hid
      // the controls again under the tap on Close, and left the picture to take it.
      await page.clock.install();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: (body) => {
          if (body.player === 'airplay' && body.filename)
            return {
              status: 409,
              json: {
                error: 'direct_unavailable',
                cause: 'torbox_receiver_unsupported',
              },
            };
          return { json: torboxAnswer };
        },
        airPlayReports,
      });
      await page.evaluate(() => {
        window.holdAirPlayMediaClock();
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });

      const receiverSafe = nextSelection(page);
      await page.clock.runFor(12_001);
      await expect.poll(() => playback.length).toBe(3);
      await receiverSafe;
      expect(playback[1]).toMatchObject({
        player: 'airplay',
        directOnly: true,
        filename: 'fixture.mkv',
      });
      expect(playback[2]).toMatchObject({ player: 'airplay', directOnly: true });
      expect(playback[2]).not.toHaveProperty('filename');
      expect(playback.some((request) => request.directFailed)).toBe(false);
      await expect(page.locator('.player video')).toHaveAttribute('controls', '');
      await expect(page.locator('.player nav.web-transport')).toHaveCount(0);

      // The receiver-safe replacement advances, so its own bounded watch keeps it on TorBox.
      await page.evaluate(() => window.advanceAirPlayMediaClock(1));
      await page.clock.runFor(12_001);
      expect(playback).toHaveLength(3);

      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
      await page.getByRole('button', { name: 'Close player' }).tap();
      await expect
        .poll(() => airPlayReports.find((report) => report.kind === 'airplay'))
        .toMatchObject({ kind: 'airplay', reached: 'started', delivery: 'direct' });
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  // TorBox's managed HLS carries HEVC in MPEG-TS, which an AirPlay 2 TV such as LG's never plays: on such a release
  // the receiver-safe stream is asked for the moment AirPlay begins, with the playhead still moving — no stall.
  test('AirPlay on a TorBox HEVC release asks for the receiver-safe stream at once', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        streams: [listedRelease('hevc')],
        hearth: (body) => {
          if (body.player === 'airplay' && body.filename)
            return {
              status: 409,
              json: { error: 'direct_unavailable', cause: 'torbox_receiver_unsupported' },
            };
          return { json: torboxAnswer };
        },
      });
      expect(playback).toHaveLength(1);
      await page.evaluate(() => {
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });

      // Well inside the stall watch's 12 s, which could not have asked.
      await expect.poll(() => playback.length, { timeout: 5_000 }).toBe(3);
      expect(playback[1]).toMatchObject({
        player: 'airplay',
        directOnly: true,
        filename: 'fixture.mkv',
      });
      expect(playback[2]).toMatchObject({ player: 'airplay', directOnly: true });
      expect(playback[2]).not.toHaveProperty('filename');
      expect(playback.some((request) => request.directFailed)).toBe(false);
      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('AirPlay on a TorBox H.264 release keeps its stream', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const sourceLookups = [];
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        streams: [listedRelease('h264')],
        sourceLookups,
        hearth: () => ({ json: torboxAnswer }),
      });
      const looked = sourceLookups.length;
      await page.evaluate(() => {
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });
      // The codec was looked up for this, and said H.264, which the receiver plays from TorBox as it is.
      await expect.poll(() => sourceLookups.length, { timeout: 5_000 }).toBeGreaterThan(looked);
      await page.waitForTimeout(1_000);
      expect(playback).toHaveLength(1);
      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('a receiver-safe TorBox stream that also stalls falls back once to Den Remux', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: (body) => {
          if (body.directFailed) return { json: remuxAnswer };
          if (body.player === 'airplay' && body.filename)
            return {
              status: 409,
              json: {
                error: 'direct_unavailable',
                cause: 'torbox_receiver_unsupported',
              },
            };
          return { json: torboxAnswer };
        },
      });
      await page.clock.install();
      await page.evaluate(() => {
        window.holdAirPlayMediaClock();
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });

      const receiverSafe = nextSelection(page);
      await page.clock.runFor(12_001);
      await expect.poll(() => playback.length).toBe(3);
      await receiverSafe;
      await page.clock.runFor(12_001);
      await expect.poll(() => playback.length).toBe(4);
      expect(playback[3]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });

      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(page.getByTestId('playback-source')).toHaveText('Den Remux');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('Remember my choice never changes a selected TorBox stream to Den Remux', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        playbackSourcePolicy: 'remember',
        hearth: (body) => {
          if (body.directFailed) return { json: remuxAnswer };
          if (body.player === 'airplay' && body.filename)
            return {
              status: 409,
              json: {
                error: 'direct_unavailable',
                cause: 'torbox_receiver_unsupported',
              },
            };
          return { json: torboxAnswer };
        },
      });

      // Establish an explicit last choice through the real Source menu: TorBox -> Remux -> TorBox.
      await revealControls(page);
      await openOptionsPage(page, 'Source');
      const preferenceBatch = (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/batch');
      const [rememberedRemux] = await Promise.all([
        page.waitForResponse(preferenceBatch, { timeout: 30_000 }),
        page.getByRole('menuitem', { name: 'Switch to Den Remux' }).tap(),
      ]);
      expect(rememberedRemux.ok()).toBe(true);
      await expect(page.getByTestId('playback-source')).toHaveText('Den Remux', {
        timeout: 30_000,
      });
      await revealControls(page);
      await openOptionsPage(page, 'Source');
      const [rememberedTorBox] = await Promise.all([
        page.waitForResponse(preferenceBatch, { timeout: 30_000 }),
        page.getByRole('menuitem', { name: 'Switch to TorBox' }).tap(),
      ]);
      expect(rememberedTorBox.ok()).toBe(true);
      await expect(page.getByTestId('playback-source')).toHaveText('TorBox', {
        timeout: 30_000,
      });
      expect(playback).toHaveLength(3);

      await page.clock.install();
      await page.evaluate(() => {
        window.holdAirPlayMediaClock();
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });
      const receiverSafe = nextSelection(page);
      await page.clock.runFor(12_001);
      await expect.poll(() => playback.length).toBe(5);
      await receiverSafe;
      await page.clock.runFor(12_001);
      await expect(page.getByTestId('playback-source')).toHaveText('Source');
      expect(playback).toHaveLength(5);
      expect(playback.slice(3)).toEqual(
        expect.arrayContaining([expect.objectContaining({ player: 'airplay', directOnly: true })]),
      );
      expect(playback.slice(3).some((request) => request.directFailed)).toBe(false);
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('an advancing AirPlay target keeps its TorBox direct stream', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US', { airPlay: true })).newPage();
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: () => ({ json: torboxAnswer }),
      });
      await page.clock.install();
      await page.evaluate(() => {
        window.holdAirPlayMediaClock();
        window.setAirPlayAvailability('available');
        window.setAirPlayTarget(true);
      });
      await page.clock.runFor(6_000);
      await page.evaluate(() => window.advanceAirPlayMediaClock(1));
      await page.clock.runFor(6_001);

      expect(playback).toHaveLength(1);
      await page.evaluate(() => window.setAirPlayTarget(false));
      await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('where Hearth has no TorBox, the options’ Source page says so, its switch disabled', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'en-US')).newPage();
      // Hearth with Den Remux only: an ordinary request, which TorBox would have been tried for, gets Remux and no
      // word of a TorBox that failed.
      const playback = await guestPlayer(page, {
        originalLanguage: 'en',
        hearth: () => ({ json: remuxAnswer }),
      });
      expect(playback).toHaveLength(1);
      expect(playback[0]).not.toHaveProperty('directFailed');

      const stamp = page.getByTestId('playback-source');
      await expect(stamp).toHaveText('Den Remux');
      const sheet = await openOptionsPage(page, 'Source', { tap: true });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText('This Hearth has no TorBox to play from');
      const toTorbox = sheet.getByRole('menuitem', { name: 'Switch to TorBox' });
      await expect(toTorbox).toHaveAttribute('aria-disabled', 'true');
      // Pressed anyway, it does nothing.
      await toTorbox.tap({ force: true });
      await page.waitForTimeout(500);
      expect(playback).toHaveLength(1);
      await expect(stamp).toHaveText('Den Remux');
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });
});
