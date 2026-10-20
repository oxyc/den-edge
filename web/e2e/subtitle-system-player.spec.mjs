// An OpenSubtitles subtitle on a TorBox stream is a page-side `<track>`. Where WebKit plays HLS itself (an iPhone), it
// hands the stream to the system player, whose fullscreen view and captions menu show only the renditions a playlist
// names, so that sidecar never appeared there. There an OpenSubtitles track the viewer wants is Den Remux's, whose
// master names it; hls.js, which renders the page's own `<track>`, keeps TorBox. TorBox embedded tracks take a separate
// path: Hearth asks TorBox to put the selected stream in its direct playlist.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const release = { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * A context that answers "is this an iPhone?" as an iPhone does on every platform. macOS WebKit plays HLS itself, as an
 * iPhone does; Linux WebKit, which CI runs, has no native HLS (`canPlayType` answers '' for it), so there the page took
 * itself for hls.js and the iPhone path never ran. The page asks that question of a fresh, unattached `<video>`
 * (`nativeHls`); that answer is made an iPhone's. The player's own element keeps this engine's real answer, so it still
 * plays with what the engine has: natively on macOS, through hls.js on Linux.
 */
async function iphone(browser, locale) {
  const context = await browser.newContext({ userAgent: IPHONE_UA, locale });
  await context.addInitScript(() => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      const answer = canPlayType.call(this, type);
      return answer || this.isConnected || !/mpegurl/i.test(type) ? answer : 'maybe';
    };
  });
  return context;
}

const direct = { url: `${ORIGIN}/torbox/t/media.m3u8`, release };
const remux = {
  url: '/managed-remux/s/r1/sig/master.m3u8',
  release,
  session: {
    id: 'r1',
    duration: 60,
    audioTrack: 0,
    audioTracks: [{ language: 'eng', name: null, channels: 2, commentary: false }],
    subtitles: [{ language: 'en', name: 'English (in file)' }],
    endUrl: '/managed-remux/s/r1/sig',
    heartbeatUrl: '/managed-remux/s/r1/sig/heartbeat',
    reportUrl: '/managed-remux/s/r1/sig/report',
  },
};
// As den-remux's `playlist::master` writes a rendition: DEFAULT=NO, named for its source.
const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English (in file)",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub0.m3u8"
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
  'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:30.000\nFrom the file.\n';
const srt = '1\n00:00:00,000 --> 00:00:30,000\nFrom OpenSubtitles.\n';

async function mockHearth(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
  await page.route(`${ORIGIN}/playback/outcome`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
    route.fulfill({
      json: {
        subtitles: [
          { lang: 'en', url: '/den/config/subtitle/1.srt' },
          { lang: 'sv', url: '/den/config/subtitle/2.srt' },
        ],
      },
    }),
  );
  await page.route(`${ORIGIN}/den/config/subtitle/*.srt`, (route) =>
    route.fulfill({ contentType: 'text/plain', body: srt }),
  );
  await page.route(`${ORIGIN}/den/config/cast-subtitle`, (route) => route.fulfill({ status: 503 }));
  const operations = [];
  await page.route(`${ORIGIN}/den/config/playback`, (route) => {
    const body = route.request().postDataJSON();
    operations.push(body);
    return route.fulfill({ json: body.directFailed ? remux : direct });
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
  return operations;
}

/** The showing text track's language, label and cue count, or null. */
function shown() {
  const video = document.querySelector('.player video');
  for (const track of video?.textTracks ?? [])
    if (track.mode === 'showing')
      return { language: track.language, label: track.label, cues: track.cues?.length ?? 0 };
  return null;
}

const playing = (page) =>
  page.waitForFunction(
    () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
    undefined,
    {
      timeout: 30_000,
    },
  );

test.describe('on an iPhone, which plays HLS in the system player', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here');

  test('a subtitle picked on a TorBox stream moves it to Den Remux, whose playlist names it', async () => {
    const browser = await webkit.launch();
    try {
      const context = await iphone(browser, 'en-US');
      const page = await context.newPage();
      const operations = await mockHearth(page);
      await page.goto(`${ORIGIN}/test/player.html?playback=managed&originalLanguage=en`);
      await playing(page);
      expect(operations).toHaveLength(1);
      expect(operations[0].player).toBe('native');
      expect(operations[0]).not.toHaveProperty('directFailed');
      expect(operations[0].originalLanguage).toBe('en');
      // Nothing is named showing that the system player could not show.
      expect(await page.evaluate(shown)).toBeNull();
      const menu = page.getByRole('button', { name: 'Subtitles: Off' });
      await menu.click();
      const english = page.getByRole('menuitemradio', { name: 'English' });
      await expect(english).toHaveAccessibleDescription(/OpenSubtitles/);
      await english.click();
      await expect.poll(() => operations.length, { timeout: 10_000 }).toBe(2);
      expect(operations[1].directFailed).toBe(true);
      expect(operations[1].filename).toBe('fixture.mkv');
      await expect
        .poll(() => page.evaluate(shown), { timeout: 15_000 })
        .toMatchObject({ language: 'en', label: 'English (in file)' });
      await expect.poll(async () => (await page.evaluate(shown))?.cues ?? 0).toBeGreaterThan(0);
      const selected = page.getByRole('button', { name: 'Subtitles: English (in file)' });
      await selected.click();
      await expect(page.getByRole('menuitemradio', { name: 'English (in file)' })).toBeChecked();
    } finally {
      await browser.close();
    }
  });

  test('a title in a language the browser doesn’t name starts on Den Remux, its subtitle shown', async () => {
    const browser = await webkit.launch();
    try {
      const context = await iphone(browser, 'sv-SE');
      const page = await context.newPage();
      const operations = await mockHearth(page);
      await page.goto(`${ORIGIN}/test/player.html?playback=managed&originalLanguage=he`);
      await playing(page);
      expect(operations).toHaveLength(1);
      expect(operations[0].player).toBe('native');
      expect(operations[0].directFailed).toBe(true);
      await expect
        .poll(() => page.evaluate(shown), { timeout: 15_000 })
        .toMatchObject({ language: 'en', label: 'English (in file)' });
    } finally {
      await browser.close();
    }
  });

  test('a subtitle language set in Settings starts on Den Remux', async () => {
    const browser = await webkit.launch();
    try {
      const context = await iphone(browser, 'en-US');
      const page = await context.newPage();
      const operations = await mockHearth(page);
      await page.goto(`${ORIGIN}/test/player.html?playback=managed&subtitleLanguage=en`);
      await playing(page);
      expect(operations).toHaveLength(1);
      expect(operations[0].player).toBe('native');
      expect(operations[0].directFailed).toBe(true);
      await expect
        .poll(() => page.evaluate(shown), { timeout: 15_000 })
        .toMatchObject({ language: 'en', label: 'English (in file)' });
    } finally {
      await browser.close();
    }
  });
});

const launchChromium = () =>
  chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

test('hls.js shows a subtitle picked on a TorBox stream as the page’s own track, staying on TorBox', async () => {
  const browser = await launchChromium();
  try {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const operations = await mockHearth(page);
    await page.goto(`${ORIGIN}/test/player.html?playback=managed&originalLanguage=en`);
    await playing(page);
    // English audio for an English browser: nothing comes up unasked, and the menu says so.
    expect(await page.evaluate(shown)).toBeNull();
    await page.getByRole('button', { name: 'Subtitles: Off' }).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect
      .poll(() => page.evaluate(shown), { timeout: 10_000 })
      .toMatchObject({ language: 'en', label: 'opensubtitles:0' });
    await expect.poll(async () => (await page.evaluate(shown))?.cues ?? 0).toBeGreaterThan(0);
    expect(operations).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('hls.js shows the subtitle it picks itself on a TorBox stream, not only names it', async () => {
  const browser = await launchChromium();
  try {
    // A Swedish browser and a Hebrew title: Swedish, picked without being asked.
    const context = await browser.newContext({ locale: 'sv-SE' });
    const page = await context.newPage();
    const operations = await mockHearth(page);
    await page.goto(`${ORIGIN}/test/player.html?playback=managed&originalLanguage=he`);
    await playing(page);
    const menu = page.getByRole('button', { name: /^Subtitles:/ });
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAccessibleName('Subtitles: Off');
    await expect
      .poll(() => page.evaluate(shown), { timeout: 10_000 })
      .toMatchObject({ language: 'sv', label: 'opensubtitles:1' });
    await expect.poll(async () => (await page.evaluate(shown))?.cues ?? 0).toBeGreaterThan(0);
    expect(operations).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
