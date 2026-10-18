// Time-to-content budgets on a household the size of a long-lived one (`big-library.mjs`), as a phone opens it again:
// WebKit at an iPhone's size, and Chromium at a phone's size with its page CPU slowed four times. Each surface is a
// returning visit, so what is measured is a household's every day rather than its first sync. It runs against the
// production build, alone (`playwright.budgets.config.ts`, `npm run test:e2e:budgets`, CI's `e2e budgets` job), never
// in the dev-server shards: there the time was the dev server's five hundred modules and the shards beside it.
//
// Two budgets per surface. Time to its content (the billboard's description, a personal row's first poster, the
// episode list, Settings' heading), generous enough for CI. And the IndexedDB transactions its library Worker makes:
// on a desktop each is nearly free, but on iOS each is a round trip to the storage process, and a load that made
// hundreds of them — one per title the library names — kept the phone's billboard text, rows and episode lists waiting
// for seconds while a desktop drew them at once. That count is what a lab machine can measure of the phone's cost.
//
// A library surface's rows have a budget of their own (`shelves ready`): they are named by the same library Worker
// that publishes the household's assistant projection, which costs a phone's Worker seconds. The visits give that
// publish the phone's cost (`PHONE_PROJECTION_MS`), and a returning visit, with the household as the last one
// published it, must build and upload none.
//
// A new surface: add an entry to SURFACES with the path and the `markReady` fields that mean it has drawn (adding
// one to `markReady` if none fits).

import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import {
  bigHousehold,
  PHONE_PROJECTION_MS,
  routeBigHousehold,
  WATCHED_SERIES,
} from './big-library.mjs';

/** Milliseconds from navigation start to a surface's content. Today's iPhone took 5–10 s for most of these. */
const READY_MS = 4_000;
/** IndexedDB transactions a library Worker may make for one returning visit to a surface. */
const WORKER_TRANSACTIONS = 200;
/** The longest a single main-thread task may run on the throttled phone. */
const LONGEST_TASK_MS = 600;

/** Milliseconds from navigation start to a library surface's `shelves ready` milestone (`startupTiming.ts`). */
const SHELVES_MS = 4_000;

/**
 * `content`: what `markReady` must have seen drawn; the surface's time is the latest of them. `shelves`: the surface
 * names its library rows, and has its `shelves ready` milestone budgeted too.
 */
const SURFACES = [
  { name: 'Home', path: '/', content: ['billboardText', 'continuePoster'], shelves: true },
  { name: 'Series', path: '/series', content: ['rowPoster'], shelves: true },
  { name: 'Watchlist', path: '/watchlist', content: ['billboardText'], shelves: true },
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
  // The household's assistant projection costs the library Worker what it costs a phone's (`PHONE_PROJECTION_MS`).
  await routeBigHousehold(page, edge, { projectionMs: PHONE_PROJECTION_MS });
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  const transactions = countTransactions(page);
  // Where a slow surface's time went, printed with its result: the page's startup milestones (`startupTiming.ts`).
  const marks = {};
  // Assistant projections the library Worker built, from its own line; a browser may report a Worker's console on the
  // page, on the Worker, or both.
  const built = { page: 0, worker: 0 };
  const isBuild = (message) => message.text().startsWith('den: assistant projection built');
  page.on('worker', (worker) =>
    worker.on?.('console', (message) => isBuild(message) && built.worker++),
  );
  page.on('console', (message) => {
    if (isBuild(message)) built.page++;
    const match =
      /^den: startup \+(\d+)ms (app module requested|worker ready|handover|shelves ready|billboard detail|first poster|episodes shown)/.exec(
        message.text(),
      );
    if (match && marks[match[2]] === undefined) marks[match[2]] = Number(match[1]);
  });
  const projectionsBefore = edge.assistant?.projections.length ?? 0;
  await page.goto(`${E2E_ORIGIN}${surface.path}`);
  const drawn = (ready) =>
    surface.content.every((name) => ready?.[name] !== undefined) &&
    (!surface.shelves || marks['shelves ready'] !== undefined);
  // Not an assertion: a surface that never draws is reported as Infinity against its budget below.
  await expect
    .poll(async () => drawn(await page.evaluate(() => window.__ready)), { timeout: 30_000 })
    .toBe(true)
    .catch(() => {});
  const ready = await page.evaluate(() => window.__ready);
  const contentMs = surface.content.every((name) => ready?.[name] !== undefined)
    ? Math.max(...surface.content.map((name) => ready[name]))
    : Infinity;
  const shelvesMs = marks['shelves ready'] ?? Infinity;
  // Let the Worker finish what the surface set off, then count.
  await page.waitForTimeout(2_000);
  const { longest, ...drawnAt } = ready;
  const result = {
    contentMs,
    ...(surface.shelves ? { shelvesMs } : {}),
    transactions: await transactions(),
    projections: (edge.assistant?.projections.length ?? 0) - projectionsBefore,
    builds: Math.max(built.page, built.worker),
    longest,
    drawnAt,
    marks,
  };
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
      // A visit the household has settled after: the day's first page renews the assistant's grants, a change of what
      // its projection is built from, which the next page builds once.
      await visit(context, edge, SURFACES[0], options);
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
        if (surface.shelves)
          expect
            .soft(result.shelvesMs, `${surface.name}: ms to shelves ready`)
            .toBeLessThan(SHELVES_MS);
        expect
          .soft(result.transactions, `${surface.name}: library Worker IndexedDB transactions`)
          .toBeLessThan(WORKER_TRANSACTIONS);
        // The household's lists are as the last visit published them: nothing is built or sent again.
        expect.soft(result.builds, `${surface.name}: assistant projections built`).toBe(0);
        expect.soft(result.projections, `${surface.name}: assistant projections uploaded`).toBe(0);
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
