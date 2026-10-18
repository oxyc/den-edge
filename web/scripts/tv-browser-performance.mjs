#!/usr/bin/env node

// Reproducible browser-bundle comparison. This is deliberately not a TV benchmark: it uses a workstation browser,
// workstation, serves only the normal browser bundles, and answers app APIs with the existing guest fixtures.
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const runs = Number(process.env.DEN_BROWSER_PERF_RUNS ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error('DEN_BROWSER_PERF_RUNS must be 1..20');
const output = process.env.DEN_BROWSER_PERF_OUTPUT;
const engine = process.env.DEN_BROWSER_PERF_ENGINE ?? 'chromium';
if (!['chromium', 'webkit'].includes(engine))
  throw new Error('DEN_BROWSER_PERF_ENGINE must be chromium or webkit');
const types = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function fingerprint(directory) {
  const files = [
    'index.html',
    ...(await readdir(resolve(directory, 'assets'))).sort().map((name) => `assets/${name}`),
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(resolve(directory, file)));
  return hash.digest('hex');
}

async function serve(directory) {
  const base = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      // The production app is an SPA; serve its document for client-side routes, but never for missing assets.
      let file = resolve(base, relative);
      if (!file.startsWith(base + sep)) throw new Error('outside bundle');
      try {
        await readFile(file);
      } catch {
        if (extname(relative)) throw new Error('missing asset');
        file = resolve(base, 'index.html');
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function fixture(page, origin) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      if (url.origin === 'https://image.tmdb.org')
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
        });
      return route.abort('blockedbyclient');
    }
    const path = url.pathname;
    if (/^\/(?:assets|favicon\.ico)/.test(path)) return route.continue();
    if (path === '/config' || path === '/routes' || path === '/oauth/connections')
      return route.fulfill({ json: {} });
    if (path === '/version') return route.fulfill({ json: { version: 'browser-perf-fixture' } });
    if (path === '/recovery' || path === '/capabilities/profiles')
      return route.fulfill({ status: 404, json: {} });
    if (path === '/atlas/manifest.json' || path === '/reel/manifest.json')
      return route.fulfill({ status: 404, json: {} });
    if (path.startsWith('/atlas/')) return route.fulfill({ status: 404, json: {} });
    if (path === '/tmdb/warm') return route.fulfill({ status: 204 });
    if (path.includes('/tmdb/3/search/')) {
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: Array.from({ length: 18 }, (_, i) => ({
            id: 1002 + i,
            title: `Movie ${1002 + i}`,
            media_type: 'movie',
            release_date: '2026-01-01',
            poster_path: `/poster-${1002 + i}.jpg`,
            backdrop_path: '/backdrop.jpg',
            genre_ids: [18],
            vote_average: 8,
            vote_count: 1_000,
          })),
        },
      });
    }
    if (path.startsWith('/ratings/') || path.startsWith('/warnings/'))
      return route.fulfill({ status: 404, json: {} });
    const movie = path.match(/^\/tmdb\/3\/movie\/(\d+)$/);
    if (movie)
      return route.fulfill({
        json: {
          id: Number(movie[1]),
          title: `Movie ${movie[1]}`,
          release_date: '2026-01-01',
          overview: 'A deterministic detail page for browser performance comparisons.',
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          vote_average: 8,
          vote_count: 1000,
          genres: [{ id: 18, name: 'Drama' }],
          credits: { cast: [], crew: [] },
          recommendations: { results: [] },
          external_ids: {},
        },
      });
    if (path.startsWith('/tmdb/3/'))
      return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    if (!extname(path)) return route.continue();
    return route.abort('blockedbyclient');
  });
}

async function measure(page, origin, label) {
  const entryStarted = performance.now();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Look around instead' }).waitFor();
  const entry = { readyMs: performance.now() - entryStarted };
  const initialNavigation = await page.evaluate(() => globalThis.__denPerfSample?.());
  const homeStarted = performance.now();
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.waitForFunction(() => {
    const active = globalThis.document?.querySelector('[data-route-page][data-active="true"]');
    return Boolean(
      active && active.textContent?.trim() && !active.querySelector('[data-route-loading]'),
    );
  });
  const home = {
    readyMs: performance.now() - homeStarted,
    resources: await page.evaluate(() => globalThis.__denPerfSample?.()),
  };
  const search = page.getByRole('searchbox', { name: 'Search titles, people, moods, languages…' });
  const searchStarted = performance.now();
  await search.fill('Movie');
  await page
    .getByRole('link', { name: /Movie 1002/ })
    .first()
    .waitFor();
  const result = await page.evaluate(() => globalThis.__denPerfSample?.());
  const searchResult = { readyMs: performance.now() - searchStarted, resources: result };
  const detailStarted = performance.now();
  await page
    .getByRole('link', { name: /Movie 1002/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Movie 1002', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Watchlist', exact: true }).waitFor();
  const detail = {
    readyMs: performance.now() - detailStarted,
    resources: await page.evaluate(() => globalThis.__denPerfSample?.()),
  };
  const backStarted = performance.now();
  await page.goBack();
  await search.waitFor();
  await page
    .getByRole('link', { name: /Movie 1002/ })
    .first()
    .waitFor();
  const back = { readyMs: performance.now() - backStarted };
  const settingsStarted = performance.now();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('.settings-load'));
  const settings = {
    readyMs: performance.now() - settingsStarted,
    resources: await page.evaluate(() => globalThis.__denPerfSample?.()),
  };
  // Observe the real idle preload window as well as the initial download. This delay is a measurement phase,
  // not a wait used to make an assertion pass; it catches optional assets fetched after navigation settles.
  await page.waitForTimeout(2500);
  const idle = await page.evaluate(() => globalThis.__denPerfSample?.());
  const warmStarted = performance.now();
  await page.goto(origin);
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.waitForFunction(() => {
    const active = globalThis.document.querySelector('[data-route-page][data-active="true"]');
    return active?.textContent?.trim() && !active.querySelector('[data-route-loading]');
  });
  const warmReturn = { readyMs: performance.now() - warmStarted };
  return {
    label,
    entry,
    initialNavigation,
    home: { readyMs: home.readyMs, resources: home.resources },
    search: searchResult,
    detail,
    back,
    settings,
    idle,
    warmReturn,
  };
}

const bundles = [
  { label: 'baseline', directory: resolve(root, 'dist-browser-baseline') },
  { label: 'current', directory: resolve(root, 'dist') },
];
const fingerprints = Object.fromEntries(
  await Promise.all(
    bundles.map(async ({ label, directory }) => [label, await fingerprint(directory)]),
  ),
);
const servers = await Promise.all(bundles.map((bundle) => serve(bundle.directory)));
let browser;
const results = [];
try {
  browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless: true,
    ...(engine === 'chromium'
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  for (let run = 0; run < runs; run++) {
    // Counterbalance execution order so the current build is not always measured after the control.
    const order = run % 2 ? [1, 0] : [0, 1];
    for (const index of order) {
      const bundle = bundles[index];
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const lcp = { value: null };
        let layoutShiftScore = 0;
        let longTaskMs = 0;
        try {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            lcp.value = entries.at(-1)?.startTime ?? lcp.value;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          /* Chromium version without LCP is reported as null. */
        }
        for (const type of ['layout-shift', 'longtask']) {
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (type === 'layout-shift' && !entry.hadRecentInput)
                  layoutShiftScore += entry.value;
                if (type === 'longtask') longTaskMs += entry.duration;
              }
            }).observe({ type, buffered: true });
          } catch {
            /* Unsupported observations are explicitly labelled below. */
          }
        }
        globalThis.__denPerfSample = (phase) => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource');
          if (
            resources.some((entry) =>
              /\/dist-tv(?:[-/]|$)|\/(?:tizen|webos)(?:[-/]|$)/i.test(entry.name),
            )
          )
            throw new Error('TV asset loaded');
          return {
            phase,
            fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
            lcp: lcp.value,
            // Whole-journey shift sum, not session-window CLS or an INP/Core Web Vitals score.
            layoutShiftScore: PerformanceObserver.supportedEntryTypes.includes('layout-shift')
              ? layoutShiftScore
              : null,
            longTaskMs: PerformanceObserver.supportedEntryTypes.includes('longtask')
              ? longTaskMs
              : null,
            domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
            load: navigation?.loadEventEnd ?? null,
            resources: resources.length,
            assets: resources
              .filter((entry) => /\/assets\//.test(entry.name))
              .map((entry) => new URL(entry.name).pathname),
            transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
          };
        };
      });
      await fixture(page, servers[index].origin);
      results.push({ run: run + 1, ...(await measure(page, servers[index].origin, bundle.label)) });
      if (errors.length) throw new Error(`${bundle.label} page errors: ${errors.join('; ')}`);
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
}
const summary = Object.fromEntries(
  bundles.map(({ label }) => [
    label,
    Object.fromEntries(
      ['entry', 'home', 'search', 'detail', 'back', 'settings', 'warmReturn'].map((phase) => {
        const values = results
          .filter((result) => result.label === label)
          .map((result) => result[phase].readyMs)
          .sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return [
          phase,
          {
            medianMs:
              values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
            minMs: values[0],
            maxMs: values.at(-1),
          },
        ];
      }),
    ),
  ]),
);
const report = {
  generatedAt: new Date().toISOString(),
  runs,
  browser: engine,
  scope: 'loopback production bundles with guest API fixtures; not TV/device performance',
  order: 'alternating baseline/current and current/baseline pairs',
  cache:
    'fresh context per sample; HTTP no-store and routed APIs; warm return retains local app data, not service-worker cache',
  idleObservationMs: 2500,
  fingerprints,
  summary,
  results,
};
const json = JSON.stringify(report, null, 2);
if (output) await writeFile(resolve(output), `${json}\n`);
console.log(json);
