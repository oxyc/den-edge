// `npm run rehearse:household`: a browser with no TV gets its own profile household (den#295), end to end. The real
// den-edge binary serves the built web app with profiles on and `NEW_LIBRARIES=visitors`, the mode that advertises
// households for browsers; real Den Web in real Chromium browses, keeps a title, reloads, switches to Kid, chooses Kid
// before keeping anything, and is killed halfway through making its household. Under `members` it must send no
// creation request at all. What den-edge holds is read over HTTP and decrypted with the app's own code after each
// step. Title data is a fixture answered in the browser; every library request goes to den-edge.
//
// Needs `cargo build --locked` (or DEN_EDGE_BIN) and `npm run build` first. REHEARSE_DIST serves another build of the
// web app.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PIN = '1234';

if (!existsSync(BINARY)) fail(`no den-edge binary at ${BINARY}: run cargo build --locked`);
if (!existsSync(join(DIST, 'index.html'))) fail('no built web app: run npm run build in web/');

function fail(message) {
  console.error(`rehearse-household: ${message}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const work = mkdtempSync(join(tmpdir(), 'den-household-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const step = (message) => console.log(`\n== ${message}`);

// --- the app's own wire code, through Vite, to open what den-edge holds ---
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

// --- den-edge ---
const freePort = () =>
  new Promise((done) => {
    const probe = listen().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

async function startEdge(dataDir, newLibraries = 'visitors') {
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
      NEW_LIBRARIES: newLibraries,
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
    dataDir,
    stop: async () => {
      child.kill();
      await exited;
    },
  };
}

/** Library requests that change something on den-edge (any method but GET), from log line `from` on. */
const libraryWrites = (edge, from = 0) =>
  edge.log.slice(from).filter((line) => /^(POST|PUT|DELETE) \/lib\//.test(line));

/** A library as den-edge holds it, opened with the app's code: rows, its directory and its wire minimum. */
async function readLibrary(edge, wire, keyText) {
  const keys = await wire.deriveKeys(Buffer.from(keyText, 'base64'));
  const rows = [];
  let directory = null;
  let since = 0;
  let wireMin = null;
  for (;;) {
    const response = await fetch(`${edge.origin}/lib/${keys.id}/changes?since=${since}`, {
      headers: { 'x-den-library-token': keys.token, 'x-den-wire': '5' },
    });
    if (!response.ok) return { status: response.status, rows, directory, wireMin, id: keys.id };
    wireMin = Number(response.headers.get('x-den-wire-min'));
    const body = await response.json();
    for (const entry of body.entries) {
      since = Math.max(since, entry.seq);
      if (entry.v === null) continue;
      const opened = await wire.openEntry(keys, entry.k, entry.v);
      if (opened.profileDirectory) directory = opened.profileDirectory;
      else if (opened.row) rows.push(opened.row);
    }
    if (!body.more) return { status: 200, rows, directory, wireMin, id: keys.id };
  }
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
  // What the app itself reports as a page failure, so a failed check is explained.
  await ctx.route('**/playback/page-error', (route) => {
    browserLog.push(`[page-error] ${route.request().postData()}`);
    return route.continue();
  });
  // Title data is the fixture's; den-edge holds no TMDB key here. Library requests are not routed.
  await ctx.route('**/tmdb/3/**', (route) => route.fulfill({ json: movie }));
  // A Kid opens a title only with its age known (unrated titles are blocked): this origin's atlas answers that the
  // fixture film is for all ages, and nothing else.
  await ctx.route('**/atlas/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'atlas', version: '0.0.0' } });
    if (path.startsWith('/atlas/index/title/movie/'))
      return route.fulfill({ json: { minimumAge: 0 } });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
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

const plan = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('den.household.plan') ?? 'null'));
const pointer = (page) => page.evaluate(() => localStorage.getItem('den.household'));

/** A first visit offers to link a TV; a person with none chooses to look around. */
async function lookAround(page, edge) {
  await page.goto(`${edge.origin}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click({ timeout: 30_000 });
  await sleep(2000);
}

async function openTitle(page, edge) {
  await page.goto(`${edge.origin}/movie/1002`);
  try {
    await page.getByRole('heading', { name: 'Movie 1002', level: 1 }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const said = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    console.log(`page said: ${said.replace(/\s+/g, ' ').slice(0, 400)}`);
    console.log(browserLog.slice(-15).join('\n'));
    throw error;
  }
}

/** Open the switcher and wait (up to 10 s) for Owner, Kid and Visitor in it. */
async function switcherShowsAll(page) {
  const trigger = page.locator('button.profile-trigger').first();
  await trigger.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  if (!(await page.locator('dialog[open]').count())) await trigger.click().catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    const names = await page
      .locator('dialog[open] .profile-choice strong')
      .allInnerTexts()
      .catch(() => []);
    if (names.length === 3 && ['Owner', 'Kids', 'Visitor'].every((name) => names.includes(name)))
      return true;
    await sleep(250);
  }
  return false;
}

async function closeSwitcher(page) {
  await page
    .locator('dialog[open]')
    .getByRole('button', { name: 'Done' })
    .click({ timeout: 5_000 })
    .catch(() => {});
}

/** Wait until den-edge holds household `key` with a directory naming an Owner and a Kid, or give up. */
async function householdWithKid(edge, wire, key, limitMs = 60_000) {
  const started = Date.now();
  let household;
  while (Date.now() - started < limitMs) {
    household = await readLibrary(edge, wire, key);
    const profiles = Object.values(household.directory?.profiles ?? {});
    if (profiles.some((p) => p.role === 'kid')) return household;
    await sleep(500);
  }
  return household;
}

const watchlisted = (rows) =>
  rows.some(
    (row) =>
      row.kind === 'title' &&
      row.title?.type === 'movie' &&
      row.title?.id === 1002 &&
      row.status?.value === 'watchlist' &&
      !row.deleted?.value,
  );
const activity = (rows) =>
  rows.filter((row) =>
    ['title', 'season', 'delivery', 'rec', 'ep', 'wat', 'snt'].includes(row.kind),
  );

/** What den-edge holds for this browser's household, checked against the shape a committed split stores. */
async function checkHousehold(label, edge, wire, kept, { title = true } = {}) {
  const household = await householdWithKid(edge, wire, kept.householdKey);
  check(
    `${label}: den-edge holds the household at wire minimum 5`,
    household.wireMin === 5,
    `wire_min ${household.wireMin}`,
  );
  const directory = household.directory;
  const profiles = Object.values(directory?.profiles ?? {});
  const owner = directory?.profiles?.[directory.owner];
  const kids = profiles.filter((p) => p.role === 'kid' && !p.deleted.value);
  check(
    `${label}: the directory is the split's shape, with this browser's attempt as its evidence`,
    !!directory &&
      directory.format === 4 &&
      directory.kind === 'profiles' &&
      directory.owner === kept.ownerProfile &&
      directory.migration?.attempt === kept.attempt &&
      directory.migration?.ownerProfile === kept.ownerProfile &&
      directory.migration?.source?.generation === 0 &&
      directory.migration?.backup?.id === 'born',
    JSON.stringify(directory?.migration ?? null),
  );
  check(
    `${label}: one Owner with the planned library key, unrestricted`,
    owner?.role === 'owner' &&
      owner.library.value.key === kept.ownerKey &&
      owner.policy.value.maximumAge === null &&
      owner.policy.value.unknownRatings === 'allow',
  );
  check(
    `${label}: exactly one Kid, 12 and under with unrated titles blocked`,
    kids.length === 1 &&
      kids[0].policy.value.maximumAge === 12 &&
      kids[0].policy.value.unknownRatings === 'block',
    `${kids.length} Kid profiles`,
  );
  const ownerLibrary = await readLibrary(edge, wire, kept.ownerKey);
  check(
    title
      ? `${label}: the Owner library holds the kept title`
      : `${label}: the Owner library exists, with nothing kept yet`,
    ownerLibrary.status === 200 && watchlisted(ownerLibrary.rows) === title,
    `status ${ownerLibrary.status}, rows ${JSON.stringify(ownerLibrary.rows).slice(0, 600)}`,
  );
  check(
    `${label}: the household holds no activity`,
    activity(household.rows).length === 0,
    `${activity(household.rows).length} activity rows`,
  );
  if (kids[0]) {
    const kidLibrary = await readLibrary(edge, wire, kids[0].library.value.key);
    check(
      `${label}: the Kid library exists`,
      kidLibrary.status === 200,
      `status ${kidLibrary.status}`,
    );
  }
  return { household, kids };
}

async function main() {
  const { wire, close } = await loadWire();
  const edge = await startEdge(join(work, 'edge-data'));
  console.log(`den-edge on ${edge.origin}`);
  try {
    // 1. A fresh browser looks around: nothing is written to den-edge.
    step('a fresh browser browses');
    const dir = join(work, 'browser-fresh');
    let ctx = await launch(dir);
    let page = await firstPage(ctx);
    const mark = edge.log.length;
    await lookAround(page, edge);
    await openTitle(page, edge);
    await quiet(edge, 3000);
    const browsing = libraryWrites(edge, mark);
    check('browsing writes nothing to den-edge', browsing.length === 0, browsing.join(' | '));
    check(
      'the switcher shows Owner, Kid and Visitor on the first visit, before anything is kept',
      await switcherShowsAll(page),
    );
    check(
      'and the page is the Owner',
      (
        (await page
          .locator('button.profile-trigger')
          .first()
          .getAttribute('aria-label')
          .catch(() => '')) ?? ''
      ).includes('current Owner'),
    );
    await closeSwitcher(page);
    check('opening the switcher wrote nothing either', libraryWrites(edge, mark).length === 0);

    // 2. The first kept action makes the household.
    step('the first watchlist add');
    const kept = await plan(page);
    check(
      'the browser planned its household before asking den-edge anything',
      !!kept?.householdKey,
    );
    await page.getByRole('button', { name: 'Watchlist', exact: true }).click();
    let committed = null;
    for (let i = 0; i < 60 && !committed; i += 1) {
      committed = await pointer(page).catch(() => null);
      if (!committed) await sleep(500);
    }
    check('the household is made and this browser points at it', committed === kept?.householdKey);
    if (!kept) return;
    await checkHousehold('after the first add', edge, wire, kept);
    check('the plan is settled once the library moved in', (await plan(page)) === null);
    check(
      'this page shows Owner, Kid and Visitor without a reload',
      await switcherShowsAll(page),
      await page
        .locator('dialog[open] .profile-choice strong')
        .allInnerTexts()
        .then(
          (names) => names.join(', '),
          () => '',
        ),
    );
    await closeSwitcher(page);
    await quiet(edge, 2000);
    await ctx.close();

    // 3. Reload: Owner, no PIN gate, and Owner, Kid and Visitor in the switcher.
    step('reload');
    ctx = await launch(dir);
    page = await firstPage(ctx);
    await openTitle(page, edge);
    const trigger = page.locator('button.profile-trigger').first();
    await trigger.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    check('no Owner PIN gate on reload', (await page.locator('#owner-gate-pin').count()) === 0);
    check(
      'lands as the Owner',
      ((await trigger.getAttribute('aria-label').catch(() => '')) ?? '').includes('current Owner'),
    );
    check(
      'the kept title is still on the watchlist',
      (await page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed')
        .catch(() => null)) === 'true',
    );
    const opened = Date.now();
    const shown = await switcherShowsAll(page);
    check(
      'the switcher shows Owner, Kid and Visitor',
      shown,
      `${(await page.locator('dialog[open] .profile-choice strong').allInnerTexts()).join(', ')} after ${Date.now() - opened} ms`,
    );

    // 4. The first switch to Kid sets the Owner PIN, twice, then the Kid's policy applies.
    step('switch to Kid');
    await page.getByRole('button', { name: 'Use Kids' }).click();
    const newPin = page.getByLabel('New Owner PIN');
    check(
      'the first switch to Kid asks for a new Owner PIN',
      await newPin.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      ),
    );
    await newPin.fill(PIN);
    const confirmPin = page.getByLabel('Confirm Owner PIN');
    check(
      'and asks for it again',
      await confirmPin.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      ),
    );
    await confirmPin.fill(PIN);
    await page
      .locator('button.profile-trigger[aria-label*="current Kids"]')
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    check(
      'now the Kid',
      ((await trigger.getAttribute('aria-label').catch(() => '')) ?? '').includes('current Kids'),
    );
    const settings = await readLibrary(edge, wire, kept.householdKey);
    const keysRow = settings.rows.find((row) => row.kind === 'set' && row.name === 'keys');
    check('the Owner PIN is the household’s', !!keysRow?.values?.parentalPIN?.value);
    await page.goto(`${edge.origin}/movie/1002`);
    // The title's age is the stubbed atlas's (all ages); what is checked here is that the Kid is its own profile under
    // its own policy: not the Owner's watchlist, and 12-and-under in the switcher.
    await page.getByRole('heading', { name: 'Movie 1002', level: 1 }).waitFor({ timeout: 30_000 });
    check(
      'the Kid does not see the Owner’s watchlist',
      (await page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed')
        .catch(() => null)) === 'false',
    );
    await page.locator('button.profile-trigger').first().click();
    const kidChoice = await page
      .locator('dialog[open] .profile-choice', { hasText: 'Kids' })
      .innerText()
      .catch(() => '');
    check(
      'the Kid’s policy is 12 and under with unrated titles hidden',
      kidChoice.includes('12 and under · unrated hidden'),
      kidChoice.replace(/\s+/g, ' '),
    );
    await page.getByRole('button', { name: 'Use Owner' }).click();
    check(
      'back to the Owner asks for the PIN',
      await page
        .locator('#owner-pin')
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        ),
    );
    await ctx.close();

    // Each on its own den-edge, and each runs whatever the one before it did.
    for (const scenario of [killedHalfway, kidFirst, membersSendNothing])
      await scenario(wire).catch((error) =>
        check(`${scenario.name} ran to the end`, false, String(error?.stack ?? error)),
      );
  } finally {
    writeFileSync(join(work, 'den-edge.log'), edge.log.join('\n'));
    writeFileSync(join(work, 'browser.log'), browserLog.join('\n'));
    await edge.stop();
    await close();
  }
}

// 5. Killed halfway through making the household; reloaded, it finishes one household. A den-edge of its own: one
// address may start only five libraries a minute, and each household is three.
async function killedHalfway(wire) {
  const edge = await startEdge(join(work, 'edge-data-crash'));
  try {
    step('killed while the household is being made');
    const crashDir = join(work, 'browser-crash');
    let ctx, page;
    ctx = await launch(crashDir);
    let killed;
    const killing = new Promise((done) => (killed = done));
    // The Owner library's first write carries the household's member proof: the household exists by then and has no
    // directory yet. The browser is closed with that request in flight.
    await ctx.route('**/lib/*/batch', async (route) => {
      if (route.request().headers()['x-den-library-member']) {
        killed();
        return route.abort();
      }
      return route.continue();
    });
    page = await firstPage(ctx);
    await lookAround(page, edge);
    await openTitle(page, edge);
    const crashPlan = await plan(page);
    await page.getByRole('button', { name: 'Watchlist', exact: true }).click();
    const cut = await Promise.race([killing.then(() => true), sleep(30_000).then(() => false)]);
    await ctx.close();
    check('the run was cut off after the household started and before its Owner', cut);
    const halfway = await readLibrary(edge, wire, crashPlan.householdKey);
    check(
      'den-edge holds a household with no directory yet',
      halfway.status === 200 && !halfway.directory,
      `status ${halfway.status}`,
    );
    ctx = await launch(crashDir);
    page = await firstPage(ctx);
    const reloaded = Date.now();
    await page.goto(`${edge.origin}/`);
    let resumed = null;
    for (let i = 0; i < 120 && !resumed; i += 1) {
      resumed = await pointer(page).catch(() => null);
      if (!resumed) await sleep(500);
    }
    check(
      'the reload finishes the same household',
      resumed === crashPlan.householdKey,
      `${Math.round((Date.now() - reloaded) / 1000)} s`,
    );
    await checkHousehold('after the resume', edge, wire, crashPlan);
    // This den-edge served only this browser: one household is exactly three libraries (household, Owner, Kid).
    const libraries = readdirSync(join(edge.dataDir, 'lib')).filter((name) =>
      name.endsWith('.redb'),
    );
    check(
      'one household on den-edge: three libraries in all',
      libraries.length === 3,
      `${libraries.length}`,
    );
    await ctx.close();
  } finally {
    writeFileSync(join(work, 'den-edge-crash.log'), edge.log.join('\n'));
    await edge.stop();
  }
}

// 6. Kid chosen before anything is kept: the Owner PIN is set twice, the household is made, and the page is the Kid.
async function kidFirst(wire) {
  const edge = await startEdge(join(work, 'edge-data-kid'));
  try {
    step('Kid chosen before anything is kept');
    const ctx = await launch(join(work, 'browser-kid'));
    const page = await firstPage(ctx);
    await lookAround(page, edge);
    await openTitle(page, edge);
    const kept = await plan(page);
    check('the switcher offers the Kid before the household exists', await switcherShowsAll(page));
    check('nothing was written to den-edge yet', libraryWrites(edge).length === 0);
    await page.getByRole('button', { name: 'Use Kids' }).click();
    await page.getByLabel('New Owner PIN').fill(PIN);
    await page.getByLabel('Confirm Owner PIN').fill(PIN);
    const kid = await page
      .locator('button.profile-trigger[aria-label*="current Kids"]')
      .first()
      .waitFor({ timeout: 60_000 })
      .then(
        () => true,
        () => false,
      );
    check('choosing Kid made the household and opened the Kid', kid);
    check('this browser points at its household', (await pointer(page)) === kept?.householdKey);
    if (kept) {
      await checkHousehold('after choosing Kid', edge, wire, kept, { title: false });
      const household = await readLibrary(edge, wire, kept.householdKey);
      const keysRow = household.rows.find((row) => row.kind === 'set' && row.name === 'keys');
      check('the Owner PIN chosen then is the household’s', !!keysRow?.values?.parentalPIN?.value);
    }
    await page.locator('button.profile-trigger').first().click();
    await page.getByRole('button', { name: 'Use Owner' }).click();
    check(
      'back to the Owner asks for that PIN',
      await page
        .locator('#owner-pin')
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        ),
    );
    await ctx.close();
  } finally {
    writeFileSync(join(work, 'den-edge-kid.log'), edge.log.join('\n'));
    await edge.stop();
  }
}

// 7. A den-edge that does not advertise households for browsers (`members`): a kept action stays in this browser and
// no creation request is sent, and there is no switcher.
async function membersSendNothing() {
  const edge = await startEdge(join(work, 'edge-data-members'), 'members');
  try {
    step('NEW_LIBRARIES=members');
    const ctx = await launch(join(work, 'browser-members'));
    const page = await firstPage(ctx);
    await lookAround(page, edge);
    await openTitle(page, edge);
    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await quiet(edge, 4000);
    const sent = edge.log.filter((line) => /^(POST|PUT|DELETE) \/lib\//.test(line));
    check('a kept action sends no creation request', sent.length === 0, sent.join(' | '));
    check(
      'the title is kept in this browser',
      (await watchlist.getAttribute('aria-pressed')) === 'true',
    );
    check('no switcher is offered', (await page.locator('button.profile-trigger').count()) === 0);
    check('no household is pointed at', (await pointer(page)) === null);
    await ctx.close();
  } finally {
    writeFileSync(join(work, 'den-edge-members.log'), edge.log.join('\n'));
    await edge.stop();
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
