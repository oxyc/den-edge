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
const BINARY = option('bin', 'DEN_EDGE_BIN', join(ROOT, 'target/debug/den-edge'));
const KEEP = flag('keep') || process.env.REHEARSE_KEEP === '1';
const HEADED = flag('headed');

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
  for (;;) {
    const response = await fetch(`${edge.origin}/lib/${keys.id}/changes?since=${since}`, {
      headers: { 'x-den-library-token': keys.token, 'x-den-wire': '5' },
    });
    const status = response.status;
    if (!response.ok) return { status, rows, wireMin, keys };
    wireMin = Number(response.headers.get('x-den-wire-min'));
    const body = await response.json();
    for (const entry of body.entries) {
      since = Math.max(since, entry.seq);
      if (entry.v === null) continue;
      rows.push(await wire.openEntry(keys, entry.k, entry.v));
      rows.at(-1).migration = await wire.openMigrationRow(keys, entry.k, entry.v);
    }
    if (!body.more) return { status, rows, wireMin, keys };
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
    })) {
      const { k, v } = await wire.seal(keys, row);
      writes.push({ k, base: 0, v });
    }
    const response = await fetch(`${edge.origin}/lib/${keys.id}/batch`, {
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
    if (!response.ok)
      fail(`seeding the synthetic household failed: ${response.status} ${await response.text()}`);
    const { applied, conflicts } = await response.json();
    if (conflicts?.length) fail(`seeding conflicted on ${conflicts.length} rows`);
    console.log(`seeded ${applied.length} synthetic rows`);
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

async function launch(profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: !HEADED,
    executablePath: executablePath(),
    viewport: { width: 1280, height: 900 },
  });
  const watch = (page) => {
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) browserLog.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => browserLog.push(`[pageerror] ${e.message}`));
  };
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  return ctx;
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
    if (!committed) return;

    const afterSplit = await readLibrary(edge, wire, keyText);
    check('household wire_min is 5', afterSplit.wireMin === 5, `wire_min ${afterSplit.wireMin}`);
    const directory = afterSplit.rows.find((r) => r.profileDirectory)?.profileDirectory;
    const owner =
      directory?.profiles?.find?.((p) => p.id === directory.owner) ??
      directory?.profiles?.[directory.owner];
    const ownerKey = owner?.library?.value?.key ?? owner?.libraryKey;
    check('the directory names an Owner library', !!ownerKey);
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
      check(
        `Owner profile ${path} shows the switcher and no modal`,
        !!state && state.trigger && !state.modal,
        JSON.stringify(state),
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
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length ? 'REHEARSAL FAILED' : 'REHEARSAL PASSED'}: ${results.length - failed.length}/${results.length} checks`,
);
for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (failed.length || KEEP) console.log(`den-edge log and browser profiles kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
