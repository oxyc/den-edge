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
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as listen } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { FILM_BASE, SERIES_BASE, localLibraryRows } from './rehearse-local-library.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const BINARY = process.env.DEN_EDGE_BIN ?? join(ROOT, 'target/debug/den-edge');
const DIST = process.env.REHEARSE_DIST ?? join(WEB, 'dist');
const KEEP = process.env.REHEARSE_KEEP === '1';
const HEADED = process.argv.includes('--headed');
// `--only=<scenario>` runs one scenario (a function name below) instead of all of them.
const ONLY = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
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
  // Documents as the page reads them (den-core's `title_state`, `episode_state_v4`), for the accounting.
  const { projectDocument, projectEpisode } = await server.ssrLoadModule('/src/lib/libraryV4.ts');
  return {
    wire: { ...(await server.ssrLoadModule('/src/lib/wire.ts')), projectDocument, projectEpisode },
    close: () => server.close(),
  };
}

/**
 * The app as den-edge serves it, with `rehearse-seed/` beside it: the app's own code to write a library kept only in
 * the browser (`scripts/rehearse-seed.ts`), and a blank page to run it from before the app has ever loaded.
 */
async function seedingWeb() {
  const web = join(work, 'web');
  cpSync(DIST, web, { recursive: true });
  const { build } = await import('vite');
  await build({
    root: WEB,
    base: '/rehearse-seed/',
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: join(web, 'rehearse-seed'),
      emptyOutDir: true,
      rolldownOptions: { input: join(WEB, 'scripts/rehearse-seed.html') },
    },
  });
  return web;
}

// --- den-edge ---
const freePort = () =>
  new Promise((done) => {
    const probe = listen().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

/**
 * den-edge on its own data. `port` keeps the origin of an earlier run, so a browser finds what it kept there; `web` is
 * the app it serves.
 */
async function startEdge(dataDir, newLibraries = 'visitors', { port: given, web = DIST } = {}) {
  const port = given ?? (await freePort());
  const log = [];
  const child = spawn(BINARY, [], {
    env: {
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_REQUESTS: '1',
      WEB_DIR: web,
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
    port,
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

/** The TMDB answer for `url`: a film or a two-season series of ten episodes each, named by its id. */
function fixture(url) {
  const path = new URL(url).pathname;
  const [, type, id, , season] = path.match(/\/tmdb\/3\/(movie|tv)\/(\d+)(\/season\/(\d+))?/) ?? [];
  if (type === 'tv' && season)
    return {
      id: Number(season),
      season_number: Number(season),
      episodes: Array.from({ length: 10 }, (_, i) => ({
        id: Number(id) * 100 + Number(season) * 10 + i,
        season_number: Number(season),
        episode_number: i + 1,
        name: `Episode ${i + 1}`,
        air_date: '2020-01-01',
        runtime: 45,
      })),
    };
  if (type === 'tv')
    return {
      ...movie,
      id: Number(id),
      name: `Series ${id}`,
      first_air_date: '2020-01-01',
      number_of_seasons: 2,
      seasons: [1, 2].map((n) => ({ season_number: n, episode_count: 10, air_date: '2020-01-01' })),
      last_episode_to_air: { season_number: 2, episode_number: 10, air_date: '2020-03-01' },
    };
  if (type === 'movie') return { ...movie, id: Number(id), title: `Movie ${id}` };
  return movie;
}

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
  // Title data is the fixture's, named by the id asked for; den-edge holds no TMDB key here. Library requests are not
  // routed.
  await ctx.route('**/tmdb/3/**', (route) =>
    route.fulfill({ json: fixture(route.request().url()) }),
  );
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
  // `title` null: what the Owner library holds is the caller's to check.
  if (title !== null)
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

// Each on its own den-edge, after the first visit's run.
const SCENARIOS = [
  killedHalfway,
  kidFirst,
  membersSendNothing,
  existingLibraryMoves,
  moveKilledMidway,
  moveThrottled,
  browsedOnlyStaysPut,
];

async function main() {
  const { wire, close } = await loadWire();
  if (ONLY) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === ONLY);
    if (!scenario) fail(`no scenario ${ONLY}`);
    try {
      await scenario(wire).catch((error) =>
        check(`${scenario.name} ran to the end`, false, String(error?.stack ?? error)),
      );
    } finally {
      writeFileSync(join(work, 'browser.log'), browserLog.join('\n'));
      await close();
    }
    return;
  }
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
    check(
      'the plan records the verified move, and the library kept here waits for the next load',
      !!(await plan(page))?.verified && !!(await localKey(page)),
    );
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
    check('the reload re-checks den-edge and retires the library kept here', await retired(page));
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
    // This rehearsal runs no atlas, so the title has no age: the Kid's policy hides unrated titles, and the page
    // withholds it, Owner's watchlist and all. 12-and-under is checked in the switcher below.
    check(
      'the Kid is under its own policy: an unrated title is withheld, the Owner’s watchlist with it',
      await page
        .getByText('This title isn’t available on this profile.')
        .waitFor({ timeout: 30_000 })
        .then(
          async () =>
            (await page.getByRole('button', { name: 'Watchlist', exact: true }).count()) === 0,
          () => false,
        ),
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

    for (const scenario of SCENARIOS)
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

// --- a library kept in the browser before households (den#295 track C) ---

let seeding;
/** The app with its seeding page beside it, built once per run. */
const seedingOnce = () => (seeding ??= seedingWeb());

/**
 * A browser that used Den before households: `rows` kept only here, written by the app's own code on a page of den-edge's
 * origin before the app has ever loaded there, and no household plan. The key of the library kept here.
 */
async function seedBrowser(page, edge, rows, options = {}) {
  await page.goto(`${edge.origin}/rehearse-seed/scripts/rehearse-seed.html`);
  await page.waitForFunction(() => 'denSeed' in globalThis);
  return page.evaluate(({ rows, options }) => globalThis.denSeed(rows, options), {
    rows,
    options,
  });
}

const localKey = (page) => page.evaluate(() => localStorage.getItem('den.localLibrary'));

/**
 * Wait until the browser points at a household and the move into it was verified (the plan says so, or is settled);
 * the household key or null. The library kept here stays until the next load's re-check.
 */
async function movedHousehold(page, limitMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const [household, kept] = await Promise.all([pointer(page), plan(page)]).catch(() => [
      null,
      undefined,
    ]);
    if (household && kept !== undefined && (kept === null || kept.verified)) return household;
    await sleep(500);
  }
  return null;
}

/** Wait until the library kept here is gone and the plan settled (the re-check passed), or give up. */
async function retired(page, limitMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const [local, kept] = await Promise.all([localKey(page), plan(page)]).catch(() => [
      'unknown',
      'unknown',
    ]);
    if (local === null && kept === null) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Every row kept here against what den-edge holds, decrypted: a title by what the page shows of it (`title_state`), an
 * episode by its progress (`episode_state_v4`), a setting by its value, in the household or the Owner library. Which
 * library each setting landed in is returned too.
 */
function account(wire, seeded, household, owner) {
  const titles = new Map();
  const titleDocs = new Map();
  const seasons = new Map();
  for (const row of owner.rows) {
    if (row.kind === 'title') {
      const projected = wire.projectDocument(row)[0];
      titles.set(`${row.title.type}:${row.title.id}`, projected);
      titleDocs.set(`${row.title.type}:${row.title.id}`, row);
    } else if (row.kind === 'season') seasons.set(`${row.title.id}:${row.season}`, row);
  }
  const settings = (library) =>
    new Map(library.rows.filter((row) => row.kind === 'set').map((row) => [row.name, row.values]));
  const inHousehold = settings(household);
  const inOwner = settings(owner);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const missing = [];
  const placed = {};
  let accounted = 0;
  for (const row of seeded) {
    if (row.kind === 'rec') {
      const held = titles.get(`${row.title.type}:${row.title.id}`);
      const ok =
        held &&
        ['status', 'reaction', 'deleted', 'dismissed'].every((field) =>
          same(held[field].value, row[field].value),
        ) &&
        Math.abs(held.resume.value - row.resume.value) < 1e-9;
      if (ok) accounted += 1;
      else
        missing.push(`${row.title.type}:${row.title.id} ${JSON.stringify(held?.status ?? null)}`);
    } else if (row.kind === 'ep') {
      const season = seasons.get(`${row.title.id}:${row.season}`);
      const held =
        season &&
        wire.projectEpisode(
          titleDocs.get(`tv:${row.title.id}`),
          season,
          row.title,
          row.season,
          row.episode,
        );
      if (held && Math.abs(held.progress.value - row.progress.value) < 1e-9) accounted += 1;
      else missing.push(`tv:${row.title.id} S${row.season}E${row.episode}`);
    } else if (row.kind === 'set') {
      let all = true;
      for (const [key, value] of Object.entries(row.values)) {
        const where = same(inOwner.get(row.name)?.[key]?.value, value.value)
          ? 'owner'
          : same(inHousehold.get(row.name)?.[key]?.value, value.value)
            ? 'household'
            : null;
        placed[`${row.name}.${key}`] = where;
        if (!where) all = false;
      }
      if (all) accounted += 1;
      else missing.push(`set:${row.name}`);
    }
  }
  return { accounted, missing, placed };
}

/** What the title's page shows, once the library behind it has drawn it (up to 20 s for `wanted`). */
async function titleShows(page, edge, type, id, wanted) {
  await page.goto(`${edge.origin}/${type}/${id}`);
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 60_000 });
  let shown;
  for (let i = 0; i < 40; i += 1) {
    shown = {
      watchlist: await page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed', { timeout: 1000 })
        .catch(() => null),
      continuing:
        (await page.getByRole('button', { name: /Continue Watching|Play Next/ }).count()) > 0,
    };
    if (wanted(shown)) return { ok: true, shown };
    await sleep(500);
  }
  return { ok: false, shown };
}

/** The watchlist and Continue Watching, as the page shows a few of the titles kept here. */
async function checkTitlesShown(label, page, edge) {
  for (const [type, id, what, wanted] of [
    ['movie', FILM_BASE, 'a film on the watchlist', (s) => s.watchlist === 'true'],
    ['movie', FILM_BASE + 6, 'a watched film, off the watchlist', (s) => s.watchlist === 'false'],
    ['movie', FILM_BASE + 19, 'a half-watched film, to continue', (s) => s.continuing],
    ['tv', SERIES_BASE, 'a series under way, to continue', (s) => s.continuing],
  ]) {
    const { ok, shown } = await titleShows(page, edge, type, id, wanted);
    check(`${label}: ${what} shows as kept`, ok, JSON.stringify(shown));
  }
}

/** The household this browser moved into, as den-edge holds it, checked against every row kept here. */
async function checkMoved(label, edge, wire, householdKey, seeded) {
  const household = await householdWithKid(edge, wire, householdKey);
  const ownerProfile = household?.directory?.owner;
  const ownerKey = household?.directory?.profiles?.[ownerProfile]?.library?.value?.key;
  await checkHousehold(
    label,
    edge,
    wire,
    {
      householdKey,
      ownerKey,
      ownerProfile,
      attempt: household?.directory?.migration?.attempt,
    },
    { title: null },
  );
  const owner = await readLibrary(edge, wire, ownerKey);
  const { accounted, missing, placed } = account(wire, seeded, household, owner);
  check(
    `${label}: every one of the ${seeded.length} rows kept here is on den-edge, decrypted and compared`,
    missing.length === 0,
    `${accounted}/${seeded.length} accounted for${missing.length ? `; missing ${missing.slice(0, 6).join(', ')}` : ''}`,
  );
  // As profiles-v1 §6 partitions them: what a person sees is theirs, the region and API keys the household's.
  const profileKeys = [
    'prefs.den.hideAnime',
    'prefs.den.preferredSubtitleLanguage',
    'prefs.den.preferredAudioLanguage',
    'prefs.den.autoSkipSegments',
    'prefs.den.minReleaseYear',
  ];
  const householdKeys = ['prefs.den.watchRegion', 'keys.omdb', 'devices.cccccccccccccccc'];
  check(
    `${label}: profile preferences are the Owner's, household ones the household's`,
    profileKeys.every((key) => placed[key] === 'owner') &&
      householdKeys.every((key) => placed[key] === 'household'),
    JSON.stringify(placed),
  );
  const libraries = readdirSync(join(edge.dataDir, 'lib')).filter((name) => name.endsWith('.redb'));
  check(
    `${label}: one household on den-edge, three libraries in all`,
    libraries.length === 3,
    `${libraries.length}`,
  );
}

// 8. A browser that kept a library here before households: under `members` nothing happens; once den-edge starts
// households for browsers, the next load moves every row into one and lands on the Owner.
async function existingLibraryMoves(wire) {
  const web = await seedingOnce();
  const seeded = localLibraryRows(Date.now(), { films: 1000, series: 25 });
  const dir = join(work, 'browser-move');
  const members = await startEdge(join(work, 'edge-data-move-members'), 'members', { web });
  let ctx = await launch(dir);
  let page = await firstPage(ctx);
  let key;
  try {
    step(`a browser that kept ${seeded.length} rows before households, under members`);
    key = await seedBrowser(page, members, seeded);
    check('the library kept here was written with the app’s own code', !!key);
    await page.goto(`${members.origin}/`);
    await checkTitlesShown('under members', page, members);
    await quiet(members, 4000);
    const sent = libraryWrites(members);
    check('under members nothing is written to den-edge', sent.length === 0, sent.join(' | '));
    check('no household is pointed at', (await pointer(page)) === null);
    check('the library kept here is still the one', (await localKey(page)) === key);
  } finally {
    await ctx.close();
    writeFileSync(join(work, 'den-edge-move-members.log'), members.log.join('\n'));
    await members.stop();
  }

  const edge = await startEdge(join(work, 'edge-data-move'), 'visitors', {
    web,
    port: members.port,
  });
  try {
    step('the same browser, once den-edge starts households for browsers');
    ctx = await launch(dir);
    page = await firstPage(ctx);
    const opened = Date.now();
    await page.goto(`${edge.origin}/`);
    const householdKey = await movedHousehold(page);
    const movedAt = await page.evaluate(() => Math.round(performance.now()));
    const firstPaint = await page.evaluate(
      () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    );
    check(
      'the load moved the library kept here into a household of its own',
      !!householdKey,
      `${Math.round((Date.now() - opened) / 1000)} s after the load`,
    );
    check(
      'the page painted before the move was over',
      firstPaint !== null && firstPaint < movedAt,
      `first paint ${Math.round(firstPaint ?? -1)} ms, moved by ${movedAt} ms`,
    );
    if (!householdKey) return;
    const verifiedPlan = await plan(page);
    check(
      'the plan records the verified move, with the rows each library held',
      !!verifiedPlan?.verified,
      JSON.stringify(verifiedPlan?.verified ?? null),
    );
    check(
      'after the first load the library kept here still exists',
      (await localKey(page)) === key,
    );
    // Every later load re-checks. Those below see a plan that says den-edge held far more rows than it does: the
    // re-check fails, the library kept here stays, and the page says why.
    await page.evaluate(
      (value) => localStorage.setItem('den.household.plan', value),
      JSON.stringify({
        ...verifiedPlan,
        verified: { ...verifiedPlan?.verified, owner: 1_000_000 },
      }),
    );
    const logged = browserLog.length;
    await checkMoved('after the move', edge, wire, householdKey, seeded);
    await page.goto(`${edge.origin}/`);
    const trigger = page.locator('button.profile-trigger').first();
    await trigger.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    check(
      'the page is the Owner',
      ((await trigger.getAttribute('aria-label').catch(() => '')) ?? '').includes('current Owner'),
    );
    await checkTitlesShown('as the Owner', page, edge);
    check('no Owner PIN gate', (await page.locator('#owner-gate-pin').count()) === 0);
    const why = browserLog.slice(logged).find((line) => line.includes('stays for now'));
    const keptAfter = await localKey(page);
    const planAfter = await plan(page);
    check(
      'a failed re-check keeps the library kept here, and logs why',
      keptAfter === key && !!planAfter?.verified && !!why,
      why ??
        `nothing logged; library kept here ${keptAfter === key}, plan ${JSON.stringify(planAfter?.verified ?? null)}`,
    );
    // The plan as the move left it, for the next load.
    await page.evaluate(
      (value) => localStorage.setItem('den.household.plan', value),
      JSON.stringify(verifiedPlan),
    );
    await ctx.close();

    // The next load re-checks, passes, and retires the library kept here; it moves and writes nothing.
    ctx = await launch(dir);
    page = await firstPage(ctx);
    const mark = edge.log.length;
    await page.goto(`${edge.origin}/`);
    check('after the re-check passes the library kept here is gone', await retired(page));
    await quiet(edge, 4000);
    const libraries = readdirSync(join(edge.dataDir, 'lib')).filter((name) =>
      name.endsWith('.redb'),
    );
    const writes = libraryWrites(edge, mark).length;
    check(
      'that load opens the same household, starts no other and writes nothing',
      (await pointer(page)) === householdKey && libraries.length === 3 && writes === 0,
      `${libraries.length} libraries; ${writes} writes`,
    );
    await checkTitlesShown('after the re-check', page, edge);
  } finally {
    await ctx.close();
    writeFileSync(join(work, 'den-edge-move.log'), edge.log.join('\n'));
    await edge.stop();
  }
}

// 9. Killed while the rows move into the Owner library (a v3 library this time): the library kept here is still there,
// and the next load finishes the same household, every row in it once.
async function moveKilledMidway(wire) {
  const web = await seedingOnce();
  const seeded = localLibraryRows(Date.now(), { films: 400, series: 10 });
  const edge = await startEdge(join(work, 'edge-data-move-crash'), 'visitors', { web });
  const dir = join(work, 'browser-move-crash');
  let ctx = await launch(dir);
  try {
    step('killed while the library kept here moves into its household');
    let page = await firstPage(ctx);
    const key = await seedBrowser(page, edge, seeded, { v3: true });
    // The Owner library's first write carries the household's member proof; the fifth batch after it is the Owner's
    // part of the move, some of its titles there already.
    let ownerStarted = false;
    let after = 0;
    let killed;
    const killing = new Promise((done) => (killed = done));
    await ctx.route('**/lib/*/batch', async (route) => {
      if (route.request().headers()['x-den-library-member']) ownerStarted = true;
      else if (ownerStarted && ++after === 5) {
        killed();
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${edge.origin}/`);
    const cut = await Promise.race([killing.then(() => true), sleep(60_000).then(() => false)]);
    const keptThen = await localKey(page).catch(() => null);
    const cutPlan = await plan(page).catch(() => null);
    await ctx.close();
    const partial = cutPlan
      ? (await readLibrary(edge, wire, cutPlan.ownerKey)).rows.filter((row) => row.kind === 'title')
          .length
      : -1;
    const titles = seeded.filter((row) => row.kind === 'rec').length;
    check(
      'the run was cut off while the rows moved into the Owner library',
      cut && partial > 0 && partial < titles,
      `${partial} of ${titles} titles there`,
    );
    check('the library kept here was still kept when it was', keptThen === key);
    ctx = await launch(dir);
    page = await firstPage(ctx);
    await page.goto(`${edge.origin}/`);
    const householdKey = await movedHousehold(page);
    check('the next load finishes the move', !!householdKey);
    if (householdKey) await checkMoved('after the resumed move', edge, wire, householdKey, seeded);
  } finally {
    await ctx.close();
    writeFileSync(join(work, 'den-edge-move-crash.log'), edge.log.join('\n'));
    await edge.stop();
  }
}

// 10. den-edge asks the move to wait (429 with Retry-After): the page goes on with the library kept here and tries
// again after the wait. The browser kept a plan from before (a #486 browser that kept rows under `members`), so the
// Owner library's id is known here and only its writes are answered 429.
async function moveThrottled(wire) {
  const web = await seedingOnce();
  const seeded = localLibraryRows(Date.now(), { films: 200, series: 5 });
  const edge = await startEdge(join(work, 'edge-data-move-throttled'), 'visitors', { web });
  const ctx = await launch(join(work, 'browser-move-throttled'));
  try {
    step('den-edge asks the move to wait');
    const page = await firstPage(ctx);
    const key = await seedBrowser(page, edge, seeded);
    const kept = {
      version: 1,
      stagingKey: key,
      householdKey: randomBytes(32).toString('base64'),
      attempt: randomBytes(16).toString('hex'),
      ownerProfile: randomBytes(16).toString('hex'),
      ownerKey: randomBytes(32).toString('base64'),
      createdAt: Date.now(),
      started: false,
    };
    await page.evaluate(
      (value) => localStorage.setItem('den.household.plan', value),
      JSON.stringify(kept),
    );
    const ownerId = (await wire.deriveKeys(Buffer.from(kept.ownerKey, 'base64'))).id;
    const answered = [];
    let ownerBatches = 0;
    await ctx.route(`**/lib/${ownerId}/batch`, async (route) => {
      ownerBatches += 1;
      if (ownerBatches === 2 || ownerBatches === 3) {
        answered.push({ status: 429, at: Date.now() });
        return route.fulfill({
          status: 429,
          headers: { 'retry-after': '3' },
          json: { error: 'rate_limited' },
        });
      }
      answered.push({ status: 'sent', at: Date.now() });
      return route.continue();
    });
    await page.goto(`${edge.origin}/`);
    for (let i = 0; i < 120 && !answered.some((a) => a.status === 429); i += 1) await sleep(250);
    check(
      'den-edge asked the move to wait',
      answered.some((a) => a.status === 429),
    );
    check('meanwhile the page goes on with the library kept here', (await localKey(page)) === key);
    const householdKey = await movedHousehold(page);
    check('after the wait the move finishes', householdKey === kept.householdKey);
    const firstRefusal = answered.findIndex((a) => a.status === 429);
    const nextSent = answered.slice(firstRefusal + 1).find((a) => a.status === 'sent');
    check(
      'the next try waited out Retry-After',
      !!nextSent && nextSent.at - answered[firstRefusal].at >= 3000,
      answered.map((a) => `${a.status}@${a.at - answered[0].at}`).join(' '),
    );
    if (householdKey) await checkMoved('after the wait', edge, wire, householdKey, seeded);
  } finally {
    await ctx.close();
    writeFileSync(join(work, 'den-edge-move-throttled.log'), edge.log.join('\n'));
    await edge.stop();
  }
}

// 11. A browser that only looked around before households: its library kept here holds nothing anyone kept, so the
// load sends nothing to den-edge.
async function browsedOnlyStaysPut() {
  const web = await seedingOnce();
  const edge = await startEdge(join(work, 'edge-data-browsed'), 'visitors', { web });
  const ctx = await launch(join(work, 'browser-browsed'));
  try {
    step('a browser that only looked around before households');
    const page = await firstPage(ctx);
    const key = await seedBrowser(
      page,
      edge,
      localLibraryRows(Date.now(), { films: 0, series: 0 }).filter(
        (row) => row.kind === 'set' && row.name === 'devices',
      ),
    );
    await openTitle(page, edge);
    await quiet(edge, 4000);
    const sent = libraryWrites(edge);
    check('the load writes nothing to den-edge', sent.length === 0, sent.join(' | '));
    check('and the library kept here stays', (await localKey(page)) === key);
  } finally {
    await ctx.close();
    writeFileSync(join(work, 'den-edge-browsed.log'), edge.log.join('\n'));
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
