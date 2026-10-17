// `npm run rehearse`: the Owner split (profiles-v1 §8) end to end against a copy of a real household, or a synthetic
// one. The real den-edge binary runs on a copy of the data with profile migration on, serves the built web app, and
// real Den Web, in real Chromium, enables Profiles. Then the case that broke production: a browser that cached the
// household BEFORE the split reopens it AFTER the split (one tab, then two) and must adopt the committed household
// without writing its old rows back. The household is then decrypted and checked row by row.
//
//   npm run rehearse                              synthetic household, generated key
//   REHEARSE_DATA=<dir> REHEARSE_KEY_FILE=<file> npm run rehearse
//
// Needs `cargo build --locked` (or DEN_EDGE_BIN) and `npm run build` first. Real data and keys are only ever read
// from the paths given; nothing from them is written into the repo.

/* global window, document, MutationObserver, requestAnimationFrame -- the browser-side init script and evaluate callbacks below */

import { spawn } from 'node:child_process';
import { hkdfSync, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as listen } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { syntheticRows } from './rehearse-synthetic.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, env, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return (at >= 0 ? argv[at + 1] : process.env[env]) ?? fallback;
};

const DATA = option('data', 'REHEARSE_DATA');
const KEY_FILE = option('key-file', 'REHEARSE_KEY_FILE');
const PIN = option('pin', 'REHEARSE_PIN', '1234');
const SETTLE_MS = Number(option('settle', 'REHEARSE_SETTLE_SECONDS', '25')) * 1000;
const MAX_BATCHES = Number(option('max-batches', 'REHEARSE_MAX_BATCHES', '6'));
// Workers a returning Owner's page starts: the household bootstrap, the Owner library, and the directory read. A
// second session on the Owner library (the shape before the coordinator adopted the first one) started six.
const MAX_SESSION_WORKERS = 3;
const BINARY = option('bin', 'DEN_EDGE_BIN', join(ROOT, 'target/debug/den-edge'));
const KEEP = flag('keep') || process.env.REHEARSE_KEEP === '1';
const HEADED = flag('headed');
// The synthetic household at the size a long-lived one reaches (about 6,100 rows) unless asked for the small one.
const LARGE = !(flag('small') || process.env.REHEARSE_SMALL === '1');

if (!!DATA !== !!KEY_FILE)
  fail('give both REHEARSE_DATA and REHEARSE_KEY_FILE, or neither for a synthetic household');
if (!existsSync(BINARY))
  fail(`no den-edge binary at ${BINARY}: run cargo build --locked (or set DEN_EDGE_BIN)`);
if (!existsSync(join(WEB, 'dist/index.html'))) fail('no built web app: run npm run build in web/');

function fail(message) {
  console.error(`rehearse: ${message}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const work = mkdtempSync(join(tmpdir(), 'den-rehearse-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const step = (message) => console.log(`\n== ${message}`);

// --- wire.ts, loaded through Vite so the rehearsal seals and opens rows with the app's own code ---
async function loadWire() {
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
  return { wire: await server.ssrLoadModule('/src/lib/wire.ts'), close: () => server.close() };
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const keyBytes = (text) => {
  const bytes = Buffer.from(text.trim().replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (bytes.length !== 32) fail('the library key is not 32 bytes of base64');
  return bytes;
};
const libraryId = (key) =>
  Buffer.from(hkdfSync('sha256', key, 'den/library/salt/v1', 'den/library/id/v1', 16)).toString(
    'hex',
  );

// --- den-edge ---
const freePort = () =>
  new Promise((done) => {
    const probe = listen().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

async function startEdge(dataDir, port, env) {
  const log = [];
  const child = spawn(BINARY, [], {
    env: { PORT: String(port), DATA_DIR: dataDir, LOG_REQUESTS: '1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let buffered = '';
  child.stderr.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    log.push(...lines);
  });
  const exited = new Promise((done) => child.once('exit', (code) => done(code)));
  for (let i = 0; i < 100 && !log.some((l) => l.includes('listening on')); i += 1) {
    if (child.exitCode !== null) fail(`den-edge exited ${child.exitCode}:\n${log.join('\n')}`);
    await sleep(100);
  }
  if (!log.some((l) => l.includes('listening on'))) fail('den-edge did not start');
  // The log line can precede the first accepted connection; wait until a request is actually answered.
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    ready = await fetch(`${origin}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!ready) await sleep(100);
  }
  if (!ready) fail('den-edge did not answer /health');
  return {
    origin,
    log,
    stop: async () => {
      child.kill();
      await exited;
    },
  };
}

const requestCount = (edge, pattern, from = 0) =>
  edge.log.slice(from).filter((l) => pattern.test(l)).length;
const BATCH = /^POST \/lib\/:id\/batch /;

// --- a household's rows, read over HTTP and opened ---
async function readLibrary(edge, wire, keyText) {
  const keys = await wire.deriveKeys(keyBytes(keyText));
  const rows = [];
  let since = 0;
  let wireMin = null;
  let generation = '0';
  for (;;) {
    const response = await fetch(`${edge.origin}/lib/${keys.id}/changes?since=${since}`, {
      headers: { 'x-den-library-token': keys.token, 'x-den-wire': '5' },
    });
    const status = response.status;
    if (!response.ok) return { status, rows, wireMin, keys, generation };
    wireMin = Number(response.headers.get('x-den-wire-min'));
    generation = response.headers.get('x-den-generation') ?? generation;
    const body = await response.json();
    for (const entry of body.entries) {
      since = Math.max(since, entry.seq);
      if (entry.v === null) continue;
      rows.push(await wire.openEntry(keys, entry.k, entry.v));
      rows.at(-1).migration = await wire.openMigrationRow(keys, entry.k, entry.v);
      rows.at(-1).k = entry.k;
      rows.at(-1).seq = entry.seq;
    }
    if (!body.more) return { status, rows, wireMin, keys, generation };
  }
}

/** What the library holds that a profile-aware household must not (profiles-v1 §2), by name. */
function activityNames(wire, opened) {
  const names = [];
  for (const entry of opened) {
    const row = entry.row;
    if (!row) continue;
    const name = wire.rowName(row);
    const activity =
      ['title', 'season', 'delivery', 'rec', 'ep', 'wat', 'snt'].includes(row.kind) ||
      (row.kind === 'set' &&
        /^(trackers|deliver:|handoff:|assistant-applied|tracker-event:)/.test(row.name));
    if (activity) names.push(name);
  }
  return names;
}

async function seedSynthetic(wire, dataDir, keyText) {
  const port = await freePort();
  // Starting a household needs `open`; the rehearsal itself runs `members`, as production does.
  const edge = await startEdge(dataDir, port, { NEW_LIBRARIES: 'open' });
  try {
    const keys = await wire.deriveKeys(keyBytes(keyText));
    const writes = [];
    for (const row of syntheticRows(Date.now(), {
      legacy: process.env.REHEARSE_LEGACY_ROWS === '1',
      large: LARGE,
    })) {
      const { k, v } = await wire.seal(keys, row);
      writes.push({ k, base: 0, v });
    }
    let seeded = 0;
    let generation = '0';
    // den-edge takes at most 200 writes a batch, and each batch names the generation the last one answered with.
    for (let from = 0; from < writes.length; from += 200) {
      const response = await fetch(`${edge.origin}/lib/${keys.id}/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-den-library-token': keys.token,
          'x-den-wire': '4',
          'x-den-wire-min': '4',
          'x-den-generation': generation,
        },
        body: JSON.stringify({ writes: writes.slice(from, from + 200) }),
      });
      if (!response.ok)
        fail(`seeding the synthetic household failed: ${response.status} ${await response.text()}`);
      const { applied, conflicts } = await response.json();
      if (conflicts?.length) fail(`seeding conflicted on ${conflicts.length} rows`);
      seeded += applied.length;
      generation = response.headers.get('x-den-generation') ?? generation;
    }
    console.log(`seeded ${seeded} synthetic rows`);
  } finally {
    await edge.stop();
  }
}

// --- the browser ---
function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(system) ? system : undefined;
}

// What the pages and their workers said at warning level or worse, so a failure is explained.
const browserLog = [];
// Where the browser log stood once the split had committed and its page had closed.
let splitLogMark = 0;
// The `den: startup` milestones of every page and Worker, printed with the verdict so a run shows where it waited.
const startupLog = [];
let launches = 0;

async function launch(profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: !HEADED,
    executablePath: executablePath(),
    viewport: { width: 1280, height: 900 },
  });
  const launched = ++launches;
  const startup = (m) => {
    if (m.text().startsWith('den: startup')) startupLog.push(`[launch ${launched}] ${m.text()}`);
  };
  const watch = (page) => {
    page.on('console', (m) => {
      startup(m);
      if (['error', 'warning'].includes(m.type())) browserLog.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => browserLog.push(`[pageerror] ${e.message}`));
  };
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  return ctx;
}

/**
 * Init script (runs in the page, from navigation start): records every Owner PIN gate element that is ever
 * attached, so a flash too short to poll for still shows up in `window.__ownerGateSeen`.
 */
function watchOwnerGate() {
  window.__ownerGateSeen = [];
  window.__loadingSeen = [];
  window.__triggerSeen = [];
  const find = (node, selector) => (node.matches(selector) ? node : node.querySelector(selector));
  const note = (node) => {
    if (node.nodeType !== 1) return;
    const gate = find(node, '.owner-gate');
    if (gate)
      window.__ownerGateSeen.push(gate.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    const loading = find(node, '.profile-loading');
    if (loading) window.__loadingSeen.push(loading.textContent.trim());
    const trigger = find(node, 'button.profile-trigger');
    if (trigger && !window.__triggerSeen.length)
      window.__triggerSeen.push({
        label: trigger.getAttribute('aria-label'),
        // Whether the library had already drawn its own content when the switcher first appeared.
        ms: Math.round(performance.now()),
      });
  };
  new MutationObserver((records) =>
    records.forEach((r) => r.addedNodes.forEach((n) => note(n))),
  ).observe(document, { childList: true, subtree: true });
  // What each painted frame carried, from navigation start. `main` is the library; the bar's own links are not.
  window.__frames = [];
  const frame = () => {
    const text = document.querySelector('main')?.innerText ?? '';
    window.__frames.push({
      ms: Math.round(performance.now()),
      continueWatching: text.includes('Continue Watching'),
      watchlist: text.includes('Watchlist'),
      shelves: /Trending|Loading your shelves/.test(text),
    });
    if (window.__frames.length < 900) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Names for the synthetic titles. The rehearsal has no TMDB key, so without this a Continue Watching card has no name
 * and its shelf is never drawn; what is under test is when the shelf appears, not where its names come from.
 */
async function nameSyntheticTitles(ctx) {
  await ctx.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'max-age=3600' },
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>',
    }),
  );
  await ctx.route('**/tmdb/3/**', (route) => {
    const url = new URL(route.request().url());
    const [, , , kind, id] = url.pathname.split('/');
    const headers = { 'cache-control': 'max-age=3600' };
    if (kind === 'movie')
      return route.fulfill({
        headers,
        json: {
          id: Number(id),
          title: `Film ${id}`,
          release_date: '2001-01-01',
          poster_path: null,
          // A billboard keeps a lead only for a title with a backdrop.
          backdrop_path: `/backdrop-${id}.jpg`,
        },
      });
    if (kind === 'tv')
      return route.fulfill({
        headers,
        json: {
          id: Number(id),
          name: `Series ${id}`,
          first_air_date: '2001-01-01',
          poster_path: null,
          number_of_seasons: 2,
          seasons: [1, 2].map((n) => ({ season_number: n, episode_count: 8 })),
        },
      });
    return route.fulfill({ status: 404, json: { status_code: 34 } });
  });
}

// The billboards atlas answers with. The shared pool is one title for everyone; every ranking asked for a library is a
// new one (atlas ranks again as the day, the catalogue and the library move), so each session that ranks and keeps a
// billboard keeps a different lead from the others.
const SHARED_LEAD_ID = 9201;

/**
 * atlas on the page's own origin, answering what a billboard asks: its manifest, the shared pool and a ranking. Each
 * ranking asked for is noted in `ranked` with how many library titles it carried.
 */
async function stubAtlas(ctx, firstLead, ranked = []) {
  let lead = firstLead;
  const slides = (first) => ({
    slides: [first, first + 1, first + 2].map((id) => ({ type: 'movie', id })),
  });
  await ctx.route('**/atlas/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', version: '0.0.0' } });
    if (pathname.startsWith('/atlas/recommend/') && request.method() === 'GET')
      return route.fulfill({ json: slides(SHARED_LEAD_ID) });
    if (pathname === '/atlas/recommend' && request.method() === 'POST') {
      const body = request.postDataJSON();
      ranked.push({ library: body?.library?.length ?? 0, owned: body?.owned?.length ?? 0 });
      return route.fulfill({ json: slides((lead += 10)) });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

/**
 * Init script (runs in the page, from navigation start): the title on the billboard on every painted frame, kept when
 * it changes. That is the front slide of the library's billboard, or the early copy the page draws before it; a blank
 * frame is a title of null.
 */
function recordBillboard() {
  window.__billboards = [];
  const frame = () => {
    const front = document.querySelector(
      'main .billboard article.slide[aria-hidden="false"] .title-link',
    );
    const early = document.querySelector(
      '[data-den-early-billboard]:not([hidden]) [data-den-early-title]',
    );
    const title = front?.textContent || early?.textContent || null;
    const source = front?.textContent ? 'library' : early?.textContent ? 'shell' : null;
    const last = window.__billboards.at(-1);
    if (!last || last.title !== title || last.source !== source)
      window.__billboards.push({ ms: Math.round(performance.now()), title, source });
    if (performance.now() < 30_000) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// A page that answers: every round trip into its main thread within a second, from navigation start through the
// first seconds the library is drawn and synced. The frozen tab did not answer one in 45 seconds.
const RESPONSIVE_WINDOW_MS = 20_000;
const MAX_ROUND_TRIP_MS = 1_000;

/**
 * Round trips into the page every 200 ms for `windowMs`, each also noting whether Continue Watching is drawn yet.
 * One not answered within ten seconds is a frozen renderer: probing stops there, as every later call would queue
 * behind it.
 */
async function responsiveness(page, windowMs) {
  const trips = [];
  let unanswered = false;
  let continueWatchingAt = null;
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const started = Date.now();
    const answered = await Promise.race([
      page
        .evaluate(() =>
          (document.querySelector('main')?.innerText ?? '').includes('Continue Watching'),
        )
        .then(
          (drawn) => {
            if (drawn && continueWatchingAt === null) continueWatchingAt = Date.now() - start;
            return true;
          },
          // A navigation in progress destroys the context; that is not the page failing to answer.
          () => true,
        ),
      sleep(10_000).then(() => false),
    ]);
    if (!answered) {
      unanswered = true;
      break;
    }
    trips.push(Date.now() - started);
    await sleep(200);
  }
  return { slowest: Math.max(0, ...trips), trips: trips.length, unanswered, continueWatchingAt };
}

/**
 * Names for the synthetic titles. The rehearsal has no TMDB key, so without this a Continue Watching card has no name
 * and its shelf is never drawn.
 */
async function nameSyntheticTitles(ctx) {
  await ctx.route('**/tmdb/3/**', (route) => {
    const url = new URL(route.request().url());
    const [, , , kind, id] = url.pathname.split('/');
    const headers = { 'cache-control': 'max-age=3600' };
    if (kind === 'movie')
      return route.fulfill({
        headers,
        json: {
          id: Number(id),
          title: `Film ${id}`,
          release_date: '2001-01-01',
          poster_path: null,
        },
      });
    if (kind === 'tv')
      return route.fulfill({
        headers,
        json: {
          id: Number(id),
          name: `Series ${id}`,
          first_air_date: '2001-01-01',
          poster_path: null,
          number_of_seasons: 2,
          seasons: [1, 2].map((n) => ({ season_number: n, episode_count: 8 })),
        },
      });
    return route.fulfill({ status: 404, json: { status_code: 34 } });
  });
}

// A page that answers: every round trip into its main thread within a second, from navigation start through the
// first seconds the library is drawn and synced. The frozen tab did not answer one in 45 seconds.
const RESPONSIVE_WINDOW_MS = 20_000;
const MAX_ROUND_TRIP_MS = 1_000;

/**
 * Round trips into the page every 200 ms for `windowMs`, each also noting whether Continue Watching is drawn yet.
 * One not answered within ten seconds is a frozen renderer: probing stops there, as every later call would queue
 * behind it.
 */
async function responsiveness(page, windowMs) {
  const trips = [];
  let unanswered = false;
  let continueWatchingAt = null;
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const started = Date.now();
    const answered = await Promise.race([
      page
        .evaluate(() =>
          (document.querySelector('main')?.innerText ?? '').includes('Continue Watching'),
        )
        .then(
          (drawn) => {
            if (drawn && continueWatchingAt === null) continueWatchingAt = Date.now() - start;
            return true;
          },
          // A navigation in progress destroys the context; that is not the page failing to answer.
          () => true,
        ),
      sleep(10_000).then(() => false),
    ]);
    if (!answered) {
      unanswered = true;
      break;
    }
    trips.push(Date.now() - started);
    await sleep(200);
  }
  return { slowest: Math.max(0, ...trips), trips: trips.length, unanswered, continueWatchingAt };
}

/** Wait for no request to den-edge's library routes for `quietMs`, or give up after `limitMs`. */
async function quiet(edge, quietMs, limitMs = 60_000) {
  const started = Date.now();
  let last = edge.log.length;
  let since = Date.now();
  while (Date.now() - started < limitMs) {
    await sleep(250);
    if (edge.log.length !== last) {
      last = edge.log.length;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return true;
  }
  return false;
}

async function openSettings(page, edge) {
  await page.goto(`${edge.origin}/settings`);
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 60_000 });
}

/** The `prefs` document's values in a library, by key, as `{ value, at }` entries. */
const prefValues = (library) =>
  library.rows.find((r) => r.row?.kind === 'set' && r.row.name === 'prefs')?.row.values ?? {};

/**
 * The Owner after the split: Settings shows the preferences the Owner library holds (the profile partition's keys) next
 * to the household's own, and a change lands in the library its key belongs to, never in the other one.
 */
async function checkOwnerPreferences(page, edge, wire, keyText, ownerKey) {
  // A control that is not there reads as '?', so a failure names what is missing.
  const read = (read) => read().catch(() => '?');
  const shown = async () => ({
    subtitle: await read(() =>
      page.locator('#subtitle-language select').inputValue({ timeout: 500 }),
    ),
    autoSkip: await read(() => page.locator('#auto-skip input').isChecked({ timeout: 500 })),
    hiddenLanguages: await read(async () =>
      (await page.locator('#hidden-languages .value').innerText({ timeout: 500 })).trim(),
    ),
    minYear: await read(() => page.locator('#minimum-year select').inputValue({ timeout: 500 })),
    audio: await read(() => page.locator('#audio-language select').inputValue({ timeout: 500 })),
    region: await read(() => page.locator('#region select').inputValue({ timeout: 500 })),
  });
  const wanted = {
    subtitle: 'fi',
    autoSkip: true,
    hiddenLanguages: '2',
    minYear: '1990',
    audio: 'sv',
    region: 'FI',
  };
  let seen = null;
  for (let i = 0; i < 40; i += 1) {
    seen = await shown().catch(() => null);
    if (seen && JSON.stringify(seen) === JSON.stringify(wanted)) break;
    await sleep(500);
  }
  check(
    'Owner Settings shows the seeded preferences, not defaults',
    JSON.stringify(seen) === JSON.stringify(wanted),
    JSON.stringify(seen),
  );

  // One key of each half: the subtitle language is the Owner's, the watch region the household's.
  await page.locator('#subtitle-language select').selectOption('de');
  let owner;
  let household;
  for (let i = 0; i < 30; i += 1) {
    owner = prefValues(await readLibrary(edge, wire, ownerKey));
    household = prefValues(await readLibrary(edge, wire, keyText));
    if (owner['den.preferredSubtitleLanguage']?.value?.string === 'de') break;
    await sleep(500);
  }
  const subtitleOf = (values) => values['den.preferredSubtitleLanguage']?.value?.string;
  check(
    'a changed profile preference persists in the Owner library',
    subtitleOf(owner) === 'de',
    `Owner library holds ${JSON.stringify(subtitleOf(owner))}`,
  );
  check(
    'a changed profile preference is not written to the household',
    subtitleOf(household) === undefined,
    `household holds ${JSON.stringify(subtitleOf(household))}`,
  );
  // The watch region is a profile preference like the rest: "Automatic" clears it in the Owner library, and the
  // household never holds one.
  await page.locator('#region select').selectOption('');
  const regionOf = (values) => values['den.watchRegion'];
  for (let i = 0; i < 20 && regionOf(owner)?.value !== null; i += 1) {
    await sleep(500);
    household = prefValues(await readLibrary(edge, wire, keyText));
    owner = prefValues(await readLibrary(edge, wire, ownerKey));
  }
  check(
    'a changed region persists in the Owner library, not the household',
    regionOf(owner)?.value === null && regionOf(household) === undefined,
    `Owner library ${JSON.stringify(regionOf(owner)?.value)}, household ${JSON.stringify(regionOf(household))}`,
  );
  // Put it back, so the scenarios after this one start from the region the household had.
  await page.locator('#region select').selectOption('FI');
  for (let i = 0; i < 20 && regionOf(owner)?.value?.string !== 'FI'; i += 1) {
    await sleep(500);
    owner = prefValues(await readLibrary(edge, wire, ownerKey));
  }
}

/**
 * The streaming-service directory a TMDB stand-in answers, with the region each request named noted in `asked`, under
 * the `phase()` it was made in.
 */
async function stubStreaming(ctx, asked, phase = () => '') {
  const providers = [
    [8, 'Netflix'],
    [119, 'Amazon Prime Video'],
    [337, 'Disney Plus'],
  ].map(([id, name]) => ({
    provider_id: id,
    provider_name: name,
    display_priorities: { FI: id, SE: id, US: id },
  }));
  await ctx.route(/\/tmdb\/3\/watch\/providers\/regions/, (route) =>
    route.fulfill({
      json: {
        results: [
          { iso_3166_1: 'FI', english_name: 'Finland' },
          { iso_3166_1: 'SE', english_name: 'Sweden' },
        ],
      },
    }),
  );
  await ctx.route(/\/tmdb\/3\/watch\/providers\/(movie|tv)/, (route) => {
    asked.push({
      phase: phase(),
      region: new URL(route.request().url()).searchParams.get('watch_region'),
    });
    return route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { results: providers },
    });
  });
}

/**
 * An atlas the page finds on its own origin: every title is rated 12+, and each request that names a policy has its
 * `maximumAge` noted in `asked` under the `phase()` it was made in (null when the request names none).
 */
async function stubPolicyAtlas(ctx, asked, phase = () => '') {
  await ctx.route(/\/atlas\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'atlas', version: '0.0.0' } });
    if (url.searchParams.has('unknownRatings'))
      asked.push({ phase: phase(), maximumAge: url.searchParams.get('maximumAge') });
    if (/\/index\/title\/(movie|series)\/\d+\.json$/.test(url.pathname))
      return route.fulfill({ json: { minimumAge: 12 } });
    return route.fulfill({ status: 404, json: {} });
  });
}

/** Seal one settings row and write it to a library at the generation den-edge holds (a household that already split). */
async function writeSettingsRow(edge, wire, keyText, name, values) {
  const library = await readLibrary(edge, wire, keyText);
  const sealed = await wire.seal(library.keys, { kind: 'set', schema: 2, name, values });
  const existing = library.rows.find((r) => r.k === sealed.k);
  const response = await fetch(`${edge.origin}/lib/${library.keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': library.keys.token,
      'x-den-wire': '5',
      'x-den-wire-min': '5',
      'x-den-generation': library.generation,
    },
    body: JSON.stringify({ writes: [{ k: sealed.k, base: existing?.seq ?? 0, v: sealed.v }] }),
  });
  if (!response.ok)
    fail(`writing ${name} to the household failed: ${response.status} ${await response.text()}`);
}

const servicesOf = (values) => values['den.myServicePicks']?.value?.strings?.slice().sort();
const regionOfValues = (values) => values['den.watchRegion']?.value?.string;

/** Wait for `read()` to answer something truthy, polling the libraries; false if it never does. */
async function eventually(read, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await read()) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Every preference belongs to a profile (profiles-v1 §6): the household holds none after the split; an older household's
 * are given to each profile once, when it opens; Owner and Kid then edit their own, the Kid's Settings behind the Owner
 * PIN; and each profile's Home and requests follow its own region and services.
 */
async function checkProfilePreferences(ctxFor, edge, wire, keyText, people) {
  step('every preference is the profile’s: seeding, independent edits, PIN-gated Kid Settings');
  const read = async (key) => prefValues(await readLibrary(edge, wire, key));
  const STAMP = (n) => [n, 0, 'a1b2c3d4e5f60718'];
  // An older household's preferences, as a household that split before this rule still holds them: a region and a
  // service list the Owner (which has its own) and the Kid (which has none yet) are to be given once, and one key
  // the Owner has not decided.
  const stale = {
    'den.watchRegion': { value: { string: 'SE' }, at: STAMP(1_000) },
    'den.myServicePicks': { value: { strings: ['337@SE'] }, at: STAMP(1_001) },
    'den.autoplayTrailers': { value: { bool: false }, at: STAMP(1_002) },
  };
  await writeSettingsRow(edge, wire, keyText, 'prefs', stale);

  const asked = [];
  let phase = 'owner-open';
  const regionsIn = (name) => [
    ...new Set(asked.filter((entry) => entry.phase === name).map((entry) => entry.region)),
  ];
  const ctx = await ctxFor('profile-scoped-preferences', people.owner.id);
  await nameSyntheticTitles(ctx);
  await stubStreaming(ctx, asked, () => phase);
  const atlasAsked = [];
  await stubPolicyAtlas(ctx, atlasAsked, () => phase);
  const agesIn = (name) => [
    ...new Set(atlasAsked.filter((entry) => entry.phase === name).map((entry) => entry.maximumAge)),
  ];
  const refusal = () => page.getByText('This title isn’t available on this profile.');
  const page = await seedLink(ctx, edge, keyText);
  const loopErrors = [];
  page.on('pageerror', (e) => {
    if (e.message.includes('effect_update_depth')) loopErrors.push(e.message);
  });
  const nav = (name) =>
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name });
  const tiles = async () => {
    const section = page.locator('section[aria-label="Services"]');
    await section.waitFor({ timeout: 30_000 }).catch(() => {});
    // The shelf asks for its directories only once it is near the viewport.
    await eventually(async () => {
      // Scrolled again on every try: the page swaps its first frame for the profile's, which draws the shelf anew.
      await section.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      return /Netflix|Amazon|Disney/.test(await section.innerText().catch(() => ''));
    }, 30);
    // The first frame is the household's, replaced by the profile's own: read the shelf once it has stopped changing.
    const read = async () => (await section.innerText().catch(() => '')).replace(/\s+/g, ' ');
    let text = await read();
    for (let steady = 0; steady < 4;) {
      await sleep(700);
      const next = await read();
      steady = next === text ? steady + 1 : 0;
      text = next;
    }
    return text;
  };
  const openServices = async () => {
    await page.locator('#my-services > button.row').click();
    await page.locator('#my-services-panel').getByLabel('Netflix').waitFor({ timeout: 30_000 });
  };
  const switchTo = async (name, pin) => {
    await page.locator('button.profile-trigger').first().click();
    await page.getByRole('button', { name: `Use ${name}` }).click();
    if (pin)
      await page
        .locator('#owner-pin')
        .fill(pin, { timeout: 10_000 })
        .catch(async (error) => {
          console.log(
            `switcher said: ${(
              await page
                .locator('dialog')
                .innerText()
                .catch(() => '')
            ).replace(/\s+/g, ' ')}`,
          );
          throw error;
        });
    await page
      .locator('dialog[open]')
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {});
  };

  // 1. The Owner opens: it keeps its own region and services and is given only the key it had not decided. The page
  // is tall enough that the Services shelf is near the viewport from the first frame, so a frame drawn from the
  // household's stale preferences would ask for its region (Sweden) at once.
  await page.setViewportSize({ width: 1280, height: 4000 });
  await page.goto(`${edge.origin}/`);
  await page.locator('button.profile-trigger').first().waitFor({ timeout: 60_000 });
  await sleep(4000);
  check(
    'no frame of a pre-repair household is drawn from its preferences',
    regionsIn('owner-open').length > 0 && !regionsIn('owner-open').includes('SE'),
    JSON.stringify(regionsIn('owner-open')),
  );
  const ownerSeeded = await eventually(
    async () => (await read(people.owner.key))['den.autoplayTrailers']?.value?.bool === false,
  );
  let owner = await read(people.owner.key);
  check(
    'the Owner is given the household preference it had not decided, once, with the household’s stamp',
    ownerSeeded &&
      JSON.stringify(owner['den.autoplayTrailers']?.at) === JSON.stringify(STAMP(1_002)),
    JSON.stringify(owner['den.autoplayTrailers']) ??
      browserLog
        .filter((line) => /seed|preferences/i.test(line))
        .slice(-3)
        .join(' | '),
  );
  check(
    'the Owner keeps its own region and services over the household’s',
    regionOfValues(owner) === 'FI' &&
      JSON.stringify(servicesOf(owner)) === JSON.stringify(['8@FI']),
    `${regionOfValues(owner)} ${JSON.stringify(servicesOf(owner))}`,
  );

  // 1b. The Kid opens: given the household's list once (the Kid had none), with the household's stamps.
  phase = 'kid';
  await switchTo(people.kid.name);
  const kidSeeded = await eventually(async () => {
    const seeded = await read(people.kid.key);
    return servicesOf(seeded)?.length === 1;
  });
  let kid = await read(people.kid.key);
  check(
    'the Kid is given the household’s region and services once, with the household’s stamps',
    kidSeeded &&
      regionOfValues(kid) === 'SE' &&
      JSON.stringify(servicesOf(kid)) === JSON.stringify(['337@SE']) &&
      JSON.stringify(kid['den.watchRegion']?.at) === JSON.stringify(STAMP(1_000)) &&
      JSON.stringify(kid['den.myServicePicks']?.at) === JSON.stringify(STAMP(1_001)),
    JSON.stringify({ region: kid['den.watchRegion'], services: kid['den.myServicePicks'] }),
  );
  const kidSeedTiles = await tiles();
  check(
    'the Kid’s Home shows the Kid’s services, not the Owner’s',
    /Disney/.test(kidSeedTiles) && !/Netflix|Amazon/.test(kidSeedTiles),
    kidSeedTiles,
  );

  // A film rated 12+ is within the Kid's 12-and-under limit.
  await page.goto(`${edge.origin}/movie/603`);
  await eventually(async () => agesIn('kid').includes('12'), 30);
  await sleep(1500);
  check(
    'a title at the Kid’s age limit is not refused, and Atlas is asked under that limit',
    !(await refusal()
      .isVisible()
      .catch(() => false)) && agesIn('kid').includes('12'),
    JSON.stringify(agesIn('kid')),
  );

  // 1c. Every profile is seeded, so the household's copy is repaired away (profiles-v1 §8.2): it holds no preference.
  phase = 'repair';
  await switchTo(people.owner.name, PIN);
  await writeSettingsRow(edge, wire, keyText, 'prefs', {});
  const householdBefore = await read(keyText);
  check(
    'the repaired household holds no preferences',
    Object.keys(householdBefore).length === 0,
    JSON.stringify(Object.keys(householdBefore)),
  );

  // 2. The Owner sets its services (A): Amazon joins Netflix in Finland. The regions the pages ask the directory for
  // are noted under the profile that asked (a repeat can come from the browser's own cache, so each window is a stretch
  // of pages, not one load).
  phase = 'owner';
  await page.goto(`${edge.origin}/settings`);
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 60_000 });
  await openServices();
  // The checkbox is drawn by its label, which covers the input.
  await page.locator('#my-services-panel').getByLabel('Amazon Prime Video').check({ force: true });
  const ownerServices = ['119@FI', '8@FI'];
  const ownerSaved = await eventually(
    async () =>
      JSON.stringify(servicesOf(await read(people.owner.key))) === JSON.stringify(ownerServices),
  );
  check('the Owner’s services are saved to the Owner library', ownerSaved);

  // 3. The Owner's Home: its tiles are its own, and everything it asked for named its own region.
  await page.goto(`${edge.origin}/`);
  await page.locator('button.profile-trigger').first().waitFor({ timeout: 60_000 });
  const ownerTiles = await tiles();
  check(
    'the Owner’s Home shows the Owner’s services, not the Kid’s',
    /Netflix/.test(ownerTiles) && /Amazon/.test(ownerTiles) && !/Disney/.test(ownerTiles),
    ownerTiles,
  );
  check(
    'the Owner’s requests carry the Owner’s region, never the Kid’s',
    [...regionsIn('owner-open'), ...regionsIn('owner')].includes('FI') &&
      ![...regionsIn('owner-open'), ...regionsIn('owner')].includes('SE'),
    JSON.stringify([...regionsIn('owner-open'), ...regionsIn('owner')]),
  );

  // 4. The Kid again.
  phase = 'kid';
  await switchTo(people.kid.name);

  // 5. The Kid's Settings ask for the Owner PIN: a wrong one is refused, the right one opens the full Settings.
  await nav('Settings').click();
  const gate = page.locator('#settings-gate-pin');
  await gate.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  const gated = await gate.isVisible().catch(() => false);
  check('opening a Kid’s Settings asks for the Owner PIN', gated);
  if (gated) {
    await gate.fill('0000');
    await page
      .locator('.settings-gate .denied')
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    check(
      'a wrong Owner PIN is refused and opens nothing',
      (await page
        .locator('.settings-gate .denied')
        .isVisible()
        .catch(() => false)) &&
        (await page.locator('#my-services').count()) === 0 &&
        (await page.locator('#profile-policy').count()) === 0,
    );
    await gate.fill(PIN);
  }
  await page
    .locator('#my-services')
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  check(
    'the right Owner PIN opens the Kid’s full Settings, services and region included',
    (await page.locator('#my-services').count()) === 1 &&
      (await page.locator('#region select').count()) === 1,
  );

  // 6. The Kid sets its services (B): Netflix joins Disney in Sweden.
  await openServices();
  await page.locator('#my-services-panel').getByLabel('Netflix').check({ force: true });
  const kidServices = ['337@SE', '8@SE'];
  const kidSaved = await eventually(
    async () =>
      JSON.stringify(servicesOf(await read(people.kid.key))) === JSON.stringify(kidServices),
  );
  check('the Kid’s services are saved to the Kid library', kidSaved);
  // A fresh load of the Kid.
  await page.goto(`${edge.origin}/`);
  await page.locator('button.profile-trigger').first().waitFor({ timeout: 60_000 });
  const kidTiles = await tiles();
  check(
    'the Kid’s Home shows the Kid’s services after its change',
    /Netflix/.test(kidTiles) && /Disney/.test(kidTiles) && !/Amazon/.test(kidTiles),
    kidTiles,
  );
  check(
    'the Kid’s requests carry the Kid’s region, never the Owner’s',
    regionsIn('kid').includes('SE') && !regionsIn('kid').includes('FI'),
    JSON.stringify(regionsIn('kid')),
  );

  // 7. Decrypted from den-edge: each library holds its own, and the household was never written.
  owner = await read(people.owner.key);
  kid = await read(people.kid.key);
  const householdAfter = await read(keyText);
  check(
    'the Owner library holds services A and region FI; the Kid library holds services B and region SE',
    JSON.stringify(servicesOf(owner)) === JSON.stringify(ownerServices) &&
      regionOfValues(owner) === 'FI' &&
      JSON.stringify(servicesOf(kid)) === JSON.stringify(kidServices) &&
      regionOfValues(kid) === 'SE',
    JSON.stringify({ owner: servicesOf(owner), kid: servicesOf(kid) }),
  );
  check(
    'neither profile’s edits touched the household’s preferences',
    JSON.stringify(householdAfter) === JSON.stringify(householdBefore),
  );

  // 7b. The Kid's age limit is the Owner's to change, from the Kid's own Settings once the Owner PIN has opened them.
  phase = 'policy';
  await nav('Settings').click();
  await page.locator('#settings-gate-pin').waitFor({ state: 'visible', timeout: 30_000 });
  check(
    'a locked Kid Settings offers no age limit to change',
    (await page.locator('#profile-policy').count()) === 0,
  );
  await page.locator('#settings-gate-pin').fill(PIN);
  await page.locator('#profile-age-limit').waitFor({ timeout: 30_000 });
  await page.locator('#profile-age-limit select').selectOption('8');
  const kidPolicy = async () => {
    const household = await readLibrary(edge, wire, keyText);
    const directory = household.rows.find((row) => row.profileDirectory)?.profileDirectory;
    return Object.values(directory?.profiles ?? {}).find((entry) => entry.id === people.kid.id)
      ?.policy?.value;
  };
  const policyChanged = await eventually(async () => (await kidPolicy())?.maximumAge === 8);
  check(
    'the Kid’s age limit, changed in its Settings, is written to the household directory',
    policyChanged,
    JSON.stringify(await kidPolicy()),
  );
  await page.goto(`${edge.origin}/movie/603`);
  await eventually(
    async () =>
      await refusal()
        .isVisible()
        .catch(() => false),
    30,
  );
  check(
    'a title over the new limit is refused',
    await refusal()
      .isVisible()
      .catch(() => false),
  );
  check(
    'the Kid’s Atlas requests carry the new age limit',
    agesIn('policy').includes('8') && !agesIn('policy').includes('12'),
    JSON.stringify(agesIn('policy')),
  );

  // 8. Switching profile relocks the Kid's Settings.
  await switchTo(people.owner.name, PIN);
  await switchTo(people.kid.name);
  await nav('Settings').click();
  const relocked = await page
    .locator('#settings-gate-pin')
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  check('switching profile relocks the Kid’s Settings', relocked);

  // 9. Reopening the Kid does not seed over its own choices.
  await page.goto(`${edge.origin}/`);
  await tiles();
  await sleep(3000);
  kid = await read(people.kid.key);
  check(
    'reopening the Kid keeps its own services and region (the seed is not applied again)',
    JSON.stringify(servicesOf(kid)) === JSON.stringify(kidServices) && regionOfValues(kid) === 'SE',
    JSON.stringify(servicesOf(kid)),
  );
  check('the profile preference scenario ran without an effect loop', loopErrors.length === 0);
  await ctx.close().catch(() => {});
}

async function seedLink(ctx, edge, keyText) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${edge.origin}/`);
  const link = {
    inboxKey: randomBytes(16).toString('hex'),
    name: 'rehearsal',
    linkedAt: Date.now(),
    libraryKey: b64(keyBytes(keyText)),
    linkKey: b64(randomBytes(32)),
    recovered: true,
  };
  await page.evaluate((value) => localStorage.setItem('den.links', JSON.stringify([value])), link);
  return page;
}

async function main() {
  const { wire, close } = await loadWire();
  let edge;
  try {
    console.log(`${LARGE ? 'large' : 'small'} household`);
    // 1. data and key
    step('data');
    const dataDir = join(work, 'edge-data');
    let keyText;
    if (DATA) {
      cpSync(resolve(DATA), dataDir, { recursive: true });
      keyText = readFileSync(resolve(KEY_FILE), 'utf8');
      console.log(`copied ${DATA} (real data) to a temporary directory`);
    } else {
      mkdirSync(dataDir);
      keyText = b64(randomBytes(32));
      await seedSynthetic(wire, dataDir, keyText);
    }
    const householdId = libraryId(keyBytes(keyText));

    // 2. the real binary, serving the built app
    step('den-edge');
    const port = await freePort();
    const edgeEnv = {
      WEB_DIR: join(WEB, 'dist'),
      WEB_HOSTS: '127.0.0.1',
      PROFILES_HOSTS: '127.0.0.1',
      PROFILE_MIGRATION_ENABLED: '1',
      PROFILE_PREPARE_HOUSEHOLDS: householdId,
      NEW_LIBRARIES: 'members',
    };
    edge = await startEdge(dataDir, port, edgeEnv);
    console.log(`den-edge on ${edge.origin}`);
    const before = await readLibrary(edge, wire, keyText);
    check(
      'household exists before the split',
      before.status === 200,
      `status ${before.status}, ${before.rows.length} rows, wire_min ${before.wireMin}`,
    );
    if (before.status !== 200) return;
    const activityBefore = activityNames(wire, before.rows).length;
    console.log(`${activityBefore} activity rows in the household before the split`);

    // 3. warm a browser on the pre-split household, then keep a copy of its storage
    step('warm a browser on the pre-split household');
    const warmDir = join(work, 'profile-warm');
    let ctx = await launch(warmDir);
    const page = await seedLink(ctx, edge, keyText);
    await openSettings(page, edge);
    await quiet(edge, 4000);
    await ctx.close();
    const snapshot = join(work, 'profile-snapshot');
    cpSync(warmDir, snapshot, { recursive: true });
    console.log('browser storage snapshotted before the split');

    // 4. Enable Profiles with a PIN
    step('Settings › Profiles › Enable Profiles');
    ctx = await launch(warmDir);
    const splitPage = ctx.pages()[0] ?? (await ctx.newPage());
    await openSettings(splitPage, edge);
    const profiles = splitPage.locator('#profiles');
    await profiles.waitFor({ timeout: 60_000 });
    await splitPage.getByRole('button', { name: 'Enable Profiles' }).click();
    // A household with no Owner PIN is asked to make one; one with a PIN is asked for it.
    await splitPage.locator('#profiles-owner-pin').fill(PIN);
    let committed = false;
    // The page swaps into profile mode on commit and Settings changes under it, so the commit is read from den-edge:
    // a wire minimum of 5 with a profile directory in the household.
    for (let i = 0; i < 120 && !committed; i += 1) {
      const now = await readLibrary(edge, wire, keyText);
      committed = now.wireMin === 5 && now.rows.some((r) => r.profileDirectory);
      if (!committed) await sleep(1000);
    }
    check('Enable Profiles commits', committed);
    if (!committed) {
      const said = await splitPage
        .locator('#profiles')
        .innerText({ timeout: 3000 })
        .catch(() => '');
      console.log(`page said: ${said.replace(/\s+/g, ' ')}`);
      console.log(browserLog.slice(-15).join('\n'));
      const refusal = browserLog.find((l) => l.includes('refused this profile setup'));
      if (refusal)
        check('den-core accepts the household as a split source', false, refusal.split('\n')[0]);
      if (!DATA) {
        const now = await readLibrary(edge, wire, keyText);
        console.log(
          `household rows: ${now.rows.map((r) => `${r.migration.name}${r.migration.legacy ? '(legacy)' : ''}`).join(' ')}`,
        );
      }
    }
    await quiet(edge, 4000);
    await ctx.close();
    splitLogMark = browserLog.length;
    if (!committed) return;

    // 4a. The browser that performed the split reopens `/` with its own storage kept, exactly as it left it.
    step('reopen the browser that split, keeping its storage');
    {
      const logMark = edge.log.length;
      ctx = await launch(warmDir);
      await ctx.addInitScript(watchOwnerGate);
      const splitReopen = ctx.pages()[0] ?? (await ctx.newPage());
      const loop = [];
      splitReopen.on('pageerror', (e) => {
        if (e.message.includes('effect_update_depth')) loop.push(e.message);
      });
      await splitReopen.goto(`${edge.origin}/`);
      // The Owner set a PIN to enable Profiles, so a reopened browser asks for it before it opens the Owner.
      // Four digits submit the gate.
      const pin = splitReopen.locator('#owner-gate-pin');
      // A long-lived household takes longer to read before the gate can decide.
      await pin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
      const gateShown = await pin.isVisible().catch(() => false);
      check('a browser with no remembered profile is still asked for the Owner PIN', gateShown);
      if (gateShown) await pin.fill(PIN);
      await splitReopen
        .locator('button.profile-trigger')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {});
      await sleep(4000);
      const state = await (async () => ({
        trigger: (await splitReopen.locator('button.profile-trigger').count()) > 0,
        unavailable: (await splitReopen.locator('#profile-unavailable-title').count()) > 0,
        page: (await splitReopen.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160),
      }))().catch(() => null);
      const reopened = !!state && state.trigger && !state.unavailable;
      check(
        'the browser that split reopens / as the Owner with no error',
        reopened,
        JSON.stringify(state),
      );
      if (!reopened) {
        console.log(browserLog.slice(-15).join('\n'));
        console.log(
          edge.log
            .slice(logMark)
            .filter((l) => /\/lib\//.test(l))
            .join('\n'),
        );
      }
      check('the browser that split reopens / with no effect loop', loop.length === 0);
      const unread = browserLog.filter((line) =>
        line.includes('could not be read to its current head'),
      );
      check(
        'the browser that split reopens / and reads the household to its head',
        unread.length === 0,
        unread[0]?.split('\n')[0] ?? '',
      );
      await ctx.close().catch(() => {});
    }

    const afterSplit = await readLibrary(edge, wire, keyText);
    check('household wire_min is 5', afterSplit.wireMin === 5, `wire_min ${afterSplit.wireMin}`);
    const directory = afterSplit.rows.find((r) => r.profileDirectory)?.profileDirectory;
    const owner =
      directory?.profiles?.find?.((p) => p.id === directory.owner) ??
      directory?.profiles?.[directory.owner];
    const ownerKey = owner?.library?.value?.key ?? owner?.libraryKey;
    check('the directory names an Owner library', !!ownerKey);
    // Every profile household has its Kid out of the box (den#295): the Owner's first visit after the split made it.
    const kids = Object.values(directory?.profiles ?? {}).filter(
      (p) => p.role === 'kid' && !p.deleted?.value,
    );
    check(
      'the split household got its Kid, once',
      kids.length === 1 &&
        kids[0].policy.value.maximumAge === 12 &&
        kids[0].policy.value.unknownRatings === 'block',
      `${kids.length} Kid profiles`,
    );
    let ownerRows = null;
    if (ownerKey) {
      ownerRows = await readLibrary(edge, wire, ownerKey);
      check(
        'the Owner library exists and holds the activity',
        ownerRows.status === 200 && activityNames(wire, ownerRows.rows).length > 0,
        `status ${ownerRows.status}, ${ownerRows.rows.length} rows`,
      );
    }
    const strayAfterSplit = activityNames(wire, afterSplit.rows);
    check(
      'the committed household holds no activity',
      strayAfterSplit.length === 0,
      `${strayAfterSplit.length} activity rows`,
    );
    // Every preference is a profile's (profiles-v1 §6): the split household keeps none, region and services included.
    const householdPrefs = Object.keys(prefValues(afterSplit)).filter((key) =>
      key.startsWith('den.'),
    );
    check(
      'the committed household holds no preferences',
      householdPrefs.length === 0,
      householdPrefs.length ? `holds ${householdPrefs.join(', ')}` : '',
    );
    if (ownerRows && !DATA) {
      const ownerPrefs = prefValues(ownerRows);
      check(
        'the Owner library holds the household’s region and services',
        ownerPrefs['den.watchRegion']?.value?.string === 'FI' &&
          JSON.stringify(ownerPrefs['den.myServicePicks']?.value?.strings) === '["8@FI"]',
        `region ${JSON.stringify(ownerPrefs['den.watchRegion']?.value)}, services ${JSON.stringify(ownerPrefs['den.myServicePicks']?.value)}`,
      );
    }

    // 4a'. A returning Owner's browser, as one upgraded from 0.271.5 is: a persistent Owner and an Owner hint with no
    // library key. With a long-lived library a release once froze such a tab on its second load (the renderer stopped
    // answering), so two loads in a row must keep answering throughout and still draw Continue Watching.
    step('reopen twice as an Owner whose hint has no library key (an upgraded browser)');
    {
      ctx = await launch(join(work, 'profile-upgraded'));
      await nameSyntheticTitles(ctx);
      const upgraded = await seedLink(ctx, edge, keyText);
      await upgraded.evaluate(
        ([marker, hint]) => {
          localStorage.setItem('den.profile.active.v1', marker);
          localStorage.setItem('den.profile.hint.v1', hint);
        },
        [
          JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
          JSON.stringify({
            version: 1,
            profileId: directory.owner,
            name: 'Owner',
            avatar: 'owner',
          }),
        ],
      );
      for (const load of ['first', 'second']) {
        await upgraded.goto(`${edge.origin}/`, { waitUntil: 'commit' });
        const probe = await responsiveness(upgraded, RESPONSIVE_WINDOW_MS);
        const shelves = await upgraded
          .locator('main')
          .getByText('Continue Watching')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        check(
          `an upgraded Owner's ${load} load keeps answering (every round trip under ${MAX_ROUND_TRIP_MS} ms)`,
          !probe.unanswered && probe.slowest < MAX_ROUND_TRIP_MS,
          JSON.stringify({
            slowestRoundTripMs: probe.slowest,
            roundTrips: probe.trips,
            unanswered: probe.unanswered,
            continueWatchingAtMs: probe.continueWatchingAt,
          }),
        );
        if (probe.unanswered) break;
        check(`an upgraded Owner's ${load} load draws Continue Watching`, shelves);
      }
      // A frozen renderer can keep the browser from closing; it is abandoned rather than waited on.
      await Promise.race([ctx.close().catch(() => {}), sleep(15_000)]);
    }

    // 4a'. A returning Owner's browser, as one upgraded from 0.271.5 is: a persistent Owner and an Owner hint with no
    // library key. With a long-lived library a release once froze such a tab on its second load (the renderer stopped
    // answering), so two loads in a row must keep answering throughout and still draw Continue Watching.
    step('reopen twice as an Owner whose hint has no library key (an upgraded browser)');
    {
      ctx = await launch(join(work, 'profile-upgraded'));
      await nameSyntheticTitles(ctx);
      const upgraded = await seedLink(ctx, edge, keyText);
      await upgraded.evaluate(
        ([marker, hint]) => {
          localStorage.setItem('den.profile.active.v1', marker);
          localStorage.setItem('den.profile.hint.v1', hint);
        },
        [
          JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
          JSON.stringify({
            version: 1,
            profileId: directory.owner,
            name: 'Owner',
            avatar: 'owner',
          }),
        ],
      );
      for (const load of ['first', 'second']) {
        await upgraded.goto(`${edge.origin}/`, { waitUntil: 'commit' });
        const probe = await responsiveness(upgraded, RESPONSIVE_WINDOW_MS);
        const shelves = await upgraded
          .locator('main')
          .getByText('Continue Watching')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        check(
          `an upgraded Owner's ${load} load keeps answering (every round trip under ${MAX_ROUND_TRIP_MS} ms)`,
          !probe.unanswered && probe.slowest < MAX_ROUND_TRIP_MS,
          JSON.stringify({
            slowestRoundTripMs: probe.slowest,
            roundTrips: probe.trips,
            unanswered: probe.unanswered,
            continueWatchingAtMs: probe.continueWatchingAt,
          }),
        );
        if (probe.unanswered) break;
        check(`an upgraded Owner's ${load} load draws Continue Watching`, shelves);
      }
      // A frozen renderer can keep the browser from closing; it is abandoned rather than waited on.
      await Promise.race([ctx.close().catch(() => {}), sleep(15_000)]);
    }

    // 4b. A browser paired to the committed household with a persistent Owner profile selected. Home and Settings
    // must both open: no Svelte effect loop, a page that still answers, the profile switcher in the bar and no modal
    // over the library.
    step('reopen as the persistent Owner profile: Home and Settings');
    for (const path of ['/', '/settings']) {
      const dir = join(work, `profile-owner${path === '/' ? '-home' : '-settings'}`);
      ctx = await launch(dir);
      // A persistent profile selection, as the profile switcher keeps it for an Owner who chose their profile.
      await ctx.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          'den.profile.active.v1',
          JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
        ],
      );
      await ctx.addInitScript(watchOwnerGate);
      await nameSyntheticTitles(ctx);
      // Settings lists the countries a region can be picked from, which the rehearsal's TMDB stand-in answers.
      await stubStreaming(ctx, []);
      const ownerPage = await seedLink(ctx, edge, keyText);
      const loop = [];
      // Svelte reports the loop as a thrown error (a page error), and logs it to the console as well.
      ownerPage.on('pageerror', (e) => {
        if (e.message.includes('effect_update_depth')) loop.push(e.message);
      });
      await ownerPage.goto(`${edge.origin}${path}`);
      await ownerPage
        .locator('button.profile-trigger')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {});
      await sleep(4000);
      const answers = await Promise.race([
        ownerPage.evaluate(() => 1 + 1).then(() => true),
        sleep(10_000).then(() => false),
      ]).catch(() => false);
      const state = await (async () => ({
        trigger: (await ownerPage.locator('button.profile-trigger').count()) > 0,
        modal: (await ownerPage.locator('dialog[open]').count()) > 0,
        page: (await ownerPage.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160),
      }))().catch(() => null);
      check(
        `Owner profile opens ${path} without an effect loop`,
        loop.length === 0,
        loop.length ? `${loop.length} effect_update_depth_exceeded` : '',
      );
      check(`Owner profile ${path} still answers`, answers);
      // seedLink navigates before the page under test, so the log is read from the last navigation's start.
      const gate = await ownerPage.evaluate(() => window.__ownerGateSeen ?? null).catch(() => null);
      check(
        `a remembered Owner never sees the PIN gate on ${path}`,
        Array.isArray(gate) && gate.length === 0,
        JSON.stringify(gate),
      );
      // Let the first visit finish syncing and naming, so the second one starts from a warm local cache.
      if (path === '/') {
        let attempts = 0;
        let warm = false;
        while (!warm && attempts < 3) {
          if (attempts++) await ownerPage.goto(`${edge.origin}${path}`);
          warm = await ownerPage
            .locator('main')
            .getByText('Continue Watching')
            .first()
            .waitFor({ timeout: 25_000 })
            .then(
              () => true,
              () => false,
            );
        }
        check('the first visit syncs and names the Owner shelves', warm, `${attempts} attempt(s)`);
        await sleep(2000);
      }
      // The second visit has the remembered Owner in localStorage: nothing waits on the capability, directory or
      // activity model, so the first frame already carries the switcher and no loading or PIN state is ever drawn.
      await ownerPage.goto(`${edge.origin}${path}`);
      await ownerPage.locator('button.profile-trigger').first().waitFor({ timeout: 30_000 });
      await sleep(4000);
      const seen = await ownerPage
        .evaluate(() => ({
          gate: window.__ownerGateSeen,
          loading: window.__loadingSeen,
          trigger: window.__triggerSeen,
          hint: localStorage.getItem('den.profile.hint.v1') !== null,
          frames: window.__frames,
        }))
        .catch(() => null);
      if (path === '/') {
        // The Owner's own library opens from its local cache on the first frame, so the shelves that come from it are
        // already in the first frame that draws any shelf, and never pop in afterwards.
        const first = seen?.frames.findIndex((f) => f.continueWatching || f.watchlist || f.shelves);
        const at = first >= 0 ? seen.frames[first] : null;
        const detail = JSON.stringify({
          firstShelfFrame: at,
          continueWatchingAtMs: seen?.frames.find((f) => f.continueWatching)?.ms ?? null,
          watchlistAtMs: seen?.frames.find((f) => f.watchlist)?.ms ?? null,
        });
        check(
          'a returning Owner paints Continue Watching and Watchlist in the first shelf frame',
          !!at && at.continueWatching && at.watchlist,
          detail,
        );
      }
      check(`the Owner hint was remembered after ${path} settled`, !!seen?.hint);
      check(
        `a returning Owner on ${path} sees no PIN gate and no loading state`,
        !!seen && seen.gate.length === 0 && seen.loading.length === 0,
        JSON.stringify({ ...seen, frames: seen?.frames.length }),
      );
      check(
        `a returning Owner on ${path} has the switcher on the first frame`,
        !!seen && /^Switch profile, current \S/.test(seen.trigger[0]?.label ?? ''),
        JSON.stringify(seen?.trigger),
      );
      check(
        `Owner profile ${path} shows the switcher and no modal`,
        !!state && state.trigger && !state.modal,
        JSON.stringify(state),
      );
      if (path === '/settings' && !DATA)
        await checkOwnerPreferences(ownerPage, edge, wire, keyText, ownerKey);
      await ctx.close().catch(() => {});
    }

    // 4b''. Preferences are per profile: seeding, independent Owner and Kid edits, the Kid's PIN-gated Settings.
    if (!DATA) {
      const person = (profile) => ({
        id: profile.id,
        key: profile.library?.value?.key ?? profile.libraryKey,
        name: profile.display?.value?.name ?? profile.name,
      });
      await checkProfilePreferences(
        async (name, ownerId) => {
          const context = await launch(join(work, name));
          // Only the first load starts as the Owner: a later one keeps whichever profile the page switched to.
          await context.addInitScript(
            ([key, value]) => {
              try {
                if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
              } catch {
                // about:blank has no storage.
              }
            },
            [
              'den.profile.active.v1',
              JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerId }),
            ],
          );
          return context;
        },
        edge,
        wire,
        keyText,
        { owner: person(owner), kid: person(kids[0]) },
      );
      // REHEARSE_ONLY_PREFERENCES=1 stops here, for working on the scenario above without the long ones after it.
      if (process.env.REHEARSE_ONLY_PREFERENCES === '1') return;
    }

    // 4b'. A returning Owner who HAS kept, unsent work. The first frame opens the Owner library before the profile
    // pipeline answers; if the coordinator then opened a second session on that library, both would replay the same
    // kept work. From navigation start through the handover, every write to a library must be sent once, by one
    // session: no request repeated, and no library written by more than the one session.
    step('reopen as the persistent Owner with kept, unsent work');
    {
      ctx = await launch(join(work, 'profile-owner-kept'));
      await ctx.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          'den.profile.active.v1',
          JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
        ],
      );
      await nameSyntheticTitles(ctx);
      const keptPage = await seedLink(ctx, edge, keyText);
      await keptPage.goto(`${edge.origin}/`);
      await keptPage
        .locator('main')
        .getByText('Continue Watching')
        .first()
        .waitFor({ timeout: 60_000 });
      await sleep(2000);

      // Keep an edit: den-edge refuses the write, so the browser holds it unsent.
      const writes = /\/lib\/[^/]+\/(?:batch|member)$/;
      const refuse = (route) =>
        route.request().method() === 'POST' &&
        /\/batch$/.test(new URL(route.request().url()).pathname)
          ? route.abort('connectionfailed')
          : route.fallback();
      await ctx.route('**/lib/*/batch', refuse);
      await keptPage
        .getByRole('button', { name: /^Actions for Series/ })
        .first()
        .click({ force: true });
      await keptPage.getByRole('menuitem', { name: /Remove from Continue Watching/ }).click();
      await sleep(4000);
      await ctx.unroute('**/lib/*/batch', refuse);

      // Reopen with den-edge answering again, recording every library write from navigation start.
      const sent = [];
      ctx.on('request', (request) => {
        const url = new URL(request.url());
        if (['POST', 'PUT'].includes(request.method()) && writes.test(url.pathname))
          sent.push(`${request.method()} ${url.pathname} ${request.postData() ?? ''}`);
      });
      // Every session runs its own Worker, so Workers started are sessions opened.
      let workers = 0;
      keptPage.on('worker', () => workers++);
      await keptPage.goto(`${edge.origin}/`);
      await keptPage
        .locator('main')
        .getByText('Continue Watching')
        .first()
        .waitFor({ timeout: 60_000 });
      await sleep(8000);
      const kept = sent.filter((line) => line.startsWith('POST'));
      const byLibrary = new Map();
      for (const line of sent) {
        const id = line.split(' ')[1].split('/')[2];
        byLibrary.set(id, (byLibrary.get(id) ?? 0) + 1);
      }
      check(
        'the kept work is sent, and nothing is sent twice',
        kept.length >= 1 && new Set(sent).size === sent.length,
        `${sent.length} writes: ${sent.map((l) => l.split(' ').slice(0, 2).join(' ')).join(', ')}`,
      );
      check(
        'only one library is written, once',
        byLibrary.size === 1 && [...byLibrary.values()][0] === 1,
        JSON.stringify([...byLibrary.values()]),
      );
      check(
        'the Owner library is opened by one session, not two',
        workers <= MAX_SESSION_WORKERS,
        `${workers} Workers started (the household bootstrap, the Owner library, and the directory read)`,
      );
      await ctx.close().catch(() => {});
    }

    // 4b''. A returning Owner's billboard. The page paints the Owner's kept lead from index.html before any script
    // runs, then the Owner library's own billboard takes over: from navigation start, the title on screen is the Owner's
    // from the first painted frame and never changes. The first visit settles the Owner and keeps a billboard; every
    // visit after it is a returning Owner, recorded from navigation start.
    step("a returning Owner's billboard is the Owner's from the first paint and never changes");
    {
      ctx = await launch(join(work, 'profile-owner-billboard'));
      await ctx.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          'den.profile.active.v1',
          JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
        ],
      );
      await ctx.addInitScript(recordBillboard);
      await nameSyntheticTitles(ctx);
      const ranked = [];
      await stubAtlas(ctx, 9500, ranked);
      const heroPage = await seedLink(ctx, edge, keyText);
      for (const visit of [1, 2, 3]) {
        ranked.length = 0;
        await heroPage.goto(`${edge.origin}/`);
        await heroPage
          .locator('main')
          .getByText('Continue Watching')
          .first()
          .waitFor({ timeout: 60_000 });
        await sleep(6000);
        const frames = (await heroPage.evaluate(() => window.__billboards).catch(() => null)) ?? [];
        console.log(`billboard by painted frame, visit ${visit}: ${JSON.stringify(frames)}`);
        // The Owner's history lives in the Owner library after the split: the ranking asked of atlas carries it, and the
        // lead on screen is that ranking's, never the shared pool's.
        const lead = frames.findLast((f) => f.source === 'library')?.title ?? null;
        check(
          `the Owner's billboard is ranked against the Owner's history (visit ${visit})`,
          ranked.length > 0 && ranked.every((asked) => asked.library > 0),
          `${ranked.length} rankings asked, library titles per request: ${JSON.stringify(ranked.map((asked) => asked.library))}`,
        );
        check(
          `the Owner's billboard lead is from the ranking, not the shared pool (visit ${visit})`,
          lead !== null && !lead.endsWith(` ${SHARED_LEAD_ID}`),
          `lead ${JSON.stringify(lead)}`,
        );
        if (visit === 1) continue;
        const titles = frames.flatMap((f) => (f.title === null ? [] : [f.title]));
        const painted = frames.find((f) => f.title !== null);
        const blanks = frames.slice(frames.indexOf(painted)).filter((f) => f.title === null);
        check(
          `a returning Owner's billboard never changes title after it first paints (visit ${visit})`,
          titles.length > 0 && new Set(titles).size === 1,
          `${titles.length ? [...new Set(titles)].join(' -> ') : 'no billboard'} (${blanks.length} blank frames after first paint)`,
        );
        // The page's own early copy (index.html, before any script) is the first thing painted, not the library's.
        check(
          `a returning Owner's billboard is painted before the app loads (visit ${visit})`,
          painted?.source === 'shell',
          `first painted from ${painted?.source ?? 'nothing'} at ${painted?.ms ?? '-'} ms`,
        );
      }
      await ctx.close().catch(() => {});
    }

    // 4c. A remembered profile the household no longer has: the page may draw it from the hint at first, but the
    // coordinator then decides a PIN is needed and the gate must appear.
    step('reopen as a remembered profile the household no longer has');
    {
      ctx = await launch(join(work, 'profile-gone'));
      const gone = 'b'.repeat(32);
      await ctx.addInitScript(
        ([marker, hint]) => {
          localStorage.setItem('den.profile.active.v1', marker);
          localStorage.setItem('den.profile.hint.v1', hint);
        },
        [
          JSON.stringify({ version: 1, mode: 'persistent', profileId: gone }),
          JSON.stringify({ version: 1, profileId: gone, name: 'Owner', avatar: 'owner' }),
        ],
      );
      await ctx.addInitScript(watchOwnerGate);
      const gonePage = await seedLink(ctx, edge, keyText);
      await gonePage.goto(`${edge.origin}/`);
      const gate = gonePage.locator('#owner-gate-pin');
      await gate.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
      check(
        'a remembered profile that is gone still asks for the Owner PIN',
        await gate.isVisible(),
      );
      await ctx.close().catch(() => {});
    }

    // 5. the pre-split browser comes back: one tab (then two with REHEARSE_TWO_TABS=1). Each starts from the committed household as the split
    // left it (den-edge restarted on a copy of its data, same port, so the browser's origin is the one it cached), so
    // one phase's write-back cannot hide or inflate the next one's.
    await edge.stop();
    const committedData = join(work, 'edge-data-committed');
    cpSync(dataDir, committedData, { recursive: true });
    for (const tabs of process.env.REHEARSE_TWO_TABS === '1' ? [1, 2] : [1]) {
      step(`reopen the pre-split browser with ${tabs} tab${tabs > 1 ? 's' : ''}`);
      rmSync(dataDir, { recursive: true, force: true });
      cpSync(committedData, dataDir, { recursive: true });
      edge = await startEdge(dataDir, port, edgeEnv);
      const dir = join(work, `profile-restored-${tabs}`);
      cpSync(snapshot, dir, { recursive: true });
      const mark = edge.log.length;
      ctx = await launch(dir);
      const pages = [ctx.pages()[0] ?? (await ctx.newPage())];
      if (tabs > 1) pages.push(await ctx.newPage());
      await Promise.all(pages.map((p) => p.goto(`${edge.origin}/`)));
      const started = Date.now();
      const samples = [];
      while (Date.now() - started < SETTLE_MS) {
        await sleep(5000);
        samples.push(requestCount(edge, BATCH, mark));
      }
      const batches = requestCount(edge, BATCH, mark);
      await ctx.close();
      console.log(`batch writes over time: ${samples.join(', ')}`);
      check(
        `no write storm with ${tabs} cached tab${tabs > 1 ? 's' : ''} (at most ${MAX_BATCHES} batch writes)`,
        batches <= MAX_BATCHES,
        `${batches} POST /lib/:id/batch in ${Math.round(SETTLE_MS / 1000)}s`,
      );
      const after = await readLibrary(edge, wire, keyText);
      const stray = activityNames(wire, after.rows);
      check(
        `no Owner activity written back into the household (${tabs} tab${tabs > 1 ? 's' : ''})`,
        stray.length === 0,
        `${stray.length} activity rows${stray.length ? `, e.g. ${stray.slice(0, 4).join(', ')}` : ''}`,
      );
      check(
        `household wire_min stays 5 (${tabs} tab${tabs > 1 ? 's' : ''})`,
        after.wireMin === 5,
        `wire_min ${after.wireMin}`,
      );
      writeFileSync(join(work, `den-edge-reopen-${tabs}.log`), edge.log.join('\n'));
      await edge.stop();
    }
    edge = null;
  } finally {
    if (edge) {
      writeFileSync(join(work, 'den-edge.log'), edge.log.join('\n'));
      // A stopped den-edge is stopped again harmlessly; a running one is stopped here.
      await edge.stop();
    }
    await close();
  }
}

try {
  await main();
} catch (error) {
  check('the rehearsal ran to the end', false, String(error?.stack ?? error));
  console.log(browserLog.slice(-15).join('\n'));
}
// A page drawn from a session that has since been closed reads and writes through a closed client: production's
// "Home could not be kept … library service client is closed". Every page opened after the split is held to it. The
// split itself is not: committing it moves the household to wire 5, and the reconnect cancels the splitting page's
// in-flight reads (Settings' Kid-profile status among them), which is reported here but not this check's subject.
const closedClient = (lines) => lines.filter((l) => l.includes('library service client is closed'));
const duringSplit = closedClient(browserLog.slice(0, splitLogMark));
if (duringSplit.length)
  console.log(`closed-client lines while the split committed: ${duringSplit.length}`);
const afterSplit = closedClient(browserLog.slice(splitLogMark));
check(
  'no page opened after the split ever used a closed library session',
  afterSplit.length === 0,
  `${afterSplit.length} warnings${afterSplit.length ? `, e.g. ${afterSplit[0].split('\n')[0]}` : ''}`,
);

console.log(`\n== startup milestones (${startupLog.length} lines)`);
for (const line of startupLog) console.log(line);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length ? 'REHEARSAL FAILED' : 'REHEARSAL PASSED'}: ${results.length - failed.length}/${results.length} checks`,
);
for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (failed.length || KEEP) console.log(`den-edge log and browser profiles kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
