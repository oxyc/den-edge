// The viewer flows every playback change must hold for, each played end to end with the real pieces: the real cast
// page build, a real https server for every media host (the home-network listener, the public listener, TorBox's
// CDN), and Den Hearth's playback answer in the shape it really sends. Each flow checks that it plays and which host
// its bytes came from. 2026-10-17 had a bug in each of these that nobody re-ran: the cast page refusing Hearth's
// speed URL (away), the release list a 400 (guest), the home address never offered (home).
//
// The anonymous visitor plays trailers only; their transport is `direct-trailer-fallback.spec.mjs`.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const PUBLIC = 'https://media.test';
const LAN = 'https://lan.test:8449';
const CDN = 'https://flux.wnam.tb-cdn.io';
const SID = 'AbCdEfGhIjKlMnOpQrStUv';
const SIG = 'sIgNaTuReSiGnAtUrE0123';
const PATH = `/remux/s/${SID}/${SIG}`;
const GUEST = 'dceafce0';
const GUEST_SECRET = 'guest-flow-secret';
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));
const cors = { 'access-control-allow-origin': '*' };
/** A desktop Chrome, where the player offers Cast. */
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/** Every media request the server answered, by the host it was asked as. */
const served = [];

/** One https server standing in for every media host; the browser maps each name to it. */
function mediaServer(dir) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=media.test',
      '-addext',
      'subjectAltName=DNS:media.test,DNS:lan.test,DNS:flux.wnam.tb-cdn.io',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const server = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      const path = new URL(req.url, 'https://media.test').pathname;
      req.resume();
      req.on('end', async () => {
        if (req.method === 'OPTIONS')
          return res.writeHead(204, { ...cors, 'access-control-allow-methods': '*' }).end();
        if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(204, cors).end();
        if (path === '/remux/health') return res.writeHead(200, cors).end('{"status":"ok"}');
        const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
        try {
          const content = await readFile(new URL(file, hls));
          served.push({ host, file });
          const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
          res.writeHead(200, { ...cors, 'content-type': type }).end(content);
        } catch {
          res.writeHead(404, cors).end();
        }
      });
    },
  );
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let built;
let server;
test.beforeAll(async () => {
  built = mkdtempSync(join(tmpdir(), 'den-flows-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
    stdio: 'ignore',
  });
  server = await mediaServer(built);
});
test.afterAll(() => {
  server?.close();
  rmSync(built, { recursive: true, force: true });
});
test.beforeEach(() => {
  served.length = 0;
});

/** Den Hearth's Remux answer: the playlist on the public listener, controls as paths, no `playlist` in `session`. */
const remuxAnswer = {
  url: `${PUBLIC}${PATH}/master.m3u8`,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  publicBase: PUBLIC,
  lanBase: LAN,
  castOrigin: CAST,
  session: {
    id: SID,
    duration: 60,
    video: { codec: 'h264', transcoded: false },
    audioTrack: 0,
    audioTracks: [],
    speedUrl: `${PATH}/speed`,
    endUrl: PATH,
    heartbeatUrl: `${PATH}/heartbeat`,
    reportUrl: `${PATH}/report`,
  },
};

/** Den Hearth's TorBox answer: the provider's own HLS, no Remux session at all. */
const torboxAnswer = {
  url: `${CDN}/stream/master.m3u8?scrobbling_enabled=false`,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
};

/**
 * Den Hearth deciding as it does for an install with a TorBox key and Remux (den-hearth `managed_request`): Remux
 * where the request rules TorBox out (`directFailed`, `audioTrack`, `replaces`, a non-empty `exclude`), else TorBox
 * first. `torbox: false` is a TorBox that fails for now: Hearth falls back to Remux and says so (`degraded`), and a
 * request for TorBox alone (`directOnly`) is refused rather than given Remux.
 */
const hearthWithTorbox =
  ({ torbox = true } = {}) =>
  (body) => {
    const remuxOnly =
      body.directFailed === true ||
      body.audioTrack !== undefined ||
      body.replaces !== undefined ||
      body.exclude?.length > 0;
    if (!remuxOnly && torbox) return { json: torboxAnswer };
    if (body.directOnly)
      return {
        status: 409,
        json: {
          error: 'direct_unavailable',
          ...(remuxOnly ? {} : { cause: 'torbox_unavailable' }),
        },
      };
    return {
      json: remuxOnly
        ? remuxAnswer
        : { ...remuxAnswer, degraded: true, directFailure: 'torbox_unavailable' },
    };
  };

/**
 * The player with `answer` from Hearth's playback route at `playback` — or, as a function, what it answers for each
 * request body. `home`: whether the home-network listener
 * answers, as on home Wi-Fi; away, it is a name nothing answers. `silentLan`: at home, but the home-network listener
 * never answers this browser, as when it may not reach the local network. `lanAsked` is the origin of every frame
 * that asked the home-network listener for anything. `linkLimit`: the `maxBitrate` this browser remembers for the
 * relay's link, as from an earlier play away.
 */
async function open({
  answer,
  home,
  silentLan,
  playback = '/den/config/playback',
  scout,
  grant,
  userAgent,
  linkLimit,
  releases = [{ label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 }],
}) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP media.test 127.0.0.1:${server.address().port}, MAP lan.test 127.0.0.1:${server.address().port}, MAP flux.wnam.tb-cdn.io 127.0.0.1:${server.address().port}`,
      '--ignore-certificate-errors',
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    ...(userAgent ? { userAgent } : {}),
  });
  const page = await context.newPage();
  if (linkLimit)
    await page.addInitScript((maxBitrate) => {
      if (window === window.top)
        localStorage.setItem(
          `den.remux.link:${location.origin}/remux`,
          JSON.stringify({ at: Date.now(), maxBitrate }),
        );
    }, linkLimit);
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  const asked = { playback: [], playbackGrants: [], releases: [], lanAsked: [] };
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}${playback}`, (r) => {
    const body = r.request().postDataJSON();
    asked.playback.push(body);
    asked.playbackGrants.push(r.request().headers()['x-den-grant'] ?? null);
    return r.fulfill(typeof answer === 'function' ? answer(body) : { json: answer });
  });
  await page.route(`${ORIGIN}/remux/releases`, (r) => {
    asked.releases.push(r.request().postDataJSON());
    return r.fulfill({ json: { releases } });
  });
  await page.route(`${ORIGIN}/den/**/subtitles/**`, (r) =>
    r.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.route(`${ORIGIN}/playback/**`, (r) => r.fulfill({ status: 204 }));
  for (const host of [PUBLIC, CDN]) await context.route(`${host}/**`, (r) => r.continue());
  await context.route(`${LAN}/**`, (r) => {
    asked.lanAsked.push(new URL(r.request().frame().url()).origin);
    if (silentLan) return;
    return home ? r.continue() : r.abort('addressunreachable');
  });
  await context.route(`${CAST}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    const type = file.endsWith('.html')
      ? 'text/html'
      : file.endsWith('.js')
        ? 'text/javascript'
        : 'text/css';
    return r.fulfill({ contentType: type, body: await readFile(join(built, file)) });
  });
  await context.route('https://www.gstatic.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  const query = new URLSearchParams({ remux: '/remux', playback });
  if (scout) query.set('scout', scout);
  if (grant) query.set('grant', grant);
  await page.goto(`${ORIGIN}/test/player.html?${query}`);
  return { browser, page, asked };
}

/** The video that plays this session, in the cast page or in the page itself, once it is past `seconds`. */
async function playingPast(video, seconds) {
  await expect
    .poll(() => video.evaluate((v) => (v.paused ? -1 : v.currentTime)), { timeout: 30_000 })
    .toBeGreaterThan(seconds);
}

const castVideo = (page) => page.frameLocator('iframe[title="Den Cast player"]').locator('video');
const pageVideo = (page) => page.locator('.player video');
const segmentHosts = () =>
  new Set(served.filter((s) => s.file.endsWith('.m4s')).map((s) => s.host));
/** The player's stamp says which path is playing. */
const stamped = (page, source) => expect(page.getByTestId('playback-source')).toHaveText(source);

const castFrame = (page) => page.locator('iframe[title="Den Cast player"]');
/** The stamp's menu, opened, and its switch to `to` chosen. */
async function switchFromStamp(page, from, to) {
  await page.getByRole('button', { name: `Playing from ${from}` }).click();
  await page.getByRole('menuitem', { name: `Switch to ${to}` }).click();
}

test('owner at home plays from the home-network listener in the page itself', async () => {
  const { browser, page, asked } = await open({
    answer: remuxAnswer,
    home: true,
    userAgent: CHROME_MAC,
  });
  try {
    await playingPast(pageVideo(page), 3);
    await expect(castFrame(page)).toHaveCount(0);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['lan.test']));
    expect(new Set(asked.lanAsked)).toEqual(new Set([ORIGIN]));
    await stamped(page, 'Den Remux');
    // Casting is still offered: the page's own button, as for any session it plays.
    await expect(page.getByRole('button', { name: 'Cast to a TV' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('owner at home asks again without a link limit remembered from away', async () => {
  const { browser, page, asked } = await open({
    answer: remuxAnswer,
    home: true,
    linkLimit: 4_000_000,
  });
  try {
    await playingPast(pageVideo(page), 3);
    expect(asked.playback.map(({ maxBitrate }) => maxBitrate ?? 'none')).toEqual([
      4_000_000,
      'none',
    ]);
    expect(segmentHosts()).toEqual(new Set(['lan.test']));
  } finally {
    await browser.close();
  }
});

test('owner at home whose page can’t reach the home network plays from the public listener', async () => {
  const { browser, page, asked } = await open({ answer: remuxAnswer, home: true, silentLan: true });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['media.test']));
    // The page asked once; the cast page, which can't reach it either, is not sent there to fail.
    expect(asked.lanAsked).toEqual([ORIGIN]);
    await stamped(page, 'Den Remux');
  } finally {
    await browser.close();
  }
});

test('owner with TorBox plays the provider’s own stream in the page', async () => {
  const { browser, page, asked } = await open({ answer: torboxAnswer, home: true });
  try {
    await playingPast(pageVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['flux.wnam.tb-cdn.io']));
    await stamped(page, 'TorBox');
  } finally {
    await browser.close();
  }
});

/** The hosts media segments came from since `from` (an index into `served`). */
const segmentHostsSince = (from) =>
  new Set(
    served
      .slice(from)
      .filter((s) => s.file.endsWith('.m4s'))
      .map((s) => s.host),
  );
const position = (video) => video.evaluate((v) => v.currentTime);
/** Where the video plays once media from `host` has arrived since `from`: the new session's own position. */
async function playsFrom(video, host, from) {
  await expect.poll(() => segmentHostsSince(from).has(host), { timeout: 30_000 }).toBe(true);
  await expect
    .poll(() => video.evaluate((v) => (v.paused || v.readyState < 3 ? -1 : v.currentTime)), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  return position(video);
}

test('owner with TorBox switches to Den Remux and back from the stamp, at the same second', async () => {
  const { browser, page, asked } = await open({ answer: hearthWithTorbox(), home: true });
  try {
    const video = pageVideo(page);
    await playingPast(video, 7);
    await stamped(page, 'TorBox');
    expect(segmentHosts()).toEqual(new Set(['flux.wnam.tb-cdn.io']));

    // TorBox → Den Remux: Hearth is told the direct path is not wanted, for the same release, from where it is.
    let from = served.length;
    const at = await position(video);
    await switchFromStamp(page, 'TorBox', 'Den Remux');
    await stamped(page, 'Den Remux');
    expect(asked.playback).toHaveLength(2);
    expect(asked.playback[1]).toMatchObject({ directFailed: true, filename: 'fixture.mkv' });
    expect(asked.playback[1].startAt).toBeGreaterThan(at - 1);
    const onRemux = await playsFrom(video, 'lan.test', from);
    expect(onRemux).toBeGreaterThan(at - 1);
    expect(onRemux).toBeLessThan(at + 15);
    expect(segmentHostsSince(from)).toEqual(new Set(['lan.test']));
    await playingPast(video, onRemux + 1);

    // Den Remux → TorBox: TorBox alone, so Hearth can't answer with a Remux session in the playing one's slot.
    from = served.length;
    const back = await position(video);
    await switchFromStamp(page, 'Den Remux', 'TorBox');
    await stamped(page, 'TorBox');
    expect(asked.playback).toHaveLength(3);
    expect(asked.playback[2]).toMatchObject({ directOnly: true, filename: 'fixture.mkv' });
    expect(asked.playback[2]).not.toHaveProperty('replaces');
    expect(asked.playback[2]).not.toHaveProperty('directFailed');
    expect(asked.playback[2].startAt).toBeGreaterThan(back - 1);
    const onTorbox = await playsFrom(video, 'flux.wnam.tb-cdn.io', from);
    expect(onTorbox).toBeGreaterThan(back - 1);
    expect(onTorbox).toBeLessThan(back + 15);
    expect(segmentHostsSince(from)).toEqual(new Set(['flux.wnam.tb-cdn.io']));
    await playingPast(video, onTorbox + 1);
  } finally {
    await browser.close();
  }
});

test('a viewer whose Hearth has only Remux gets the switch disabled, and the reason', async () => {
  const { browser, page, asked } = await open({ answer: remuxAnswer, home: true });
  try {
    await playingPast(pageVideo(page), 3);
    await stamped(page, 'Den Remux');
    await page.getByRole('button', { name: 'Playing from Den Remux' }).click();
    const menu = page.getByRole('menu', { name: 'Playing from Den Remux' });
    await expect(menu).toContainText('This Hearth has no TorBox to play from');
    await expect(menu.getByRole('menuitem', { name: 'Switch to TorBox' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(asked.playback).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('a switch to TorBox that Hearth refuses keeps Den Remux playing and says so', async () => {
  const { browser, page, asked } = await open({
    answer: hearthWithTorbox({ torbox: false }),
    home: true,
  });
  try {
    const video = pageVideo(page);
    await playingPast(video, 7);
    // Hearth tried TorBox first and fell back: TorBox is this viewer's to try again.
    await stamped(page, 'Den Remux');
    const from = served.length;
    const at = await position(video);
    await switchFromStamp(page, 'Den Remux', 'TorBox');
    await expect(
      page.getByRole('status').filter({ hasText: 'TorBox couldn’t play this release just now' }),
    ).toBeVisible();
    expect(asked.playback).toHaveLength(2);
    expect(asked.playback[1]).toMatchObject({ directOnly: true, filename: 'fixture.mkv' });
    await stamped(page, 'Den Remux');
    // The same session plays on from where it was: no restart, and nothing from TorBox's host.
    expect(await position(video)).toBeGreaterThanOrEqual(at);
    await playingPast(video, at + 2);
    expect(segmentHostsSince(from).has('flux.wnam.tb-cdn.io')).toBe(false);
    expect(segmentHosts()).toEqual(new Set(['lan.test']));
  } finally {
    await browser.close();
  }
});

test('owner away plays from the public listener', async () => {
  const { browser, page, asked } = await open({ answer: remuxAnswer, home: false });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['media.test']));
    expect(asked.lanAsked).toEqual([ORIGIN]);
    await stamped(page, 'Den Remux');
  } finally {
    await browser.close();
  }
});

test('a guest on the host’s Hearth plays, and lists releases under its own name for the host’s install', async () => {
  const sharedReleases = [
    { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
    {
      label: 'Fixture 4K · 12 GB',
      filename: 'fixture-owner-first-choice.mkv',
      size: 12_000_000_000,
    },
    {
      label: 'Fixture 720p · 2 GB',
      filename: 'fixture-owner-third-choice.mkv',
      size: 2_000_000_000,
    },
  ];
  const { browser, page, asked } = await open({
    answer: remuxAnswer,
    home: false,
    playback: `/den/~${GUEST}/playback`,
    scout: `${ORIGIN}/den/~${GUEST}`,
    grant: `${GUEST}:${GUEST_SECRET}`,
    releases: sharedReleases,
  });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(asked.playbackGrants).toEqual([`${GUEST}:${GUEST_SECRET}`]);
    expect(segmentHosts()).toEqual(new Set(['media.test']));
    await expect.poll(() => asked.releases.length).toBeGreaterThan(0);
    expect(asked.releases[0].scout).toBe(`${ORIGIN}/den/~${GUEST}`);
    const streamPicker = page.getByRole('button', { name: /^Stream:/ });
    await streamPicker.focus();
    await streamPicker.press('Enter');
    const choices = page.getByRole('menu', { name: /^Stream:/ }).getByRole('menuitemradio');
    await expect(choices).toHaveCount(sharedReleases.length);
    for (const [index, { label, filename }] of sharedReleases.entries()) {
      await expect(choices.nth(index)).toContainText(label);
      await expect(choices.nth(index)).toContainText(filename);
    }
    await stamped(page, 'Den Remux');
  } finally {
    await browser.close();
  }
});

test('a guest with their own TorBox plays the provider’s stream in the page', async () => {
  const { browser, page, asked } = await open({
    answer: torboxAnswer,
    home: false,
    playback: `/den/~${GUEST}/playback`,
    scout: `${ORIGIN}/den/~${GUEST}`,
    grant: `${GUEST}:${GUEST_SECRET}`,
  });
  try {
    await playingPast(pageVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(asked.playbackGrants).toEqual([`${GUEST}:${GUEST_SECRET}`]);
    expect(segmentHosts()).toEqual(new Set(['flux.wnam.tb-cdn.io']));
    await stamped(page, 'TorBox');
  } finally {
    await browser.close();
  }
});
