// A session played away from home is played by the cast page, on the public media address — which the player's own
// page may not connect to. So the cast page is what reports how playing went and ends the session: before it did,
// den-remux heard nothing from such a session, not its stats, not its failure, not its end.
//
// This is the real cast page, built for the fixture's origin and served on its own, with den-remux answering on a
// separate https origin the player's page cannot reach.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork, routeTmdb } from './network.mjs';

const ORIGIN = 'http://127.0.0.1:5198';
const CAST = 'https://cast.test';
const MEDIA = 'https://media.test';
const SID = 'AbCdEfGhIjKlMnOpQrStUv';
const SIG = 'sIgNaTuReSiGnAtUrE0123';
const PATH = `/remux/s/${SID}/${SIG}`;
const hls = new URL('./media/hls/', import.meta.url);
const web = fileURLToPath(new URL('..', import.meta.url));

const cors = { 'access-control-allow-origin': '*' };
/** What den-remux was told, by the fixture's media server. */
const heard = { reports: [], ended: [] };
/** Whether the media server drops the connection a request for `file` came on, as a line that went away does. */
let dropping = () => false;

/**
 * den-remux on `MEDIA`, as a real https server rather than a Playwright route: the cast page's last report and its
 * end go as its frame is removed, and a route never sees a request from a frame that is gone. The browser is pointed
 * at it with a host rule, and takes its throwaway certificate.
 */
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
      'subjectAltName=DNS:media.test',
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
      const path = new URL(req.url, MEDIA).pathname;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        // A DELETE is preflighted; den-remux answers a signed session path's preflight with what it allows.
        if (req.method === 'OPTIONS')
          return res
            .writeHead(204, {
              ...cors,
              'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
            })
            .end();
        if (req.method === 'POST' && path === `${PATH}/report`) {
          heard.reports.push(JSON.parse(body || '{}'));
          return res.writeHead(204, cors).end();
        }
        if (req.method === 'DELETE' && path === PATH) {
          heard.ended.push(path);
          return res.writeHead(204, cors).end();
        }
        const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
        if (dropping(file)) return req.socket.destroy();
        try {
          const content = await readFile(new URL(file, hls));
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
  built = mkdtempSync(join(tmpdir(), 'den-cast-'));
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
  heard.reports.length = 0;
  heard.ended.length = 0;
  dropping = () => false;
});

async function open({ grants = [] } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP media.test 127.0.0.1:${server.address().port}`,
      '--ignore-certificate-errors',
      // The fixture's den-remux is on this machine; the real one is a public address.
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
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: { castOrigin: CAST } }));
  await page.route(`${ORIGIN}/remux/session`, (r) =>
    r.fulfill({
      status: 201,
      json: {
        playlist: `${PATH}/master.m3u8`,
        duration: 60,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        video: { codec: 'h264', transcoded: false },
        audioTrack: 0,
        audioTracks: [],
        publicBase: MEDIA,
        castOrigin: CAST,
      },
    }),
  );
  await page.route(`${ORIGIN}/remux/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/remux/grant`, (r) => {
    grants.push(r.request().postDataJSON());
    return r.fulfill({ status: 204 });
  });
  await context.route(`${MEDIA}/**`, (r) => r.continue());
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
  // Google's Cast SDK: absent here, as in a browser without Cast.
  await context.route('https://www.gstatic.com/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  await page.goto(`${ORIGIN}/test/player.html?remux=/remux`);
  return { browser, page };
}

/** The cast page's video, once it is past `seconds`. */
async function playingPast(page, seconds) {
  const frame = page.frameLocator('iframe[title="Den Cast player"]');
  await expect
    .poll(() => frame.locator('video').evaluate((v) => (v.paused ? -1 : v.currentTime)), {
      timeout: 30_000,
    })
    .toBeGreaterThan(seconds);
}

test('a session the cast page plays reports its stats and is ended when the player closes', async () => {
  const { browser, page } = await open();
  try {
    await playingPast(page, 3);
    // A request a removed frame makes is held by Playwright's interception for good, never reaching the server, so
    // the routes go before the frame does. Closing asks this page's own server for nothing.
    await page.unrouteAll();
    await page.context().unrouteAll();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('iframe[title="Den Cast player"]')).toHaveCount(0);
    await expect.poll(() => heard.ended, { timeout: 10_000 }).toEqual([PATH]);
    await expect.poll(() => heard.reports.length).toBe(1);
    const [report] = heard.reports;
    expect(report).toMatchObject({ code: 0, message: 'playback stats (end)' });
    // hls.js, as in the player (`nativeHls`), though Chrome claims HLS of its own: only hls.js rides out a dropped
    // connection (`resumingLoader`).
    expect(report.stats).toMatchObject({ event: 'end', engine: 'hls.js' });
    // Once, from the cast page: the player's page, which may not connect there, sends neither.
    await page.waitForTimeout(1_000);
    expect(heard.ended).toHaveLength(1);
    expect(heard.reports).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('a failure in the cast page is reported to den-remux by the cast page itself', async () => {
  const { browser, page } = await open();
  try {
    await playingPast(page, 1);
    // A decoder refusal: the element's own error, which the page reports before telling the player.
    await page
      .frameLocator('iframe[title="Den Cast player"]')
      .locator('video')
      .evaluate((v) => v.dispatchEvent(new Event('error')));
    await expect.poll(() => heard.reports.map((r) => r.message)).toContain('Playback failed');
  } finally {
    await browser.close();
  }
});

// Away from home the cast page plays, from the public media address, whose listener lets in only the address the
// session started from. A viewer whose connection dropped may be back on another (Wi-Fi to mobile), so while its
// segments fail the cast page has the player ask den-edge to let this browser in again — only the player's page can —
// and plays on from the same second when they arrive.
test('a connection that drops is waited out in the cast page, which has the player let it in again', async () => {
  test.setTimeout(90_000);
  let downUntil;
  dropping = (file) => {
    const n = Number(/^seg(\d+)\.m4s$/.exec(file)?.[1] ?? -1);
    if (n < 4) return false;
    downUntil ??= Date.now() + 12_000;
    return Date.now() < downUntil;
  };
  const grants = [];
  const { browser, page } = await open({ grants });
  try {
    await playingPast(page, 1);
    const frame = page.frameLocator('iframe[title="Den Cast player"]');
    await expect(frame.getByText('Reconnecting…')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => grants.length).toBeGreaterThan(0);
    expect(grants[0]).toEqual({
      playlist: `${PATH}/master.m3u8`,
      scout: 'http://scout.test/config',
    });
    await playingPast(page, 10);
    expect(Date.now()).toBeGreaterThanOrEqual(downUntil);
    await expect(frame.getByText('Reconnecting…')).toBeHidden();
    expect(heard.reports.filter((r) => !r.stats)).toEqual([]);
    expect(heard.ended).toEqual([]);
  } finally {
    await browser.close();
  }
});
