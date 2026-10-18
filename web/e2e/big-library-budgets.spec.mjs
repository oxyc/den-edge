// Time-to-content budgets on a household the size of a long-lived one (`big-library.mjs`), as a phone opens it again:
// WebKit at an iPhone's size, and Chromium at a phone's size with its page CPU slowed four times. Each surface is a
// returning visit, so what is measured is a household's every day rather than its first sync.
//
// Two budgets per surface. Time to its content (the billboard's description, a personal row's first poster, the
// episode list, Settings' heading), generous enough for CI. And the IndexedDB transactions its library Worker makes:
// on a desktop each is nearly free, but on iOS each is a round trip to the storage process, and a load that made
// hundreds of them — one per title the library names — kept the phone's billboard text, rows and episode lists waiting
// for seconds while a desktop drew them at once. That count is what a lab machine can measure of the phone's cost.
//
// A new surface: add an entry to SURFACES with the path, what "ready" means there (a predicate over `window.__ready`,
// which `markReady` fills from the page as it draws), and its budgets.

import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold, WATCHED_SERIES } from './big-library.mjs';

/** Milliseconds from navigation start to a surface's content. Today's iPhone took 5–10 s for most of these. */
const READY_MS = 4_000;
/** IndexedDB transactions a library Worker may make for one returning visit to a surface. */
const WORKER_TRANSACTIONS = 200;
/** The longest a single main-thread task may run on the throttled phone. */
const LONGEST_TASK_MS = 600;

/** `content`: what `markReady` must have seen drawn; the surface's time is the latest of them. */
const SURFACES = [
  { name: 'Home', path: '/', content: ['billboardText', 'continuePoster'] },
  { name: 'Series', path: '/series', content: ['rowPoster'] },
  { name: 'Watchlist', path: '/watchlist', content: ['billboardText'] },
  { name: 'Series detail', path: `/tv/${WATCHED_SERIES}`, content: ['episodes'] },
  { name: 'Settings', path: '/settings', content: ['settings'] },
  // After the switch below: the household's Kid, whose billboard is age-checked title by title.
  { name: 'Kids Home', path: '/', content: ['billboardText'], profile: 'Kids' },
];

/** Use `profile` from Settings' own switcher, the one a phone has. */
async function switchProfile(context, edge, profile) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  await page.goto(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: /^Switch profile, current / }).click();
  await page.getByRole('button', { name: `Use ${profile}` }).click();
  // A household with no Owner PIN yet is asked for one, twice, before it leaves the Owner; four digits submit each.
  const pin = page.getByRole('textbox', { name: 'New Owner PIN' });
  if (await pin.isVisible().catch(() => false)) {
    await pin.fill('1234');
    await page.getByRole('textbox', { name: 'Confirm Owner PIN' }).fill('1234');
  }
  // The switch goes Home, which on a phone draws no switcher: the dialog closing is the switch done.
  await expect(page.getByRole('dialog', { name: 'Who’s watching?' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.close();
}

/** In the page, from navigation start: when each kind of content first drew, and every long main-thread task. */
function markReady() {
  const ready = (window.__ready = { longest: 0 });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        ready.longest = Math.max(ready.longest, Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // WebKit has no long task timing.
  }
  const loaded = (scope) =>
    [...scope.querySelectorAll('.card img')].some((img) => img.complete && img.naturalWidth > 0);
  const first = (name, drawn) => {
    if (ready[name] === undefined && drawn) ready[name] = Math.round(performance.now());
  };
  const frame = () => {
    first(
      'billboardText',
      [...document.querySelectorAll('main .billboard article.slide .overview')].some((p) =>
        p.textContent.trim(),
      ),
    );
    const continued = document.querySelector('main section[aria-label="Continue Watching"]');
    first('continuePoster', continued && loaded(continued));
    first('rowPoster', [...document.querySelectorAll('main section')].some(loaded));
    first('episodes', document.querySelector('.episodes .episode'));
    first('settings', document.querySelector('h1')?.textContent?.trim() === 'Settings');
    if (performance.now() < 60_000) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Count each Worker's IndexedDB transactions from the moment it is seen. */
function countTransactions(page) {
  const workers = [];
  page.on('worker', (worker) =>
    workers.push(
      worker
        .evaluate(() => {
          globalThis.__transactions = 0;
          globalThis.__stores = {};
          const transaction = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args) {
            globalThis.__transactions++;
            const key = `${this.name}/${args[0]}/${args[1] ?? 'readonly'}`;
            globalThis.__stores[key] = (globalThis.__stores[key] ?? 0) + 1;
            return transaction.apply(this, args);
          };
        })
        .then(() => worker)
        .catch(() => null),
    ),
  );
  return async () => {
    let total = 0;
    for (const worker of await Promise.all(workers)) {
      total += (await worker?.evaluate(() => globalThis.__transactions).catch(() => 0)) ?? 0;
      if (process.env.BIG_LIBRARY_DEBUG)
        console.log(
          JSON.stringify(await worker?.evaluate(() => globalThis.__stores).catch(() => null)),
        );
    }
    return total;
  };
}

/** One returning visit to `surface`: the ms its content took, the Worker transactions, the longest task. */
async function visit(context, edge, surface, { cpu = 1 } = {}) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  const transactions = countTransactions(page);
  await page.goto(`${E2E_ORIGIN}${surface.path}`);
  const drawn = (ready) => surface.content.every((name) => ready?.[name] !== undefined);
  // Not an assertion: a surface that never draws is reported as Infinity against its budget below.
  await expect
    .poll(async () => drawn(await page.evaluate(() => window.__ready)), { timeout: 30_000 })
    .toBe(true)
    .catch(() => {});
  const ready = await page.evaluate(() => window.__ready);
  const contentMs = drawn(ready)
    ? Math.max(...surface.content.map((name) => ready[name]))
    : Infinity;
  // Let the Worker finish what the surface set off, then count.
  await page.waitForTimeout(2_000);
  const result = { contentMs, transactions: await transactions(), longest: ready.longest };
  await page.close();
  return result;
}

const ENGINES = [
  ['WebKit iPhone', webkit, devices['iPhone 13'], {}],
  ['Chromium phone, 4× CPU', chromium, devices['Pixel 7'], { cpu: 4 }],
];

for (const [label, type, device, options] of ENGINES) {
  test(`${label}: a big household's surfaces draw within their budgets`, async () => {
    test.skip(
      type === webkit && !process.env.CI && !existsSync(webkit.executablePath()),
      'needs WebKit: npx playwright install webkit',
    );
    test.setTimeout(300_000);
    const browser = await type.launch(
      type === chromium ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    );
    try {
      const { defaultBrowserType: _, ...phone } = device;
      const context = await browser.newContext(phone);
      await context.addInitScript(markReady);
      const edge = newEdge({ profiles: true });
      await bigHousehold(context, edge);
      const measured = [];
      for (const surface of SURFACES) {
        if (surface.profile) {
          await switchProfile(context, edge, surface.profile);
          // Its first visit, to the same returning state as the Owner's surfaces.
          await visit(context, edge, surface, options);
        }
        const result = await visit(context, edge, surface, options);
        measured.push({ surface: surface.name, ...result });
        expect.soft(result.contentMs, `${surface.name}: ms to content`).toBeLessThan(READY_MS);
        expect
          .soft(result.transactions, `${surface.name}: library Worker IndexedDB transactions`)
          .toBeLessThan(WORKER_TRANSACTIONS);
        if (options.cpu)
          expect
            .soft(result.longest, `${surface.name}: longest task ms`)
            .toBeLessThan(LONGEST_TASK_MS);
      }
      console.log(`${label}\n${measured.map((m) => JSON.stringify(m)).join('\n')}`);
    } finally {
      await browser.close();
    }
  });
}
