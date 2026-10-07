// Automatic release switching on an iPhone's native HLS player (WebKit, as Safari, Brave and Chrome on iOS all
// play it). Fauda S1E3 on home Wi-Fi hopped between "13 GB" and "6.3 GB" every 10–30 s: the native path has no
// byte loader, so between two whole segments landing in `buffered` its measured rate read 0, and a rate of 0 sent
// a switch with no `fitsOnly`/`maxBitrate` at all — den-remux then opened its own favourite, a heavier copy. These
// reproduce each symptom against a fake den-remux that does what the real one did with such a request. macOS's
// WebKit plays them natively, as an iPhone does; Linux's (CI) has no native HLS and plays them through hls.js.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test, expect, webkit, devices } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const SEGMENT_SECS = 2;
/** The fixture's own segments: a longer run repeats them across discontinuities. */
const FIXTURE_SEGMENTS = 30;

test.skip(
  !process.env.CI && !existsSync(webkit.executablePath()),
  'needs WebKit: npx playwright install webkit',
);

/**
 * The fixture's own bytes per segment. Every copy serves these, and what den-remux says each copy sends is these
 * scaled by the copy's `scale`: hls.js (Linux WebKit has no native HLS) measures the bytes that really arrive, so
 * a copy said to send more than is served would read as a link far slower than the one the test means.
 */
const FIXTURE_BYTES = Array.from(
  { length: FIXTURE_SEGMENTS },
  (_, n) => statSync(new URL(`seg${n}.m4s`, hls)).size,
);
const FIXTURE_BITRATE =
  (FIXTURE_BYTES.reduce((sum, b) => sum + b, 0) * 8) / (FIXTURE_SEGMENTS * SEGMENT_SECS);

/**
 * Three copies of one episode, as den-scout lists them: the labels carry pack sizes, the bitrates are per file. A is
 * the fixture as it is; B, the "6.3 GB", a quarter of it; C, the "68 GB", twice it.
 */
const copy = (filename, label, scale) => ({
  filename,
  label,
  plays: 'yes',
  scale,
  bitrate: FIXTURE_BITRATE * scale,
});
const A = copy('a.mkv', '1080p • WEB-DL • 13 GB', 1);
const B = copy('b.mkv', '1080p • WEB-DL • 6.3 GB', 0.25);
const C = copy('c.mkv', '2160p • WEB-DL • 68 GB', 2);
const RELEASES = [A, B, C];

function playlist(segments) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${SEGMENT_SECS}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (let n = 0; n < segments; n++) {
    if (n > 0 && n % FIXTURE_SEGMENTS === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${SEGMENT_SECS}.000000,`, `seg${n}.m4s`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * den-remux for one title: `/session` opens the release asked for, else — like the real one — the best copy left,
 * the heaviest, that fits `maxBitrate` when `fitsOnly` asks for that, and `no_fitting_copy` when none does. Media is
 * the fixture's, each segment made `delayMs(release, segment, k)` after it is first asked for — `k` counting that
 * session's segments from 1, since a switch starts mid-film — and every request for it answered once it is.
 */
async function fakeRemux(page, { segments = FIXTURE_SEGMENTS, delayMs = () => 0 } = {}) {
  const duration = segments * SEGMENT_SECS;
  const asked = [];
  const served = [];
  const outcomes = [];
  await page.route(`${ORIGIN}/direct/releases`, (r) =>
    r.fulfill({
      json: {
        releases: RELEASES.map(({ filename, label, plays }) => ({ filename, label, plays })),
      },
    }),
  );
  await page.route(`${ORIGIN}/direct/session`, (r) => {
    const want = JSON.parse(r.request().postData() ?? '{}');
    asked.push(want);
    const exclude = new Set(want.exclude ?? []);
    let release = want.filename && RELEASES.find((one) => one.filename === want.filename);
    if (!release) {
      const left = RELEASES.filter((one) => !exclude.has(one.filename))
        .filter(
          (one) => !want.fitsOnly || (want.maxBitrate && one.bitrate * 1.1 <= want.maxBitrate),
        )
        .sort((x, y) => y.bitrate - x.bitrate);
      // The first session of a visit is the 13 GB copy, as den-remux's own pick was that evening.
      release = !want.exclude?.length && !want.fitsOnly && left.includes(A) ? A : left[0];
    }
    if (!release) return r.fulfill({ status: 404, json: { error: 'no_fitting_copy' } });
    served.push(release.filename);
    const sid = `${release.filename[0]}${served.length}`;
    const bytes = (n) => FIXTURE_BYTES[n % FIXTURE_SEGMENTS] * release.scale;
    return r.fulfill({
      status: 201,
      json: {
        sid,
        playlist: `/direct/s/${sid}/sig/master.m3u8`,
        duration,
        release: {
          filename: release.filename,
          label: release.label,
          size: (release.bitrate * duration) / 8,
        },
        need: Math.round(release.bitrate * 1.1),
        segments: Array.from({ length: segments }, (_, n) => [n * SEGMENT_SECS, bytes(n)]),
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [],
      },
    });
  });
  /** Segments asked for so far, by session, and when each is made. */
  const fetched = new Map();
  const due = new Map();
  await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
    const request = r.request();
    if (request.method() !== 'GET') return r.fulfill({ status: 204 });
    const [sid, , file] = new URL(request.url()).pathname.split('/').slice(-3);
    if (file === 'master.m3u8')
      return r.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nmedia.m3u8\n',
      });
    if (file.endsWith('.m3u8'))
      return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: playlist(segments) });
    const n = /^seg(\d+)\.m4s$/.exec(file)?.[1];
    const release = RELEASES.find((one) => one.filename[0] === sid[0]);
    if (n !== undefined) {
      // Made once, by when it is due: a player's retry, or a check of it, waits for the same segment.
      const key = `${sid}/${n}`;
      if (!due.has(key)) {
        const k = (fetched.get(sid) ?? 0) + 1;
        fetched.set(sid, k);
        due.set(key, Date.now() + delayMs(release, Number(n), k));
      }
      const ms = due.get(key) - Date.now();
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const local = n === undefined ? file : `seg${Number(n) % FIXTURE_SEGMENTS}.m4s`;
    return r.fulfill({ contentType: 'video/mp4', body: await readFile(new URL(local, hls)) });
  });
  await page.route(`${ORIGIN}/playback/outcome`, (r) => {
    outcomes.push(JSON.parse(r.request().postData() ?? '{}'));
    return r.fulfill({ status: 204 });
  });
  return { asked, served, outcomes };
}

async function openPlayer() {
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 15'] });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt4565380' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
  return { browser, page };
}

const position = (page) =>
  page.evaluate(() => document.querySelector('.player video')?.currentTime ?? 0);

async function playsTo(page, seconds, timeout = 60_000) {
  await expect.poll(() => position(page), { timeout }).toBeGreaterThan(seconds);
}

/** Every switch the player made on its own: a session asked for with no release named. */
const automatic = (asked) => asked.slice(1).filter((want) => !want.filename);

test('a release the viewer picked is never switched away from, and the pick outlives a reload @soak', async () => {
  test.setTimeout(240_000);
  const { browser, page } = await openPlayer();
  try {
    // Once picked, B comes in a burst of three segments, and then the link starves it: each 2 s segment takes 5 s.
    const remux = await fakeRemux(page, {
      delayMs: (release, _n, k) => (release === B && k > 3 ? 5_000 : 0),
    });
    await page.goto(`${ORIGIN}/test/player.html`);
    await expect(page.locator('select[aria-label="Release"] option')).toHaveCount(3);
    await playsTo(page, 1);

    await page.locator('select[aria-label="Release"]').selectOption(B.filename);
    await expect.poll(() => remux.served.at(-1)).toBe(B.filename);
    await expect(page.locator('.release')).toContainText(B.label);

    // It stalls, and stalls again, early in its playing — where an automatic pick would be moved: nothing is asked
    // for on its own, and the viewer is told and offered another.
    await page.waitForTimeout(45_000);
    expect(remux.asked).toHaveLength(2);
    await expect(page.getByText(`${B.label} needs more than this connection`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Try another release' })).toBeVisible();
    expect(remux.served).toEqual([A.filename, B.filename]);
    expect(remux.asked).toHaveLength(2);

    // The same visit, reloaded: B is still the viewer's pick.
    await page.reload();
    await expect.poll(() => remux.asked.length).toBe(3);
    expect(remux.asked[2].filename).toBe(B.filename);
  } finally {
    await browser.close();
  }
});

test('a link too slow for the playing copy moves only to a lighter one, then says nothing contradictory @soak', async () => {
  test.setTimeout(150_000);
  const { browser, page } = await openPlayer();
  try {
    const remux = await fakeRemux(page, {
      // A: four segments in a burst, then the link starves it — each 2 s segment takes 5 s to come. B: its fourth
      // segment held long enough for its buffer to stand still for several seconds — the native player pacing
      // itself between bursts, not a slow link.
      delayMs: (release, n, k) =>
        release === A ? (n >= 4 ? 5_000 : 0) : release === B && k === 4 ? 6_000 : 0,
    });
    await page.goto(`${ORIGIN}/test/player.html`);
    await playsTo(page, 1);

    await expect.poll(() => remux.asked.length, { timeout: 90_000 }).toBeGreaterThan(1);
    const [, ask] = remux.asked;
    // Asked only for a copy that fits under what A itself needs, by A's real bitrate rather than its pack label.
    expect(ask.fitsOnly).toBe(true);
    expect(ask.maxBitrate).toBeLessThan(A.bitrate);
    expect(remux.served[1]).toBe(B.filename);
    await expect(
      page.getByText(`${A.label} was too slow for this connection — playing ${B.label}`, {
        exact: false,
      }),
    ).toBeVisible();

    // B plays on through its one held segment: no further switch, and never a "slower than it needs" for the very
    // release it just moved to.
    const at = await position(page);
    await playsTo(page, at + 20, 60_000);
    // Nothing further, and never back to the copy it left.
    expect(remux.served).toEqual([A.filename, B.filename]);
    await expect(page.getByText('slower than', { exact: false })).toHaveCount(0);
    await expect(page.getByText('too slow', { exact: false })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a slow start, or an error that is no MediaError, is never "couldn’t play" @soak', async () => {
  test.setTimeout(150_000);
  const { browser, page } = await openPlayer();
  try {
    // The first segment takes longer than the stuck watch's 30 s to make.
    const remux = await fakeRemux(page, { delayMs: (_release, n) => (n === 0 ? 34_000 : 0) });
    await page.goto(`${ORIGIN}/test/player.html`);
    await playsTo(page, 12, 90_000);
    await expect(page.getByText('couldn’t play', { exact: false })).toHaveCount(0);
    expect(automatic(remux.asked)).toEqual([]);

    // What iOS fired as the page came back from the background: an `error` with no MediaError behind it.
    await page.locator('video').evaluate((video) => video.dispatchEvent(new Event('error')));
    const at = await position(page);
    await playsTo(page, at + 10);
    await expect(page.getByText('couldn’t play', { exact: false })).toHaveCount(0);
    expect(remux.served).toEqual([A.filename]);
  } finally {
    await browser.close();
  }
});

test('a release that couldn’t play is not the automatic pick again after a reload', async () => {
  const { browser, page } = await openPlayer();
  try {
    const remux = await fakeRemux(page);
    await page.goto(`${ORIGIN}/test/player.html`);
    await playsTo(page, 1);
    await page.locator('video').evaluate((video) => {
      Object.defineProperty(video, 'error', {
        value: { code: 3, message: 'decode test' },
        configurable: true,
      });
      video.dispatchEvent(new Event('error'));
    });
    await expect.poll(() => remux.served.length).toBe(2);
    await page.reload();
    await expect.poll(() => remux.asked.length).toBe(3);
    expect(remux.asked[2].exclude).toContain(A.filename);
    expect(remux.served[2]).not.toBe(A.filename);
  } finally {
    await browser.close();
  }
});

test('a full buffer that stops growing is no slow link: nothing switches, least of all to a heavier copy @soak', async () => {
  test.setTimeout(150_000);
  const { browser, page } = await openPlayer();
  try {
    const remux = await fakeRemux(page, { segments: 120 });
    await page.goto(`${ORIGIN}/test/player.html`);
    await playsTo(page, 60, 120_000);
    expect(remux.asked).toHaveLength(1);
    expect(remux.served).toEqual([A.filename]);
  } finally {
    await browser.close();
  }
});

test('four minutes of ordinary jitter switch nothing @soak', async () => {
  test.setTimeout(420_000);
  const { browser, page } = await openPlayer();
  try {
    const segments = 120;
    const remux = await fakeRemux(page, {
      segments,
      // Every few segments one is late, now and then by more than a segment's worth: a home link as it is, with
      // the buffer ahead pacing the fetches between. Never the first after a discontinuity, which only this fixture
      // has (den-remux's playlists have none), and which WebKit doesn't come back from when it is late.
      delayMs: (_release, n) =>
        n % FIXTURE_SEGMENTS === 0 ? 0 : n % 11 === 5 ? 5_000 : n % 5 === 2 ? 1_500 : 0,
    });
    await page.goto(`${ORIGIN}/test/player.html`);
    await playsTo(page, segments * SEGMENT_SECS - 10, 360_000);
    expect(remux.asked).toHaveLength(1);
    expect(remux.served).toEqual([A.filename]);
    await expect(page.getByText('too slow', { exact: false })).toHaveCount(0);
    await expect(page.getByText('slower than', { exact: false })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
