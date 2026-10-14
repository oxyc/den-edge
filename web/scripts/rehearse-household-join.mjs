// `npm run rehearse:join`: a browser's own household (den#295) joins another household through the real pairing
// relay, end to end. The real den-edge binary serves the built web app with `NEW_LIBRARIES=visitors`; real Den Web in
// real Chromium makes each household the way a person does (a kept title, the first switch to Kid sets the Owner PIN)
// and links to the other household with a code. The other side of the pairing is this script, hosting it with the
// app's own pairing code as a TV does. What den-edge holds is read over HTTP and decrypted with the app's own code
// before and after, so every document is accounted for. Title data is a fixture answered in the browser; every
// library request goes to den-edge.
//
// Scenarios: a household with Owner, Kid and PIN joined (the Kid merges into its Kid of the same name); the same with
// the browser killed mid-merge and again mid-retirement; a household with no Kid (the browser's Kid is made there,
// killed mid-creation); a household without profiles (refused while a Kid has activity, Owner-only otherwise).
//
// Needs `cargo build --locked` (or DEN_EDGE_BIN) and `npm run build` first. REHEARSE_DIST serves another build.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as listen } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const BINARY = process.env.DEN_EDGE_BIN ?? join(ROOT, 'target/debug/den-edge');
const DIST = process.env.REHEARSE_DIST ?? join(WEB, 'dist');
const KEEP = process.env.REHEARSE_KEEP === '1';
const HEADED = process.argv.includes('--headed');
const TV_PIN = '1234';
const BROWSER_PIN = '5678';
/** The joining browser's Owner keeps a title the household joined has too (merged) and one it hasn't. */
const JOINER_TITLES = { titles: [1002, 1003], kidTitle: 2001 };

if (!existsSync(BINARY)) fail(`no den-edge binary at ${BINARY}: run cargo build --locked`);
if (!existsSync(join(DIST, 'index.html'))) fail('no built web app: run npm run build in web/');

function fail(message) {
  console.error(`rehearse-household-join: ${message}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const work = mkdtempSync(join(tmpdir(), 'den-household-join-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const step = (message) => console.log(`\n== ${message}`);

// --- the app's own wire and pairing code, through Vite ---
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

// --- den-edge ---
const freePort = () =>
  new Promise((done) => {
    const probe = listen().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

async function startEdge(dataDir) {
  const port = await freePort();
  const log = [];
  const child = spawn(BINARY, [], {
    env: {
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_REQUESTS: '1',
      WEB_DIR: DIST,
      WEB_HOSTS: '127.0.0.1',
      PROFILES_HOSTS: '127.0.0.1',
      NEW_LIBRARIES: 'visitors',
      // Each browser here is its own visitor (`x-forwarded-for`): one address may start five libraries a minute.
      TRUSTED_PROXIES: '127.0.0.1',
    },
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
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200 && !ready; i += 1) {
    if (child.exitCode !== null) fail(`den-edge exited ${child.exitCode}:\n${log.join('\n')}`);
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

/** A library as den-edge holds it, opened with the app's code: its status, rows and directory. */
async function readLibrary(edge, wire, keyText) {
  const keys = await wire.deriveKeys(Buffer.from(keyText, 'base64'));
  const rows = [];
  let directory = null;
  let since = 0;
  for (;;) {
    const response = await fetch(`${edge.origin}/lib/${keys.id}/changes?since=${since}`, {
      headers: { 'x-den-library-token': keys.token, 'x-den-wire': '5' },
    });
    if (!response.ok) return { status: response.status, rows, directory, id: keys.id };
    const body = await response.json();
    for (const entry of body.entries) {
      since = Math.max(since, entry.seq);
      const opened = await wire.openEntry(keys, entry.k, entry.v);
      if (opened.profileDirectory) directory = opened.profileDirectory;
      else if (opened.row) rows.push(opened.row);
    }
    if (!body.more) return { status: 200, rows, directory, id: keys.id };
  }
}

const isDocument = (row) => ['title', 'season', 'delivery'].includes(row.kind);
/** Key order-free JSON, so two equal documents compare equal. */
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
const documentsOf = (wire, library) =>
  new Map(library.rows.filter(isDocument).map((row) => [wire.rowName(row), row]));

/** A household's live Owner and Kids, from its directory. */
function profilesOf(directory) {
  const live = Object.values(directory?.profiles ?? {}).filter((p) => !p.deleted.value);
  return {
    owner: directory?.profiles?.[directory.owner] ?? null,
    kids: live.filter((p) => p.role === 'kid'),
  };
}

// --- a TV, as far as pairing goes: it hosts a code and hands over its household key ---
function tvPairing(edge, app, householdKey, name = 'Living room TV') {
  const { wire, pairing } = app;
  let shown;
  const code = new Promise((done) => (shown = done));
  const stop = new AbortController();
  const done = pairing.host({
    label: name,
    onCode: shown,
    allow: async () => true,
    seal: async (handoverKey, host, linkKey) => {
      const link = wire.fromBase64url(linkKey);
      const sealed = await pairing.sealHandover(wire.fromBase64url(handoverKey), {
        host,
        linkKey: link,
        libraryKey: new Uint8Array(Buffer.from(householdKey, 'base64')),
      });
      return {
        sealed: wire.toBase64url(sealed),
        linkKey,
        inboxKey: (await pairing.linkKeys(link)).inbox,
      };
    },
    fetchImpl: (path, init) => fetch(`${edge.origin}${path}`, init),
    signal: stop.signal,
  });
  // The handover is over once the joiner has read it; a pairing that never finishes is ended after a minute.
  const finished = () => Promise.race([done, sleep(60_000)]).finally(() => stop.abort());
  return { code, finished };
}

// --- the browser ---
const movie = {
  id: 1002,
  title: 'Movie 1002',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A movie, for the detail page to show.',
  genres: [{ name: 'Drama' }],
  vote_average: 7.5,
  vote_count: 500,
  credits: { cast: [] },
  recommendations: { results: [] },
};

function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(system) ? system : undefined;
}

const browserLog = [];

/** A browser of its own, at its own visitor address. */
async function launch(name, address) {
  const ctx = await chromium.launchPersistentContext(join(work, `browser-${name}`), {
    headless: !HEADED,
    executablePath: executablePath(),
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'x-forwarded-for': address },
  });
  const watch = (page) => {
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type()))
        browserLog.push(`[${name}] [${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => browserLog.push(`[${name}] [pageerror] ${e.message}`));
  };
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  // A Kid opens a title only with its age known (den-core's policy; unrated titles are blocked): this origin's atlas
  // answers that every fixture film is for all ages, and nothing else.
  await ctx.route('**/atlas/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'atlas', version: '0.0.0' } });
    if (path.startsWith('/atlas/index/title/movie/'))
      return route.fulfill({ json: { minimumAge: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  // Every film is the fixture, under the id it was asked for.
  await ctx.route('**/tmdb/3/**', (route) => {
    const id = Number(/\/movie\/(\d+)/.exec(new URL(route.request().url()).pathname)?.[1] ?? 1002);
    return route.fulfill({ json: { ...movie, id, title: `Movie ${id}` } });
  });
  await ctx.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  return ctx;
}

const firstPage = async (ctx) => ctx.pages()[0] ?? (await ctx.newPage());
const stored = (page, key) => page.evaluate((name) => localStorage.getItem(name), key);
const trigger = (page) => page.locator('button.profile-trigger').first();
const current = async (page) =>
  ((await trigger(page)
    .getAttribute('aria-label')
    .catch(() => '')) ??
    '') ||
  '';

async function until(condition, limitMs = 60_000, everyMs = 500) {
  const started = Date.now();
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() - started > limitMs) return null;
    await sleep(everyMs);
  }
}

async function openTitle(page, edge, id = 1002) {
  await page.goto(`${edge.origin}/movie/${id}`);
  await page.getByRole('heading', { name: `Movie ${id}`, level: 1 }).waitFor({ timeout: 60_000 });
}

const watchlistPressed = (page) =>
  page
    .getByRole('button', { name: 'Watchlist', exact: true })
    .getAttribute('aria-pressed')
    .catch(() => null);

async function openSwitcher(page) {
  await trigger(page).waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await page.locator('dialog[open]').count())) await trigger(page).click();
  await page.locator('dialog[open] .profile-choice').first().waitFor({ timeout: 30_000 });
}

/**
 * A browser with no TV makes its household the way a person does: it keeps titles (Owner activity; the first makes
 * the household), and, unless `kid` is false, its first switch to Kid sets the Owner PIN; with `kidTitle` the Kid keeps
 * a title of its own. It ends on the Owner.
 */
async function makeHousehold(
  ctx,
  edge,
  wire,
  { pin, titles = [1002], kid = true, kidTitle = null },
) {
  const page = await firstPage(ctx);
  await page.goto(`${edge.origin}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click({ timeout: 30_000 });
  const plan = JSON.parse((await stored(page, 'den.household.plan')) ?? 'null');
  // Each kept title is in the library before the next step: the Owner's until the Kid exists.
  const keep = async (id, libraryKey) => {
    await openTitle(page, edge, id);
    await page.getByRole('button', { name: 'Watchlist', exact: true }).click();
    if (!libraryKey) {
      const made = await until(
        async () => (await stored(page, 'den.household')) === plan?.householdKey,
      );
      if (!made) throw new Error('the browser did not make its household');
    }
    await until(async () =>
      (await readLibrary(edge, wire, libraryKey ?? plan.ownerKey)).rows.some(
        (row) => row.kind === 'title' && row.title?.id === id && row.status?.value === 'watchlist',
      ),
    );
  };
  // The first title makes the household; the rest are kept once its Kid is made and the page is the Owner again.
  await keep(titles[0], null);
  if (kid) {
    const kidMade = async () =>
      profilesOf((await readLibrary(edge, wire, plan.householdKey)).directory).kids.length === 1;
    // The Owner's visit makes the household's Kid; a visit that asked too early asks again on the next.
    if (!(await until(kidMade, 30_000))) {
      await page.reload();
      if (!(await until(kidMade))) throw new Error('the household’s Kid was not made');
    }
    await openSwitcher(page);
    await page.getByRole('button', { name: 'Use Kids' }).click();
    await page.getByLabel('New Owner PIN').fill(pin);
    await page.getByLabel('Confirm Owner PIN').fill(pin);
    await page
      .locator('button.profile-trigger[aria-label*="current Kids"]')
      .first()
      .waitFor({ timeout: 60_000 });
    if (kidTitle)
      await keep(
        kidTitle,
        profilesOf((await readLibrary(edge, wire, plan.householdKey)).directory).kids[0].library
          .value.key,
      );
    await openSwitcher(page);
    await page.getByRole('button', { name: 'Use Owner' }).click();
    await page.locator('#owner-pin').fill(pin);
    await page
      .locator('#owner-pin')
      .press('Enter')
      .catch(() => {});
    await page
      .locator('button.profile-trigger[aria-label*="current Owner"]')
      .first()
      .waitFor({ timeout: 60_000 });
    await page.keyboard.press('Escape').catch(() => {});
  }
  for (const id of titles.slice(1)) await keep(id, plan.ownerKey);
  return { ...plan, page };
}

/** What den-edge holds for a household: its directory, and the documents of its Owner and each Kid. */
async function snapshot(edge, wire, householdKey) {
  const household = await readLibrary(edge, wire, householdKey);
  const { owner, kids } = profilesOf(household.directory);
  const library = async (key) => readLibrary(edge, wire, key);
  return {
    household,
    owner,
    kids,
    ownerLibrary: owner ? await library(owner.library.value.key) : null,
    kidLibraries: await Promise.all(kids.map((kid) => library(kid.library.value.key))),
  };
}

/** Settings › Linked devices › Link your Apple TV, with the code the TV shows; the TV's Owner PIN when asked. */
async function linkTv(page, edge, code, pin, label) {
  await page.goto(`${edge.origin}/settings#linked-devices`);
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 60_000 });
  const row = page.locator('#linked-devices > button.row');
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await page.locator('#join-library-code').fill(code);
  await page
    .locator('#linked-devices-panel')
    .getByRole('button', { name: 'Link', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Link this browser to that TV?' })
    .getByRole('button', { name: 'Link', exact: true })
    .click();
  if (!pin) return;
  const field = page.locator('#join-owner-pin');
  const asked = await field.waitFor({ timeout: 60_000 }).then(
    () => true,
    () => false,
  );
  check(`${label}: linking asks once for the TV household's Owner PIN`, asked);
  if (!asked) return;
  await field.fill('0000');
  await page.locator('form.join-pin').getByRole('button', { name: 'Link' }).click();
  check(
    `${label}: a wrong PIN is refused and moves nothing`,
    await page
      .getByText('That PIN didn’t match.')
      .waitFor({ timeout: 60_000 })
      .then(
        () => true,
        () => false,
      ),
  );
  await field.fill(pin);
  await page.locator('form.join-pin').getByRole('button', { name: 'Link' }).click();
}

/** The browser has joined: it holds a link to `householdKey` and no longer points at a household of its own. */
const joinedTo = (page, householdKey) =>
  until(async () => {
    const links = JSON.parse((await stored(page, 'den.links')) ?? '[]');
    return (
      links.some((link) => link.libraryKey === householdKey) &&
      (await stored(page, 'den.household')) === null &&
      (await stored(page, 'den.household.join')) === null
    );
  }, 120_000);

/**
 * Every document the browser's household held is accounted for in the household joined: each Owner document, merged
 * with what that household's Owner held, is exactly what its Owner holds now, and the same for each Kid into its
 * target. Nothing else is in either: every document there came from one side or the other.
 */
function checkCarried(label, wire, before, source, after, kidTarget) {
  const compare = (what, held, ...sides) => {
    const expected = new Map();
    for (const side of sides)
      for (const [name, doc] of side)
        expected.set(name, expected.has(name) ? wire.mergeDocument(expected.get(name), doc) : doc);
    const missing = [...expected].filter(
      ([name, doc]) =>
        !held.has(name) ||
        canonical(wire.mergeDocument(held.get(name), doc)) !== canonical(held.get(name)),
    );
    const extra = [...held.keys()].filter((name) => !expected.has(name));
    check(
      `${label}: every ${what} document is accounted for`,
      missing.length === 0 && extra.length === 0 && expected.size > 0,
      `${expected.size} expected, ${held.size} held, ${missing.length} missing, ${extra.length} unexpected`,
    );
  };
  compare(
    'Owner',
    documentsOf(wire, after.ownerLibrary),
    documentsOf(wire, before.ownerLibrary),
    documentsOf(wire, source.ownerLibrary),
  );
  const target = after.kids.findIndex(kidTarget);
  const previous = before.kids.findIndex(kidTarget);
  if (!check(`${label}: the browser's Kid has its Kid in the household joined`, target >= 0))
    return;
  compare(
    'Kid',
    documentsOf(wire, after.kidLibraries[target]),
    previous >= 0 ? documentsOf(wire, before.kidLibraries[previous]) : new Map(),
    documentsOf(wire, source.kidLibraries[0]),
  );
}

async function checkRetired(label, edge, wire, source, sourceKey) {
  const statuses = [
    (await readLibrary(edge, wire, sourceKey)).status,
    (await readLibrary(edge, wire, source.owner.library.value.key)).status,
    ...(
      await Promise.all(source.kids.map((kid) => readLibrary(edge, wire, kid.library.value.key)))
    ).map((library) => library.status),
  ];
  check(
    `${label}: the browser's household, its Owner and its Kid are retired on den-edge`,
    statuses.every((status) => status === 410),
    statuses.join(', '),
  );
}

async function checkOpensAsOwner(label, page, edge) {
  // A title only this browser kept: the household joined's Owner has it only through the join.
  await openTitle(page, edge, 1003).catch(() => {});
  const as = await until(async () => {
    const said = await current(page);
    return said.includes('current') ? said : null;
  }, 60_000);
  check(
    `${label}: the browser now opens as the household's Owner, with no PIN gate`,
    !!as?.includes('current Owner') && (await page.locator('#owner-gate-pin').count()) === 0,
    as ?? 'no profile shown',
  );
  check(
    `${label}: and shows the title it kept, from that Owner's library`,
    !!(await until(async () => (await watchlistPressed(page)) === 'true', 30_000)),
    String(await watchlistPressed(page)),
  );
}

let address = 0;
const nextAddress = () => `10.0.0.${(address += 1)}`;

// 1. A TV household (Owner, Kid, PIN) is joined by a browser household with Owner and Kid activity. The Kid merges into
// the household's Kid of the same name and age.
async function joinsHousehold(edge, app) {
  const { wire } = app;
  step('a browser household joins a household with Owner, Kid and PIN');
  const tvBrowser = await launch('tv-household', nextAddress());
  const tv = await makeHousehold(tvBrowser, edge, wire, { pin: TV_PIN });
  await tvBrowser.close();
  const browser = await launch('joiner', nextAddress());
  const own = await makeHousehold(browser, edge, wire, { pin: BROWSER_PIN, ...JOINER_TITLES });
  const before = await snapshot(edge, wire, tv.householdKey);
  const source = await snapshot(edge, wire, own.householdKey);
  check(
    'before: the household joined has one Kid, and the browser’s Kid has activity',
    before.kids.length === 1 && documentsOf(wire, source.kidLibraries[0]).size > 0,
  );
  const pairing = tvPairing(edge, app, tv.householdKey);
  await linkTv(own.page, edge, await pairing.code, TV_PIN, 'join');
  const joined = await joinedTo(own.page, tv.householdKey);
  await pairing.finished();
  check('the browser links to the household joined, and forgets its own', !!joined);
  const after = await snapshot(edge, wire, tv.householdKey);
  checkCarried('join', wire, before, source, after, (kid) => kid.display.value.name === 'Kids');
  check(
    'join: the browser’s Kid exists once in the household joined (merged into its Kid of the same name)',
    after.kids.length === 1,
    after.kids
      .map((kid) => `${kid.display.value.name} (${kid.policy.value.maximumAge})`)
      .join(', '),
  );
  check(
    'join: the household joined keeps its directory, Owner and Owner PIN',
    after.household.directory?.owner === before.household.directory?.owner &&
      canonical(
        after.household.rows.find((r) => r.kind === 'set' && r.name === 'keys')?.values
          ?.parentalPIN,
      ) ===
        canonical(
          before.household.rows.find((r) => r.kind === 'set' && r.name === 'keys')?.values
            ?.parentalPIN,
        ),
  );
  await checkRetired('join', edge, wire, source, own.householdKey);
  await checkOpensAsOwner('join', own.page, edge);
  await browser.close();
}

// 2. The same, with the browser killed once mid-merge (its first write into the Owner library joined) and once
// mid-retirement (right after its first retirement landed). Each reload finishes the join, once.
async function joinKilledMidway(edge, app) {
  const { wire } = app;
  step('a join killed mid-merge and again mid-retirement');
  const tvBrowser = await launch('tv-household-2', nextAddress());
  const tv = await makeHousehold(tvBrowser, edge, wire, { pin: TV_PIN });
  await tvBrowser.close();
  const at = nextAddress();
  let browser = await launch('joiner-2', at);
  const own = await makeHousehold(browser, edge, wire, { pin: BROWSER_PIN, ...JOINER_TITLES });
  const before = await snapshot(edge, wire, tv.householdKey);
  const source = await snapshot(edge, wire, own.householdKey);
  const ownerId = (await wire.deriveKeys(Buffer.from(before.owner.library.value.key, 'base64'))).id;
  let killed;
  let killing = new Promise((done) => (killed = done));
  await browser.route(`**/lib/${ownerId}/batch`, (route) => {
    killed();
    return route.abort();
  });
  const pairing = tvPairing(edge, app, tv.householdKey);
  await linkTv(own.page, edge, await pairing.code, TV_PIN, 'killed');
  await pairing.finished();
  const cut = await Promise.race([killing.then(() => true), sleep(60_000).then(() => false)]);
  await browser.close();
  check('killed: the browser was closed with its first merge write in flight', cut);
  const halfway = await snapshot(edge, wire, own.householdKey);
  check('killed: its household is still there, nothing retired', halfway.household.status === 200);

  browser = await launch('joiner-2', at);
  killing = new Promise((done) => (killed = done));
  await browser.route('**/lib/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response });
    killed();
  });
  let page = await firstPage(browser);
  await page.goto(`${edge.origin}/`);
  const retiring = await Promise.race([killing.then(() => true), sleep(120_000).then(() => false)]);
  await browser.close();
  check('killed: the reload resumed by itself and was closed after its first retirement', retiring);

  browser = await launch('joiner-2', at);
  page = await firstPage(browser);
  await page.goto(`${edge.origin}/`);
  check('killed: the next reload finishes the join', !!(await joinedTo(page, tv.householdKey)));
  const after = await snapshot(edge, wire, tv.householdKey);
  checkCarried('killed', wire, before, source, after, (kid) => kid.display.value.name === 'Kids');
  check('killed: still one Kid in the household joined', after.kids.length === 1);
  await checkRetired('killed', edge, wire, source, own.householdKey);
  await checkOpensAsOwner('killed', page, edge);
  await browser.close();
}

// 3. A household with no Kid: the browser's Kid is made there through the Kid journal, killed between its library and
// its directory write. No Owner PIN exists, so none is asked.
async function joinMakesKid(edge, app) {
  const { wire } = app;
  step('a browser household joins a household with no Kid');
  const tvBrowser = await launch('tv-household-3', nextAddress());
  // The household's own Kid is the second library started under its membership: refused here.
  let started = 0;
  await tvBrowser.route('**/lib/*/batch', (route) => {
    if (route.request().headers()['x-den-library-member'] && ++started > 1) return route.abort();
    return route.continue();
  });
  const tv = await makeHousehold(tvBrowser, edge, wire, { pin: TV_PIN, kid: false });
  await sleep(3000);
  await tvBrowser.close();
  const at = nextAddress();
  let browser = await launch('joiner-3', at);
  const own = await makeHousehold(browser, edge, wire, { pin: BROWSER_PIN, ...JOINER_TITLES });
  const before = await snapshot(edge, wire, tv.householdKey);
  const source = await snapshot(edge, wire, own.householdKey);
  check('before: the household joined has no Kid and no Owner PIN', before.kids.length === 0);
  let killed;
  const killing = new Promise((done) => (killed = done));
  // The Kid's library is the one library the join starts under the joined household's membership: closed once its
  // first write has landed, before the directory names it.
  await browser.route('**/lib/*/batch', async (route) => {
    if (!route.request().headers()['x-den-library-member']) return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response });
    killed();
  });
  const pairing = tvPairing(edge, app, tv.householdKey);
  await linkTv(own.page, edge, await pairing.code, null, 'made');
  await pairing.finished();
  const cut = await Promise.race([killing.then(() => true), sleep(60_000).then(() => false)]);
  await browser.close();
  check('made: the browser was closed while its Kid was being made', cut);
  browser = await launch('joiner-3', at);
  const page = await firstPage(browser);
  await page.goto(`${edge.origin}/`);
  check('made: the reload finishes the join', !!(await joinedTo(page, tv.householdKey)));
  const after = await snapshot(edge, wire, tv.householdKey);
  const kid = source.kids[0];
  check(
    'made: the browser’s Kid exists once in the household joined, with its name and age',
    after.kids.length === 1 &&
      after.kids[0].display.value.name === kid.display.value.name &&
      after.kids[0].policy.value.maximumAge === kid.policy.value.maximumAge &&
      after.kids[0].policy.value.unknownRatings === 'block',
    after.kids.map((k) => k.display.value.name).join(', '),
  );
  checkCarried(
    'made',
    wire,
    before,
    source,
    after,
    (k) => k.display.value.name === kid.display.value.name,
  );
  await checkRetired('made', edge, wire, source, own.householdKey);
  await checkOpensAsOwner('made', page, edge);
  await browser.close();
}

// 4. A household without profiles: refused while the browser's Kid has activity, nothing changed; a browser whose Kid
// has none moves its Owner's activity into the household, as a library kept here always did.
async function joinLegacy(edge, app) {
  const { wire } = app;
  step('a household without profiles');
  const legacyKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const keys = await wire.deriveKeys(Buffer.from(legacyKey, 'base64'));
  const prefs = await wire.seal(keys, { kind: 'set', schema: 2, name: 'prefs', values: {} });
  const seeded = await fetch(`${edge.origin}/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': keys.token,
      'x-den-wire': '4',
      'x-den-wire-min': '4',
      'x-den-generation': '0',
    },
    body: JSON.stringify({ writes: [{ ...prefs, base: 0 }] }),
  });
  if (!seeded.ok) throw new Error(`the household without profiles was not made: ${seeded.status}`);
  const legacyBefore = await readLibrary(edge, wire, legacyKey);

  let browser = await launch('joiner-4', nextAddress());
  const own = await makeHousehold(browser, edge, wire, { pin: BROWSER_PIN, ...JOINER_TITLES });
  const source = await snapshot(edge, wire, own.householdKey);
  let pairing = tvPairing(edge, app, legacyKey);
  await linkTv(own.page, edge, await pairing.code, null, 'legacy');
  await pairing.finished();
  check(
    'legacy: linking is refused with a message naming the Kid profiles',
    await own.page
      .getByText('doesn’t have profiles yet')
      .waitFor({ timeout: 60_000 })
      .then(
        () => true,
        () => false,
      ),
  );
  const unchanged = await snapshot(edge, wire, own.householdKey);
  const legacyAfter = await readLibrary(edge, wire, legacyKey);
  check(
    'legacy: nothing changed, on either side',
    unchanged.household.status === 200 &&
      (await stored(own.page, 'den.household')) === own.householdKey &&
      (await stored(own.page, 'den.household.join')) === null &&
      documentsOf(wire, unchanged.ownerLibrary).size ===
        documentsOf(wire, source.ownerLibrary).size &&
      legacyAfter.rows.length === legacyBefore.rows.length,
  );
  await browser.close();

  browser = await launch('joiner-5', nextAddress());
  const quiet = await makeHousehold(browser, edge, wire, { pin: BROWSER_PIN });
  const quietSource = await snapshot(edge, wire, quiet.householdKey);
  pairing = tvPairing(edge, app, legacyKey);
  await linkTv(quiet.page, edge, await pairing.code, null, 'legacy-owner');
  await pairing.finished();
  check(
    'legacy-owner: a browser whose Kid has no activity joins',
    !!(await joinedTo(quiet.page, legacyKey)),
  );
  const held = documentsOf(wire, await readLibrary(edge, wire, legacyKey));
  const owner = documentsOf(wire, quietSource.ownerLibrary);
  check(
    'legacy-owner: the household holds every Owner document',
    owner.size > 0 &&
      [...owner].every(
        ([name, doc]) =>
          held.has(name) &&
          canonical(wire.mergeDocument(held.get(name), doc)) === canonical(held.get(name)),
      ),
    `${owner.size} Owner documents, ${held.size} held`,
  );
  await checkRetired('legacy-owner', edge, wire, quietSource, quiet.householdKey);
  await browser.close();
}

async function main() {
  const app = await loadApp();
  const edge = await startEdge(join(work, 'edge-data'));
  console.log(`den-edge on ${edge.origin}`);
  try {
    for (const scenario of [joinsHousehold, joinKilledMidway, joinMakesKid, joinLegacy])
      await scenario(edge, app).catch((error) =>
        check(`${scenario.name} ran to the end`, false, String(error?.stack ?? error)),
      );
  } finally {
    writeFileSync(join(work, 'den-edge.log'), edge.log.join('\n'));
    writeFileSync(join(work, 'browser.log'), browserLog.join('\n'));
    await edge.stop();
    await app.close();
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
