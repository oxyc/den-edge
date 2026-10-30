// The stamp saying how a stream is delivered, on an iPhone, through the real app: a guest's Hearth, the title's page,
// Play, and the player as Library mounts it. Where WebKit plays HLS itself, a subtitle the viewer wants starts on Den
// Remux (`subtitle-system-player.spec.mjs`): the page rules TorBox out itself, so Hearth never tries it and says
// nothing about it. That stamp was a plain label there, and a tap on it did nothing. It is a menu now: the switch to
// TorBox where TorBox may play, and, where it can't, the reason, with the switch shown and disabled.
import { test, expect, devices, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, GID, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

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
async function iphone(browser, locale) {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale });
  contexts.push(context);
  await context.addInitScript(() => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      const answer = canPlayType.call(this, type);
      return answer || this.isConnected || !/mpegurl/i.test(type) ? answer : 'maybe';
    };
  });
  return context;
}

/**
 * A guest of a host whose Hearth answers playback with `hearth(body)`, the title in `originalLanguage`, and the media
 * of both paths served. Returns every playback request body.
 */
async function guestPlayer(page, { hearth, originalLanguage, automaticSubtitles = false }) {
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
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
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
  }
  await page.goto(`${ORIGIN}/movie/${TITLE}`);
  const play = page
    .locator('[data-active="true"]')
    .getByRole('link', { name: 'Play', exact: true });
  await expect(play).toBeVisible({ timeout: 30_000 });
  await play.tap();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.player video')?.currentTime ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
  return playback;
}

/** What a tap at the stamp's centre lands on: the stamp itself (or something inside it), or what is over it. */
const tapLandsOnStamp = (stamp) =>
  stamp.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === el || el.contains(hit);
  });

test.describe('the delivery stamp on an iPhone, through the real app', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here');

  test('on Den Remux for a subtitle, the stamp offers TorBox, and the switch from the sheet plays it', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'sv-SE')).newPage();
      // Hearth with TorBox: TorBox unless the request rules it out, TorBox alone when asked for it alone.
      const playback = await guestPlayer(page, {
        originalLanguage: 'he',
        automaticSubtitles: true,
        hearth: (body) => ({ json: body.directFailed ? remuxAnswer : torboxAnswer }),
      });
      // A Hebrew title in a Swedish browser wants Swedish subtitles, which the system player shows only from a
      // playlist: the page asked for Den Remux itself, so Hearth never tried TorBox.
      expect(playback).toHaveLength(1);
      expect(playback[0]).toMatchObject({ player: 'native', directFailed: true });

      const stamp = page.getByRole('button', { name: 'Playing from Den Remux' });
      await expect(stamp).toHaveText('Den Remux');
      expect(await tapLandsOnStamp(stamp)).toBe(true);
      await stamp.tap();
      const sheet = page.getByRole('menu', { name: 'Playing from Den Remux' });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText('Playing through Den Remux');
      const toTorbox = sheet.getByRole('menuitem', { name: 'Switch to TorBox' });
      await expect(toTorbox).not.toHaveAttribute('aria-disabled', 'true');
      // The subtitle can't come along: the system player shows only a playlist's, and TorBox's names none.
      await expect(toTorbox).toContainText('Turns subtitles off');
      expect(playback).toHaveLength(1);

      await toTorbox.tap();
      const torboxStamp = page.getByRole('button', { name: 'Playing from TorBox' });
      await expect(torboxStamp).toHaveText('TorBox', { timeout: 30_000 });
      expect(playback).toHaveLength(2);
      expect(playback[1]).toMatchObject({ directOnly: true, filename: 'fixture.mkv' });
      expect(playback[1]).not.toHaveProperty('directFailed');
      // Nothing is named showing that the system player could not show.
      expect(
        await page.evaluate(() =>
          [...(document.querySelector('.player video')?.textTracks ?? [])].some(
            (track) => track.mode === 'showing',
          ),
        ),
      ).toBe(false);

      // And back, from the TorBox stamp's own sheet.
      expect(await tapLandsOnStamp(torboxStamp)).toBe(true);
      await torboxStamp.tap();
      const back = page.getByRole('menu', { name: 'Playing from TorBox' });
      await expect(back).toContainText('Playing directly from TorBox');
      await back.getByRole('menuitem', { name: 'Switch to Den Remux' }).tap();
      await expect(stamp).toHaveText('Den Remux', { timeout: 30_000 });
      expect(playback[2]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('on Den Remux for a subtitle, a switch Hearth refuses for want of TorBox leaves it disabled, saying so', async () => {
    const browser = await webkit.launch();
    try {
      const page = await (await iphone(browser, 'sv-SE')).newPage();
      // Hearth with Den Remux only: TorBox alone is refused bare, with no TorBox failure behind it.
      const playback = await guestPlayer(page, {
        originalLanguage: 'he',
        automaticSubtitles: true,
        hearth: (body) =>
          body.directOnly
            ? { status: 409, json: { error: 'direct_unavailable' } }
            : { json: remuxAnswer },
      });
      expect(playback[0]).toMatchObject({ directFailed: true });
      const stamp = page.getByRole('button', { name: 'Playing from Den Remux' });
      await stamp.tap();
      const sheet = page.getByRole('menu', { name: 'Playing from Den Remux' });
      await sheet.getByRole('menuitem', { name: 'Switch to TorBox' }).tap();
      await expect(sheet).toBeHidden();
      await expect.poll(() => playback.length).toBe(2);
      expect(playback[1]).toMatchObject({ directOnly: true });
      await expect(stamp).toHaveText('Den Remux');

      await stamp.tap();
      await expect(sheet).toContainText('This Hearth has no TorBox to play from');
      await expect(sheet.getByRole('menuitem', { name: 'Switch to TorBox' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    } catch (error) {
      await savePageTraces();
      throw error;
    } finally {
      contexts.length = 0;
      await browser.close();
    }
  });

  test('where Hearth has no TorBox, the stamp opens a sheet that says so, its switch disabled', async () => {
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

      const stamp = page.getByRole('button', { name: 'Playing from Den Remux' });
      await expect(stamp).toHaveText('Den Remux');
      await stamp.tap();
      const sheet = page.getByRole('menu', { name: 'Playing from Den Remux' });
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
