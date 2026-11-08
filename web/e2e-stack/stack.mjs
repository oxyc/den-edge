// The real den-edge and the real den-hearth, run together for the playback e2e (`playback.spec.mjs`). Only the
// outside edges are fakes: the Stremio indexers, TorBox's API, TorBox's CDN, the debrid download host that serves the
// release file, and the root-owned helper that opens the public media listener. den-hearth is the `stub-upstreams`
// build, the one build whose fixed TorBox origins and source guard can name these fakes (den-hearth `stub.rs`); every
// other line of it, and all of den-edge, is what ships.
//
// den-edge serves the built web app on a fixed port: the cast page is built for that origin as its parent
// (`VITE_DEN_PARENT_ORIGINS`), as the image's is for the public name. Everything else takes a free port.
//
// Inputs (all required unless noted): DEN_EDGE_BIN, DEN_HEARTH_BIN (`cargo build -p den-hearth --features
// stub-upstreams`), DEN_EDGE_DIST (`npm run build`), DEN_STACK_MEDIA (a small release file, den-hearth's
// crates/remux/testdata/h264.mkv), DEN_REMUX_FFMPEG (optional, default `ffmpeg`). The cast page is built here.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttp, request as httpRequest } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HLS = join(WEB, 'e2e/media/hls');

/** den-edge's port: the origin the cast page's build names as its parent. */
export const EDGE_PORT = Number(process.env.DEN_STACK_EDGE_PORT ?? 18180);
export const EDGE = `http://127.0.0.1:${EDGE_PORT}`;
/** TorBox's managed-stream CDN, as the createstream answer names it. Browsers map it to the CDN fake. */
export const CDN_HOST = 'flux.wnam.tb-cdn.io';
const SECRET = 'stack-edge-secret';
/**
 * A Den config segment: the combined addon's Scout member with a TorBox key and its Subtitles member with an
 * OpenSubtitles key, in the clear (no keyring here).
 */
export const CONFIG = Buffer.from(
  JSON.stringify({
    iid: 'AAECAwQFBgcICQoLDA0ODw',
    ep: 0,
    scout: { debrid: [{ service: 'torbox', token: 'stack-fixture-token' }] },
    subs: { osKey: 'stack-fixture-os-key' },
  }),
).toString('base64url');
export const INSTALL = `${EDGE}/den/${CONFIG}/manifest.json`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see web/e2e-stack/stack.mjs)`);
  if (!existsSync(value)) throw new Error(`${name}=${value} does not exist`);
  return value;
}

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createNet().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
    probe.on('error', fail);
  });

const listen = (server, port = 0) =>
  new Promise((done) => server.listen(port, '127.0.0.1', () => done(server.address().port)));

/** A child process whose stderr is kept line by line; `waitFor(re)` resolves on the first line matching it. */
function child(name, bin, env) {
  const lines = [];
  const waiters = [];
  const proc = spawn(bin, [], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffered = '';
  const take = (chunk) => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop();
    for (const line of parts) {
      lines.push(line);
      for (const waiter of [...waiters])
        if (waiter.re.test(line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done(line);
        }
    }
  };
  proc.stdout.on('data', take);
  proc.stderr.on('data', take);
  const exited = new Promise((done) => proc.once('exit', (code) => done(code)));
  exited.then((code) => {
    for (const waiter of waiters.splice(0))
      waiter.fail(new Error(`${name} exited ${code}:\n${lines.slice(-40).join('\n')}`));
  });
  return {
    name,
    lines,
    /** The first line from `from` on that matches `re`, as it arrives. */
    waitFor(re, from = 0) {
      const seen = lines.slice(from).find((line) => re.test(line));
      if (seen) return Promise.resolve(seen);
      if (proc.exitCode !== null)
        return Promise.reject(new Error(`${name} exited ${proc.exitCode}:\n${lines.join('\n')}`));
      return new Promise((done, fail) => waiters.push({ re, done, fail }));
    },
    async stop() {
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}

/** A self-signed certificate for every https fake. */
function certificate(dir) {
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
      `/CN=${CDN_HOST}`,
      '-addext',
      `subjectAltName=DNS:${CDN_HOST},DNS:localhost,IP:127.0.0.1`,
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** A 40-character infohash, the same for the same seed. */
const hash = (seed) => {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(seed)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return (
    h.toString(16).padStart(16, '0') + (h ^ 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0')
  )
    .slice(0, 32)
    .padEnd(40, '0');
};

/** The release every title and episode lists, one per indexer request. */
export const releaseFor = (id) => `Fixture.${id.replace(/[^\w]/g, '.')}.1080p.WEB-DL.H264.mkv`;

/**
 * Torrentio-shaped indexer: one cached 1080p release for any movie or episode. MediaFusion is the same fake
 * answering none, so every list is complete without a second release.
 */
function indexer(log) {
  return createHttp((req, res) => {
    const path = new URL(req.url, 'http://indexer').pathname;
    log.push(`indexer ${req.method} ${path}`);
    const id = decodeURIComponent(path).match(/\/stream\/(?:movie|series)\/([^/]+)\.json$/)?.[1];
    if (!id) return json(res, 404, {});
    if (path.startsWith('/none/')) return json(res, 200, { streams: [] });
    const filename = releaseFor(id);
    json(res, 200, {
      streams: [
        {
          name: 'Torrentio\n1080p',
          title: `${filename}\n👤 50 💾 1.2 GB ⚙️ Fixture`,
          infoHash: hash(id),
          fileIdx: 0,
          behaviorHints: { filename, bingeGroup: 'fixture-1080p' },
        },
      ],
    });
  });
}

/**
 * TorBox's API, as far as Scout uses it: every hash is cached, `createtorrent` adds it to the account, `requestdl`
 * hands out the download host's link, and `createstream` makes a managed HLS stream on the CDN fake while
 * `state.managed` is true (otherwise TorBox has no stream for it, and Hearth falls back to Remux).
 */
function torbox(state, log, mediaBase) {
  const held = new Map();
  let next = 100;
  return createHttp((req, res) => {
    const url = new URL(req.url, 'http://torbox');
    const path = url.pathname.replace(/^\/v1\/api/, '');
    log.push(`torbox ${req.method} ${path}`);
    req.resume();
    req.on('end', () => {
      const ok = (data) => json(res, 200, { success: true, error: null, detail: 'ok', data });
      if (path === '/user/me') return ok({ id: 1, plan: 2, email: 'fixture@example.invalid' });
      if (path === '/torrents/checkcached') {
        const hashes = (url.searchParams.get('hash') ?? '').split(',').filter(Boolean);
        return ok(
          Object.fromEntries(hashes.map((h) => [h, { name: 'Fixture', size: 816178, hash: h }])),
        );
      }
      if (path === '/queued/getqueued') return ok([]);
      if (path === '/torrents/createtorrent') {
        // multipart or urlencoded: the magnet's hash is all this needs, and every add is the one release.
        const id = next++;
        held.set(id, true);
        return ok({ torrent_id: id, hash: 'fixture', auth_id: 'fixture' });
      }
      if (path === '/torrents/mylist') {
        const id = url.searchParams.get('id');
        const item = (n) => ({
          id: n,
          hash: 'fixture',
          name: 'Fixture',
          progress: 1,
          download_finished: true,
          download_state: 'cached',
          files: [
            {
              id: 0,
              name: 'Fixture.1080p.WEB-DL.H264.mkv',
              short_name: 'Fixture.mkv',
              size: 816178,
            },
          ],
        });
        if (id)
          return held.has(Number(id))
            ? ok(item(Number(id)))
            : json(res, 404, { success: false, error: 'ITEM_NOT_FOUND' });
        return ok([...held.keys()].map(item));
      }
      if (path === '/torrents/requestdl') return ok(`${mediaBase}/release.mkv`);
      if (path === '/torrents/controltorrent') return ok(null);
      if (path === '/stream/createstream') {
        if (!state.managed)
          return json(res, 503, {
            success: false,
            error: 'STREAM_UNAVAILABLE',
            detail: 'fixture',
            data: null,
          });
        const audio = Number(url.searchParams.get('chosen_audio_index') ?? 0);
        const subtitle = url.searchParams.get('chosen_subtitle_index');
        return ok({
          audio_index: audio,
          subtitle_index: subtitle ?? 'null',
          scrobbling_enabled: false,
          hls_url: `https://${CDN_HOST}/stream/${next++}/index.m3u8?token=fixture&scrobbling_enabled=false`,
          metadata: {
            audios: [
              {
                codec: 'aac',
                index: 1,
                language: 'eng',
                language_full: 'English',
                title: 'Stereo',
              },
            ],
            subtitles: [
              {
                codec: 'subrip',
                index: 2,
                language: 'eng',
                language_full: 'English',
                title: 'English',
              },
              {
                codec: 'subrip',
                index: 3,
                language: 'fin',
                language_full: 'Finnish',
                title: 'Suomi',
              },
            ],
            video: { codec: 'h264', index: 0 },
          },
        });
      }
      json(res, 404, { success: false, error: 'NOT_FOUND', detail: path });
    });
  });
}

/** OpenSubtitles: it has nothing for any fixture title. */
function opensubtitles(log) {
  return createHttp((req, res) => {
    log.push(`opensubtitles ${req.method} ${new URL(req.url, 'http://os').pathname}`);
    req.resume();
    json(res, 200, { total_count: 0, total_pages: 0, page: 1, data: [] });
  });
}

/** The debrid's download host: the release file, with ranges, as Scout's probe and Remux's ffmpeg read it. */
function downloads(file, log) {
  const size = statSync(file).size;
  return createHttp((req, res) => {
    log.push(`download ${req.method} ${req.headers.range ?? 'whole'}`);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes' };
    if (!range) {
      res.writeHead(200, { ...headers, 'content-length': size });
      return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res);
    }
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  });
}

/** TorBox's CDN: the managed stream's playlist and fMP4 segments. Anything but a GET is refused, and every request kept. */
function cdn(tls, requests) {
  return createHttps(tls, (req, res) => {
    const path = new URL(req.url, `https://${CDN_HOST}`).pathname;
    requests.push({ method: req.method, path, origin: req.headers.origin ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    req.resume();
    if (req.method === 'OPTIONS')
      return res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET' }).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, cors).end();
    const file = path.endsWith('/index.m3u8') ? 'media.m3u8' : path.split('/').pop();
    readFile(join(HLS, file)).then(
      (body) =>
        res
          .writeHead(200, {
            ...cors,
            'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
          })
          .end(req.method === 'HEAD' ? undefined : body),
      () => res.writeHead(404, cors).end(),
    );
  });
}

/**
 * A front for `port` on 127.0.0.1 — TLS, as the box's public listener and its name's proxy are, or plain with no `tls`:
 * it forwards every request as it came, Host included, and passes the answer back unchanged (CORS headers and all, as
 * production's proxies do). Each exchange is kept on `records` as `{ label, method, path, status, origin, credentials }`.
 */
function front(tls, port, records, label) {
  const handle = (req, res) => {
    const record = {
      label,
      method: req.method,
      path: req.url.split('?')[0],
      status: null,
      origin: req.headers.origin ?? null,
      credentials: Boolean(req.headers.cookie),
    };
    records.push(record);
    const upstream = httpRequest(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        record.status = answer.statusCode;
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      record.status = 502;
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  };
  return tls ? createHttps(tls, handle) : createHttp(handle);
}

/** den-edge's root-owned helper: it opens the public listener for whatever it is asked, and keeps each ask. */
function listenerHelper(socket, asks) {
  const server = createNet((stream) => {
    let body = '';
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      try {
        asks.push(JSON.parse(body.trim()));
      } catch {
        asks.push({ unreadable: body });
      }
      stream.end('ok\n');
    });
  });
  return new Promise((done) => server.listen(socket, () => done(server)));
}

/** The app's own wire and pairing code, as the rehearsal scripts load it: how a TV makes and hands over a household. */
async function loadApp() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: WEB,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  const core = await server.ssrLoadModule('/src/vendor/den-core/index.js');
  await core.initialize(readFileSync(join(WEB, 'src/vendor/den-core/generated/den_core_bg.wasm')));
  return {
    wire: await server.ssrLoadModule('/src/lib/wire.ts'),
    pairing: await server.ssrLoadModule('/src/lib/pair.ts'),
    close: () => server.close(),
  };
}

/**
 * Start everything. Returns the stack: `edge` and `hearth` (their log lines), the fakes' records (`log`, `cdn`,
 * `listener`), `torbox` (set `.managed`), `household` (its key) and `pair(page)`, which links a browser page to the
 * household with a code its TV shows.
 */
export async function startStack() {
  const edgeBin = required('DEN_EDGE_BIN');
  const hearthBin = required('DEN_HEARTH_BIN');
  const dist = required('DEN_EDGE_DIST');
  const media = required('DEN_STACK_MEDIA');
  const work = mkdtempSync(join(tmpdir(), 'den-stack-'));
  // The cast page names its parent at build time, as the image's names the public name.
  const castDist = join(work, 'cast');
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', castDist], {
    cwd: WEB,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: EDGE },
    stdio: 'ignore',
  });
  const tls = certificate(work);
  const log = [];
  const cdnRequests = [];
  const listenerAsks = [];
  const torboxState = { managed: true };
  const servers = [];
  const serve = async (server) => {
    servers.push(server);
    return listen(server);
  };

  const indexerPort = await serve(indexer(log));
  const downloadPort = await serve(downloads(media, log));
  const torboxPort = await serve(torbox(torboxState, log, `http://127.0.0.1:${downloadPort}`));
  const cdnPort = await serve(cdn(tls, cdnRequests));
  const opensubtitlesPort = await serve(opensubtitles(log));
  const hearthPort = await freePort();
  // Everything crossing these fronts is kept: the public media listener (a different origin from the page, as on the
  // box), the cast page's name, and Hearth's callbacks to den-edge (receipts).
  const exchanges = [];
  const publicPort = await serve(front(tls, hearthPort, exchanges, 'public'));
  const castPort = await serve(front(tls, EDGE_PORT, exchanges, 'cast'));
  const reportPort = await serve(front(null, EDGE_PORT, exchanges, 'report'));
  const socket = join(work, 'listener.sock');
  servers.push(await listenerHelper(socket, listenerAsks));
  const publicBase = `https://127.0.0.1:${publicPort}`;
  const castOrigin = `https://localhost:${castPort}`;

  const hearth = child('den-hearth', hearthBin, {
    PORT: String(hearthPort),
    HEARTH_SCOUT_PORT: '0',
    HEARTH_REEL_PORT: '0',
    HEARTH_SUBS_PORT: '0',
    HEARTH_REMUX_PORT: '0',
    HEARTH_MANAGED_PLAYBACK: '1',
    HEARTH_PUBLIC_BASE_URL: EDGE,
    HEARTH_STUB_TORBOX: `http://127.0.0.1:${torboxPort}`,
    HEARTH_STUB_TORBOX_CDN: `${CDN_HOST}=127.0.0.1:${cdnPort}`,
    HEARTH_STUB_OPENSUBTITLES: `http://127.0.0.1:${opensubtitlesPort}`,
    TORRENTIO_URL: `http://127.0.0.1:${indexerPort}`,
    MEDIAFUSION_URL: `http://127.0.0.1:${indexerPort}/none`,
    CINEMETA_URL: `http://127.0.0.1:${indexerPort}/none`,
    SCOUT_CACHE_DIR: join(work, 'scout'),
    REEL_CACHE_DIR: join(work, 'reel'),
    SUBS_CACHE_DIR: join(work, 'subs'),
    REMUX_SCRATCH_DIR: join(work, 'remux'),
    REMUX_FFMPEG_PATH: process.env.DEN_REMUX_FFMPEG ?? 'ffmpeg',
    // Every flow of the file plays in the one household, one after another, and a session a flow leaves behind
    // (https://github.com/oxyc/den-edge/issues/1124) idles out only after ten minutes: with the box's own caps (4, 2
    // an install) a later flow's session was evicted mid-start. Room for them all keeps each flow its own.
    REMUX_MAX_SESSIONS: '64',
    REMUX_MAX_SESSIONS_PER_INSTALL: '64',
    REMUX_EDGE_SECRET: SECRET,
    REMUX_PUBLIC_SESSION_PROXY: '127.0.0.1',
    REMUX_EDGE_REPORT_URL: `http://127.0.0.1:${reportPort}`,
    REMUX_WEB_ORIGINS: `${EDGE},${castOrigin}`,
    // As the box's render-env.sh writes them: the web page's origin is a Scout and Subtitles origin Remux may use, and
    // stands for Hearth itself.
    REMUX_SCOUT_ORIGINS: `${EDGE},http://127.0.0.1:${hearthPort}`,
    REMUX_SUBTITLE_ORIGINS: `${EDGE},http://127.0.0.1:${hearthPort}`,
    REMUX_ORIGIN_ALIASES: `${EDGE}=http://127.0.0.1:${hearthPort}`,
    LOG_REQUESTS: '1',
  });
  // Both print this once every listener is bound.
  await hearth.waitFor(/listening on :/);

  const edgeEnv = (newLibraries) => ({
    PORT: String(EDGE_PORT),
    DATA_DIR: join(work, 'edge-data'),
    LOG_REQUESTS: '1',
    WEB_DIR: dist,
    CAST_DIR: castDist,
    WEB_HOSTS: '127.0.0.1',
    CAST_ORIGIN: castOrigin,
    ADDON_RELAY: `/den=http://127.0.0.1:${hearthPort},/remux=http://127.0.0.1:${hearthPort}`,
    REMUX_EDGE_SECRET: SECRET,
    DEN_PLAYBACK_ENABLED: '1',
    PUBLIC_MEDIA_BASE: publicBase,
    PUBLIC_MEDIA_SOCKET: socket,
    NEW_LIBRARIES: newLibraries,
    // The browsers say which device they are (`x-forwarded-for`, set in the spec for den-edge's own origin), as a
    // household's devices come from addresses of their own behind the box's proxy.
    TRUSTED_PROXIES: '127.0.0.1',
  });

  // The household is a TV's: made while den-edge takes new libraries, then served as the box serves it, where only a
  // household's member may start one (`NEW_LIBRARIES=members`) and only a member may play.
  const app = await loadApp();
  let edge = child('den-edge', edgeBin, edgeEnv('open'));
  await edge.waitFor(/listening on :/);
  const household = randomBytes(32).toString('base64');
  const keys = await app.wire.deriveKeys(Buffer.from(household, 'base64'));
  const at = [Date.now() - 60_000, 0, 'aaaaaaaaaaaaaaaa'];
  const rows = [
    { kind: 'set', schema: 2, name: 'prefs', values: {} },
    {
      kind: 'set',
      schema: 2,
      name: 'plugins',
      values: { [INSTALL]: { value: { bool: true }, at } },
    },
  ];
  const writes = [];
  for (const row of rows) writes.push({ ...(await app.wire.seal(keys, row)), base: 0 });
  const seeded = await fetch(`${EDGE}/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': keys.token,
      'x-den-wire': '4',
      'x-den-wire-min': '4',
      'x-den-generation': '0',
    },
    body: JSON.stringify({ writes }),
  });
  if (!seeded.ok)
    throw new Error(`the household was not made: ${seeded.status} ${await seeded.text()}`);
  await edge.stop();
  edge = child('den-edge', edgeBin, edgeEnv('members'));
  await edge.waitFor(/listening on :/);

  /** Host a pairing code as the household's TV, and link `page` to it from a first visit's "Link your Apple TV". */
  async function pair(page) {
    const { wire, pairing } = app;
    let shown;
    const code = new Promise((done) => (shown = done));
    const stop = new AbortController();
    const done = pairing.host({
      label: 'Living room TV',
      onCode: shown,
      allow: async () => true,
      seal: async (handoverKey, host, linkKey) => {
        const link = wire.fromBase64url(linkKey);
        const sealed = await pairing.sealHandover(wire.fromBase64url(handoverKey), {
          host,
          linkKey: link,
          libraryKey: new Uint8Array(Buffer.from(household, 'base64')),
        });
        return {
          sealed: wire.toBase64url(sealed),
          linkKey,
          inboxKey: (await pairing.linkKeys(link)).inbox,
        };
      },
      fetchImpl: (path, init) => fetch(`${EDGE}${path}`, init),
      signal: stop.signal,
    });
    try {
      await page.goto(`${EDGE}/`);
      await page.getByLabel('Link code, twelve characters').fill(await code);
      await page.getByRole('button', { name: 'Link', exact: true }).click();
      await done;
      await page.waitForFunction(
        (key) =>
          JSON.parse(localStorage.getItem('den.links') ?? '[]').some((l) => l.libraryKey === key),
        household,
        { timeout: 60_000 },
      );
    } finally {
      stop.abort();
    }
  }

  return {
    edge: { lines: () => edge.lines, waitFor: (re, from) => edge.waitFor(re, from) },
    hearth,
    log,
    exchanges,
    cdn: cdnRequests,
    listener: listenerAsks,
    torbox: torboxState,
    household,
    publicBase,
    castOrigin,
    cdnPort,
    pair,
    async stop() {
      await edge.stop();
      await hearth.stop();
      await app.close();
      for (const server of servers) server.close();
      if (process.env.DEN_STACK_KEEP !== '1') rmSync(work, { recursive: true, force: true });
    },
  };
}
