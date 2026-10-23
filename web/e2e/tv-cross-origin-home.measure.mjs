// What the packaged Samsung app's Home costs against a den-edge on another origin: every request and CORS preflight it
// makes on a first launch (no HTTP or TMDB cache) and on a return launch, and when its shelves and first poster were
// drawn. Measured, not asserted:
//
//   MEASURE_PACKAGES=today:dist-tv-tizen-package-e2e-91,other:dist-tv-tizen-package-e2e-92 \
//     npx playwright test -c playwright.tv-cross-origin.config.ts
//
// Each `label:directory` is a packaged build (`npm run build:tv:tizen` with `DEN_TV_PACKAGED=1`,
// `DEN_TV_API_ORIGIN=https://den-tv-api.example.invalid`), served here from a port of its own and linked to the same
// household. The TV's Chromium has no Playwright route at all (Playwright answers preflights itself once one exists),
// so every request reaches `cross-origin-edge.mjs`, `MEASURE_LATENCY_MS` late, with the page's CPU slowed
// `MEASURE_CPU_RATE` times. The household is the big one (`big-library.mjs`), made on the dev server.
import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';
import { serveCrossOrigin } from './cross-origin-edge.mjs';

const LATENCY_MS = Number(process.env.MEASURE_LATENCY_MS ?? 100);
const CPU_RATE = Number(process.env.MEASURE_CPU_RATE ?? 20);
const REPEATS = Number(process.env.MEASURE_REPEATS ?? 3);
const PACKAGES = (process.env.MEASURE_PACKAGES ?? '')
  .split(',')
  .filter(Boolean)
  .map((pair) => {
    const [label, directory] = pair.split(':');
    return { label, directory };
  });

function kindOf(path) {
  const segment = path.split('?')[0].split('/').filter(Boolean);
  if (segment[0] === 'atlas')
    return `atlas/${segment.includes('index') ? segment.slice(segment.indexOf('index') + 1, -1).join('/') || 'index' : segment.at(-1)}`;
  if (segment[0] === 'tmdb') return `tmdb/${segment[2] ?? ''}`;
  if (segment[0] === 'lib') return `lib/${segment[2] ?? ''}`;
  return segment.slice(0, 2).join('/') || '/';
}

function summarise(log, started) {
  const kinds = {};
  for (const entry of log) {
    const kind = entry.host === 'image.tmdb.org' ? 'image' : kindOf(entry.path);
    const row = (kinds[kind] ??= { requests: 0, preflights: 0, member: 0 });
    if (entry.preflight) row.preflights++;
    else {
      row.requests++;
      if (entry.member) row.member++;
    }
  }
  // When the last TMDB question of the launch was answered: Home naming the household's titles in the background.
  const tmdb = log.filter((entry) => !entry.preflight && entry.path.startsWith('/tmdb/'));
  return {
    requests: log.filter((entry) => !entry.preflight).length,
    preflights: log.filter((entry) => entry.preflight).length,
    tmdbDoneMs: tmdb.length ? Math.max(...tmdb.map((e) => e.at)) + LATENCY_MS - started : 0,
    kinds,
  };
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function servePackage(directory) {
  const port = await freePort();
  const child = spawn('node', ['scripts/tv-static-preview.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, E2E_PORT: String(port), DEN_TV_OUT_DIR: directory },
    stdio: 'inherit',
  });
  const origin = `http://127.0.0.1:${port}`;
  await expect
    .poll(() =>
      fetch(`${origin}/package/index.html`).then(
        (r) => r.status,
        () => 0,
      ),
    )
    .toBe(200);
  return { origin, close: () => child.kill() };
}

const launch = (dir, edge) =>
  chromium.launchPersistentContext(dir, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: edge.args,
    viewport: { width: 1920, height: 1080 },
  });

/** One launch of Home: `cold` first empties the HTTP cache and the TMDB caches the app keeps. */
async function home(tv, edge, cold) {
  const context = await launch(tv.dir, edge);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    if (cold) {
      await page.goto(`${tv.origin}/package/blank`);
      await page.evaluate(() =>
        Promise.all(
          ['den-tmdb', 'den-tmdb-briefs'].map(
            (name) =>
              new Promise((done) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = request.onerror = request.onblocked = () => done();
              }),
          ),
        ),
      );
      await cdp.send('Network.enable');
      await cdp.send('Network.clearBrowserCache');
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    const from = edge.log.length;
    const reports = edge.reports.length;
    const started = Date.now();
    await page.goto(`${tv.origin}/package/index.html#/`);
    await expect.poll(() => edge.reports.length, { timeout: 240_000 }).toBeGreaterThan(reports);
    // What the page asks for after its shelves are drawn is part of the launch too: wait for the network to go quiet.
    let quiet = edge.log.length;
    for (;;) {
      await new Promise((done) => setTimeout(done, 4_000));
      if (edge.log.length === quiet) break;
      quiet = edge.log.length;
    }
    const report = edge.reports.at(-1);
    return {
      shelvesMs: report.shelvesMs,
      posterMs: report.posterMs,
      billboardMs: report.billboardDetailMs,
      ...summarise(edge.log.slice(from), started),
      report,
    };
  } finally {
    await context.close();
  }
}

/** Link a fresh TV running `pkg` to the household through `host`'s Settings, and let it finish its first sync. */
async function link(host, edge, pkg) {
  const served = await servePackage(pkg.directory);
  const tv = { ...pkg, ...served, dir: mkdtempSync(join(tmpdir(), `den-tv-${pkg.label}-`)) };
  await host.goto(`${E2E_ORIGIN}/settings`);
  await host.getByRole('button', { name: /Linked devices/ }).click();
  const devices = host.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Get a code' }).click();
  const code = await devices.locator('.code').textContent();
  const context = await launch(tv.dir, edge);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${tv.origin}/package/index.html`);
    await page.getByLabel('Link code, twelve characters').fill(code);
    await page.getByLabel('This device’s name').fill(`Samsung ${pkg.label}`);
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(devices.getByText(`Allow “Samsung ${pkg.label}”?`)).toBeVisible({
      timeout: 30_000,
    });
    await devices.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Open your Den library' })).toBeHidden();
    await expect(page.locator('main').getByText('Continue Watching').first()).toBeVisible({
      timeout: 180_000,
    });
    await new Promise((done) => setTimeout(done, 10_000));
  } finally {
    await context.close();
  }
  return tv;
}

test('packaged Home across origins', async ({ browser }) => {
  expect(PACKAGES.length, 'MEASURE_PACKAGES names the builds to measure').toBeGreaterThan(0);
  const household = newEdge({ profiles: true });
  const edge = await serveCrossOrigin({ latencyMs: LATENCY_MS });
  await routeBigHousehold(edge.page, household);
  const hostContext = await browser.newContext();
  const tvs = [];
  try {
    await bigHousehold(hostContext, household);
    const host = await hostContext.newPage();
    await routeBigHousehold(host, household);

    const results = Object.fromEntries(PACKAGES.map(({ label }) => [label, []]));
    // A TV linked anew each round: its first launch is a newly linked TV's, which has named nothing yet.
    for (let round = 0; round < REPEATS; round++)
      for (const pkg of PACKAGES) {
        const tv = await link(host, edge, pkg);
        tvs.push(tv);
        const first = await home(tv, edge, true);
        const again = await home(tv, edge, false);
        results[tv.label].push({ first, again });
        for (const [name, launched] of [
          ['first', first],
          ['return', again],
        ])
          console.log(
            `${tv.label} #${round + 1} ${name}: requests ${launched.requests}, preflights ${launched.preflights}, ` +
              `shelves ${launched.shelvesMs} ms, poster ${launched.posterMs} ms, billboard ${launched.billboardMs} ms, ` +
              `tmdb done ${launched.tmdbDoneMs} ms`,
          );
      }
    const out = process.env.MEASURE_OUT ?? join(tmpdir(), 'den-tv-measure.json');
    writeFileSync(
      out,
      JSON.stringify({ latencyMs: LATENCY_MS, cpuRate: CPU_RATE, results }, null, 2),
    );
    console.log(`measurements: ${out}`);
  } finally {
    for (const tv of tvs) tv.close();
    await hostContext.close();
    await edge.close();
  }
});
