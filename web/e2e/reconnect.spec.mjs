// A connection that drops mid-film must never end playback. The picture holds on the buffer, "Reconnecting…" shows
// once it runs out, and playback carries on from the same second on the same session when the line is back — no
// refresh, no new session, no other release. A segment whose transfer broke partway is finished with a `Range` for the
// rest, not fetched again from its first byte.
//
// den-remux is a real HTTP server here, on its own origin as a direct route is, so the breaks are real ones: a socket
// destroyed mid-body, and every segment request refused for half a minute.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { guardNetwork, routeTmdb } from './network.mjs';

const ORIGIN = 'http://127.0.0.1:5198';
const SID = 'AbCdEfGhIjKlMnOpQrStUv';
const hls = new URL('./media/hls/', import.meta.url);
const OUTAGE_MS = 30_000;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Range, Content-Length, ETag',
};

/**
 * den-remux as far as the player can tell: sessions, the fixture's HLS, and ranges of a segment with its ETag as the
 * real one serves them. `plan` decides what happens to each segment request.
 */
function remux(plan) {
  const heard = { sessions: [], ended: [], reports: [], media: [] };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://remux.test').pathname;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      if (req.method === 'OPTIONS')
        return res
          .writeHead(204, {
            ...cors,
            'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
            'access-control-allow-headers': 'Range, If-Range, Content-Type, Authorization',
          })
          .end();
      if (req.method === 'POST' && path === '/direct/session') {
        heard.sessions.push(JSON.parse(body || '{}'));
        return res.writeHead(201, { ...cors, 'content-type': 'application/json' }).end(
          JSON.stringify({
            sid: SID,
            playlist: `/direct/s/${SID}/sig/master.m3u8`,
            duration: 60,
            release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
            video: { codec: 'vp9', transcoded: false },
            audioTrack: 0,
            audioTracks: [],
          }),
        );
      }
      if (path === '/direct/releases')
        return res
          .writeHead(200, { ...cors, 'content-type': 'application/json' })
          .end('{"releases":[]}');
      if (req.method === 'DELETE') {
        heard.ended.push(path);
        return res.writeHead(204, cors).end();
      }
      if (req.method === 'POST' && path.endsWith('/report')) {
        heard.reports.push(body);
        return res.writeHead(204, cors).end();
      }
      const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
      let content;
      try {
        content = await readFile(new URL(file, hls));
      } catch {
        return res.writeHead(404, cors).end();
      }
      if (file.endsWith('.m3u8'))
        return res
          .writeHead(200, { ...cors, 'content-type': 'application/vnd.apple.mpegurl' })
          .end(content);
      const asked = { file, range: req.headers.range, ifRange: req.headers['if-range'] };
      heard.media.push(asked);
      const etag = `"fixture-${file}"`;
      const media = { ...cors, 'content-type': 'video/mp4', etag, 'accept-ranges': 'bytes' };
      const action = plan(asked, content);
      if (action === 'drop') return req.socket.destroy();
      if (action === 'gone')
        return res.writeHead(410, { ...cors, 'content-type': 'application/json' }).end('{}');
      if (action === 'half') {
        // All of it promised, half of it sent, and then the connection is gone.
        res.writeHead(200, { ...media, 'content-length': content.length });
        res.write(content.subarray(0, content.length >> 1));
        return setTimeout(() => req.socket.destroy(), 200);
      }
      const range = /^bytes=(\d+)-$/.exec(asked.range ?? '');
      if (range && asked.ifRange === etag) {
        const start = Number(range[1]);
        return res
          .writeHead(206, {
            ...media,
            'content-length': content.length - start,
            'content-range': `bytes ${start}-${content.length - 1}/${content.length}`,
          })
          .end(content.subarray(start));
      }
      res.writeHead(200, { ...media, 'content-length': content.length }).end(content);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, heard, port: server.address().port })),
  );
}

async function open(plan) {
  const { server, heard, port } = await remux(plan);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
  await page.route(`http://127.0.0.1:${port}/**`, (r) => r.continue());
  await page.goto(`${ORIGIN}/test/player.html?remux=http://127.0.0.1:${port}/direct`);
  const close = async () => {
    await browser.close();
    server.close();
  };
  return { page, heard, close };
}

const video = (page) => page.locator('.player video');
const at = (page) => video(page).evaluate((v) => v.currentTime);

test('a connection gone for half a minute is waited out, and playback carries on where it was', async () => {
  test.setTimeout(120_000);
  // Everything from seg4 on fails for OUTAGE_MS from the first time it is asked for: the player has eight seconds
  // of picture, and then nothing arrives until the line comes back.
  let downUntil;
  const { page, heard, close } = await open(({ file }) => {
    const n = Number(/^seg(\d+)\.m4s$/.exec(file)?.[1] ?? -1);
    if (n < 4) return 'serve';
    downUntil ??= Date.now() + OUTAGE_MS;
    return Date.now() < downUntil ? 'drop' : 'serve';
  });
  try {
    await expect.poll(() => at(page), { timeout: 30_000 }).toBeGreaterThan(1);
    await video(page).evaluate((v) => (v.dataset.before = 'outage'));
    // The buffer runs out at eight seconds, and the player says why it is holding rather than failing.
    const reconnecting = page.getByText('Reconnecting…');
    await expect(reconnecting).toBeVisible({ timeout: 20_000 });
    const held = await at(page);
    expect(held).toBeGreaterThan(6);
    expect(Date.now()).toBeLessThan(downUntil);
    // Still waiting well into the outage: no error, and the same picture held.
    await page.waitForTimeout(10_000);
    await expect(reconnecting).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // The line comes back: playback goes on past where it stopped, in the same element, on the same session.
    await expect.poll(() => at(page), { timeout: 45_000 }).toBeGreaterThan(held + 3);
    expect(Date.now()).toBeGreaterThanOrEqual(downUntil);
    await expect(reconnecting).toHaveCount(0);
    await expect(page.locator('.player video[data-before="outage"]')).toHaveCount(1);
    expect(heard.sessions, 'no new session was asked for').toHaveLength(1);
    expect(heard.sessions[0]).not.toHaveProperty('transcode');
    expect(heard.ended, 'the session was never ended').toEqual([]);
    // The stall itself goes to den-remux's log as playback stats, as any stall does; nothing as a failure.
    const failures = heard.reports.filter((r) => !JSON.parse(r).stats);
    expect(failures, 'nothing was reported as a playback failure').toEqual([]);
    expect(heard.media.filter((m) => m.file === 'seg4.m4s').length).toBeGreaterThan(3);
  } finally {
    await close();
  }
});

test('a segment broken partway is finished with a range for the rest, and plays', async () => {
  let broke = false;
  let whole = 0;
  const { page, heard, close } = await open(({ file }, content) => {
    if (file !== 'seg2.m4s' || broke) return 'serve';
    broke = true;
    whole = content.length;
    return 'half';
  });
  try {
    await expect.poll(() => at(page), { timeout: 30_000 }).toBeGreaterThan(7);
    const asked = heard.media.filter((m) => m.file === 'seg2.m4s');
    expect(asked).toHaveLength(2);
    expect(asked[0].range).toBeUndefined();
    expect(asked[1]).toEqual({
      file: 'seg2.m4s',
      range: `bytes=${whole >> 1}-`,
      ifRange: '"fixture-seg2.m4s"',
    });
    expect(heard.sessions).toHaveLength(1);
    expect(heard.reports.filter((r) => !JSON.parse(r).stats)).toEqual([]);
  } finally {
    await close();
  }
});

// Longer than den-remux keeps a session (ten minutes idle), the line comes back to a session that is gone. That is
// said plainly, with one tap to pick up at the same second: never a silent restart from the beginning. The same end
// comes when the loader stops asking after that long; that wait is covered by resumingLoader's own tests.
test('a session that did not survive the drop is resumed with one tap at the same second', async () => {
  let gone = false;
  const { page, heard, close } = await open(({ file }) => {
    const n = Number(/^seg(\d+)\.m4s$/.exec(file)?.[1] ?? -1);
    if (heard.sessions.length > 1 || n < 4) return 'serve';
    if (!gone) {
      gone = true;
      setTimeout(() => (gone = 'expired'), 12_000);
    }
    return gone === 'expired' ? 'gone' : 'drop';
  });
  try {
    const resume = page.getByRole('button', { name: /^Resume from 0:0\d$/ });
    await expect(resume).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('The connection was gone too long')).toBeVisible();
    expect(heard.sessions, 'nothing started again on its own').toHaveLength(1);
    await resume.click();
    await expect.poll(() => heard.sessions.length).toBe(2);
    const startAt = heard.sessions[1].startAt;
    expect(startAt).toBeGreaterThan(6);
    expect(startAt).toBeLessThan(9);
    expect(heard.sessions[1]).toMatchObject({ filename: 'fixture.mkv' });
    await expect.poll(() => at(page), { timeout: 30_000 }).toBeGreaterThan(startAt + 1);
  } finally {
    await close();
  }
});
