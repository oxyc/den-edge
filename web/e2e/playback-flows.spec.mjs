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
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));
const cors = { 'access-control-allow-origin': '*' };

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
 * The player with `answer` from Hearth's playback route at `playback`. `home`: whether the home-network listener
 * answers, as on home Wi-Fi; away, it is a name nothing answers.
 */
async function open({ answer, home, playback = '/den/config/playback', scout }) {
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
  });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  const asked = { playback: [], releases: [] };
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}${playback}`, (r) => {
    asked.playback.push(r.request().postDataJSON());
    return r.fulfill({ json: answer });
  });
  await page.route(`${ORIGIN}/remux/releases`, (r) => {
    asked.releases.push(r.request().postDataJSON());
    return r.fulfill({
      json: { releases: [{ label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 }] },
    });
  });
  await page.route(`${ORIGIN}/den/**/subtitles/**`, (r) =>
    r.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.route(`${ORIGIN}/playback/**`, (r) => r.fulfill({ status: 204 }));
  for (const host of [PUBLIC, CDN, ...(home ? [LAN] : [])])
    await context.route(`${host}/**`, (r) => r.continue());
  if (!home) await context.route(`${LAN}/**`, (r) => r.abort('addressunreachable'));
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

test('owner at home plays from the home-network listener', async () => {
  const { browser, page, asked } = await open({ answer: remuxAnswer, home: true });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['lan.test']));
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

test('owner away plays from the public listener', async () => {
  const { browser, page, asked } = await open({ answer: remuxAnswer, home: false });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['media.test']));
    await stamped(page, 'Den Remux');
  } finally {
    await browser.close();
  }
});

test('a guest on the host’s Hearth plays, and lists releases under its own name for the host’s install', async () => {
  const { browser, page, asked } = await open({
    answer: remuxAnswer,
    home: false,
    playback: `/den/~${GUEST}/playback`,
    scout: `${ORIGIN}/den/~${GUEST}`,
  });
  try {
    await playingPast(castVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['media.test']));
    await expect.poll(() => asked.releases.length).toBeGreaterThan(0);
    expect(asked.releases[0].scout).toBe(`${ORIGIN}/den/~${GUEST}`);
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
  });
  try {
    await playingPast(pageVideo(page), 3);
    expect(asked.playback).toHaveLength(1);
    expect(segmentHosts()).toEqual(new Set(['flux.wnam.tb-cdn.io']));
    await stamped(page, 'TorBox');
  } finally {
    await browser.close();
  }
});
