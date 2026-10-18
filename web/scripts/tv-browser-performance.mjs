#!/usr/bin/env node

// Reproducible browser-bundle comparison. This is deliberately not a TV benchmark: it uses Chromium on the
// workstation, serves only the normal browser bundles, and answers app APIs with the existing guest fixtures.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const runs = Number(process.env.DEN_BROWSER_PERF_RUNS ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error('DEN_BROWSER_PERF_RUNS must be 1..20');
const output = process.env.DEN_BROWSER_PERF_OUTPUT;
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
    if (!extname(path)) return route.continue();
    return route.abort('blockedbyclient');
  });
}

async function measure(page, origin, label) {
  await page.goto(origin);
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
  return {
    label,
    initialNavigation,
    home: { readyMs: home.readyMs, resources: home.resources },
    search: { readyMs: performance.now() - searchStarted, resources: result },
  };
}

const bundles = [
  { label: 'baseline', directory: resolve(root, 'dist-browser-baseline') },
  { label: 'current', directory: resolve(root, 'dist') },
];
const servers = await Promise.all(bundles.map((bundle) => serve(bundle.directory)));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (let run = 0; run < runs; run++) {
    for (const [index, bundle] of bundles.entries()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => {
        const lcp = { value: null };
        try {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            lcp.value = entries.at(-1)?.startTime ?? lcp.value;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          /* Chromium version without LCP is reported as null. */
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
            domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
            load: navigation?.loadEventEnd ?? null,
            resources: resources.length,
            transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
          };
        };
      });
      await fixture(page, servers[index].origin);
      results.push({ run: run + 1, ...(await measure(page, servers[index].origin, bundle.label)) });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
}
const report = {
  generatedAt: new Date().toISOString(),
  runs,
  browser: 'chromium',
  scope: 'loopback production bundles with guest API fixtures; not TV/device performance',
  results,
};
const json = JSON.stringify(report, null, 2);
if (output) await (await import('node:fs/promises')).writeFile(resolve(output), `${json}\n`);
console.log(json);
