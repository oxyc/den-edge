// The player's state lives in its address, through the real app: a guest's Hearth, the title's page, Play, and the
// player as Library mounts it. The viewer moves to Den Remux, picks another release, another audio track, Swedish
// subtitles and a second to be at; a reload opens the player exactly there, asking Hearth for that release, track
// and path from that second. A link naming a release Hearth no longer offers plays the usual pick, with nothing said
// but a console note. The address never holds a playlist, a signed path or a token. A Kid's policy still decides
// first: an address naming a release and a second on a title the Kid may not watch opens no player and asks Hearth
// for nothing. In Chromium (hls.js) and WebKit.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, GID, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const TITLE = 1002;
const PAGE = `/movie/${TITLE}-movie-${TITLE}`;
const A = { label: '1080p • WEB-DL • 4 GB', filename: 'Movie.1080p.WEB-DL-AAA.mkv', size: 4e9 };
const B = { label: '720p • WEB-DL • 1 GB', filename: 'Movie.720p.WEB-DL-BBB.mkv', size: 1e9 };
const RELEASES = [A, B];

const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English (in file)",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub-en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Svenska (in file)",LANGUAGE="sv",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub-sv.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
media.m3u8
`;
const subMedia = (language) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:60.0,
sub-${language}.vtt
#EXT-X-ENDLIST
`;
const vtt = (text) =>
  `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:01:00.000\n${text}\n`;

/**
 * A Hearth with TorBox and Den Remux: TorBox for an ordinary request, Remux where the request rules TorBox out. Each
 * Remux session is the release and audio track asked for, with English and Russian audio and two subtitle renditions.
 * A release it doesn't hold is `no_release`, as Hearth answers one gone from its list.
 */
function hearth(body) {
  const release = body.filename
    ? RELEASES.find((one) => one.filename === body.filename)
    : RELEASES[0];
  if (!release) return { status: 404, json: { error: 'no_release' } };
  if (!body.directFailed)
    return { json: { url: `${ORIGIN}/torbox/t/${release.filename}/media.m3u8`, release } };
  const sid = `r${Math.random().toString(36).slice(2, 10)}`;
  const base = `/managed-remux/s/${sid}/sIgNaTuRe0123`;
  return {
    json: {
      url: `${ORIGIN}${base}/master.m3u8`,
      release,
      session: {
        id: sid,
        duration: 60,
        video: { codec: 'h264', transcoded: false },
        audioTrack: body.audioTrack ?? 0,
        audioTracks: [
          { language: 'en', name: null, channels: 2, commentary: false },
          { language: 'ru', name: null, channels: 2, commentary: false },
        ],
        subtitles: [
          { language: 'en', name: 'English (in file)' },
          { language: 'sv', name: 'Svenska (in file)' },
        ],
        endUrl: base,
        heartbeatUrl: `${base}/heartbeat`,
        reportUrl: `${base}/report`,
      },
    },
  };
}

/** A guest of a host with that Hearth, on `browserType`; every playback request body lands in `playback`. */
async function guest(browserType) {
  const browser = await browserType.launch(
    browserType === chromium
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ['--autoplay-policy=no-user-gesture-required'],
        }
      : {},
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Every address this document is given, as the app writes it.
  await context.addInitScript(() => {
    window.addresses = [];
    for (const method of ['pushState', 'replaceState']) {
      const native = history[method].bind(history);
      history[method] = (state, unused, url) => {
        if (url != null) window.addresses.push(String(url));
        return native(state, unused, url);
      };
    }
  });
  const page = await context.newPage();
  const notes = [];
  page.on('console', (message) => notes.push(message.text()));
  await routeGuestEdge(page, newEdge());
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
        original_language: 'en',
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
    route.fulfill({ json: { releases: RELEASES.map((one) => ({ ...one, plays: 'yes' })) } }),
  );
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/torbox/t/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({
      contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(name, hls)),
    });
  });
  await page.route(`${ORIGIN}/managed-remux/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    const name = new URL(request.url()).pathname.split('/').pop();
    const text = {
      'master.m3u8': master,
      'sub-en.m3u8': subMedia('en'),
      'sub-sv.m3u8': subMedia('sv'),
      'sub-en.vtt': vtt('From the file.'),
      'sub-sv.vtt': vtt('Från filen.'),
    }[name];
    if (text)
      return route.fulfill({
        contentType: name.endsWith('.vtt') ? 'text/vtt' : 'application/vnd.apple.mpegurl',
        body: text,
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
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
      { timeout: 30_000 },
    )
    .toBe(true);
  return { browser, page, playback, notes };
}

const video = (page) => page.locator('.player video');
const position = (page) => video(page).evaluate((v) => v.currentTime);
const playingPast = (page, seconds) =>
  expect
    .poll(() => video(page).evaluate((v) => (v.paused ? -1 : v.currentTime)), { timeout: 30_000 })
    .toBeGreaterThan(seconds);
/** Den's transport shows on a pointer over the picture, and hides again while it plays. */
async function controls(page) {
  const box = await page.locator('.player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
async function choose(page, button, item) {
  await controls(page);
  await page.getByRole('button', { name: button }).click();
  await page.getByRole('menuitemradio').filter({ hasText: item }).first().click();
}
const address = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const params = (page) => Object.fromEntries(new URL(page.url()).searchParams);

/** Nothing the app ever put in the address names media, a signed path or a credential. */
async function noCapabilities(page) {
  const written = await page.evaluate(() => window.addresses);
  for (const one of [...written, address(page)]) {
    expect(one).not.toMatch(/:\/\/|m3u8|managed-remux|torbox|sIgNaTuRe|token|ticket|\/p\//i);
  }
}

for (const [name, browserType] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  test.describe(name, () => {
    test.skip(!existsSync(browserType.executablePath()), `${name} is not installed here`);

    test(`a reload opens the player on the release, path, audio, subtitles and second chosen (${name})`, async () => {
      const { browser, page, playback } = await guest(browserType);
      try {
        await page.goto(`${ORIGIN}${PAGE}`);
        const play = page
          .locator('[data-active="true"]')
          .getByRole('link', { name: 'Play', exact: true });
        await expect(play).toBeVisible({ timeout: 30_000 });
        await play.click();
        await playingPast(page, 1);
        expect(playback[0]).not.toHaveProperty('directFailed');

        // Den Remux, from the delivery stamp.
        await controls(page);
        await page.getByRole('button', { name: 'Playing from TorBox' }).click();
        await page.getByRole('menuitem', { name: 'Switch to Den Remux' }).click();
        await expect(page.getByRole('button', { name: 'Playing from Den Remux' })).toBeVisible({
          timeout: 30_000,
        });

        // The other release, then Russian audio, then Swedish subtitles.
        await choose(page, /^Stream: /, B.filename);
        await expect
          .poll(() => playback.at(-1))
          .toMatchObject({ filename: B.filename, directFailed: true });
        await expect(page.getByRole('button', { name: /^Stream: 720p/ })).toBeAttached({
          timeout: 30_000,
        });
        await choose(page, /^Audio track: /, 'Russian');
        await expect
          .poll(() => playback.at(-1))
          .toMatchObject({ filename: B.filename, audioTrack: 1 });
        await expect(page.getByRole('button', { name: 'Audio track: Russian' })).toBeAttached({
          timeout: 30_000,
        });
        await choose(page, /^Subtitles: /, 'Svenska');
        await expect(page.getByRole('button', { name: /^Subtitles: Svenska/ })).toBeAttached();

        // A second well into it, then paused there.
        await playingPast(page, 1);
        await video(page).evaluate((v) => (v.currentTime = 31));
        await expect.poll(() => position(page)).toBeGreaterThanOrEqual(31);
        await video(page).evaluate((v) => v.pause());
        await expect
          .poll(() => params(page))
          .toMatchObject({
            play: '1',
            source: B.filename,
            via: 'remux',
            audio: '1',
            subs: 'sv',
          });
        expect(Number(params(page).t)).toBeGreaterThanOrEqual(31);
        expect(Number(params(page).t)).toBeLessThan(40);
        const at = Number(params(page).t);
        await noCapabilities(page);

        // Reloaded: one request, for exactly that, from that second.
        const before = playback.length;
        await page.reload();
        await expect.poll(() => playback.length, { timeout: 30_000 }).toBeGreaterThan(before);
        expect(playback[before]).toMatchObject({
          filename: B.filename,
          audioTrack: 1,
          directFailed: true,
          startAt: at,
        });
        await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(at - 1);
        await expect(page.getByRole('button', { name: 'Playing from Den Remux' })).toBeAttached();
        await expect(page.getByRole('button', { name: /^Stream: 720p/ })).toBeAttached();
        await expect(page.getByRole('button', { name: 'Audio track: Russian' })).toBeAttached();
        await expect(page.getByRole('button', { name: /^Subtitles: Svenska/ })).toBeAttached();
        await expect
          .poll(() =>
            video(page).evaluate((v) =>
              [...v.textTracks].filter((t) => t.mode === 'showing').map((t) => t.language),
            ),
          )
          .toEqual(['sv']);
        await noCapabilities(page);

        // Closed, the player's state leaves the address with it.
        await controls(page);
        await page.getByRole('button', { name: 'Close' }).click();
        await expect.poll(() => address(page)).toBe(`/movie/${TITLE}`);
      } finally {
        await browser.close();
      }
    });

    test(`a link naming a release Hearth no longer offers plays the usual pick, quietly (${name})`, async () => {
      const { browser, page, playback, notes } = await guest(browserType);
      try {
        await page.goto(
          `${ORIGIN}${PAGE}?play=1&source=Movie.2160p.GONE.mkv&via=remux&audio=1&t=20`,
        );
        await playingPast(page, 1);
        expect(playback[0]).toMatchObject({
          filename: 'Movie.2160p.GONE.mkv',
          audioTrack: 1,
          directFailed: true,
        });
        // The usual pick: no release, track or path named, from the address's second all the same.
        expect(playback[1]).not.toHaveProperty('filename');
        expect(playback[1]).not.toHaveProperty('audioTrack');
        expect(playback[1]).not.toHaveProperty('directFailed');
        expect(playback[1].startAt).toBe(20);
        expect(playback).toHaveLength(2);
        expect(notes.some((note) => note.includes('no longer offered'))).toBe(true);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.locator('.player')).not.toContainText(/couldn.t|no longer/i);
        // What it names now is what plays.
        await expect.poll(() => params(page)).not.toHaveProperty('source');
        expect(params(page)).not.toHaveProperty('via');
        expect(params(page)).not.toHaveProperty('audio');
        await noCapabilities(page);
      } finally {
        await browser.close();
      }
    });
  });
}

test('a Kid’s policy refuses a title before any release or second its address names is asked for', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) =>
    route.fulfill({
      json: {
        id: 1001,
        title: 'Movie 1001',
        release_date: '2026-01-01',
        overview: 'A film for grown-ups.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18, name: 'Drama' }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
      },
    }),
  );
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  const asked = [];
  await page.route(`${ORIGIN}/den/fixture/**`, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  const path = `/movie/1001-movie-1001?play=1&source=Movie.UNRATED.CUT.mkv&audio=1&t=600`;
  await page.goto(
    `${ORIGIN}/test/library.html?play-boundary&blocked&populated&page=title&type=movie&id=1001&path=${encodeURIComponent(path)}`,
  );
  await expect(page.getByText('Blocked by parental controls').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.player')).toHaveCount(0);
  expect(asked.filter((url) => url.includes('/playback'))).toEqual([]);
  expect(await page.evaluate(() => window.denTestPlayBoundary.stats().asked)).toBeGreaterThan(0);
});
