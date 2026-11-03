// The time budgets of `big-library-budgets.spec.mjs` with the library in a SharedWorker, the worker setup an iPhone's
// Safari and a desktop browser run: the page prewarms the SharedWorker before the app module (`main.ts`), and the app
// adopts it (`libraryServiceAdaptiveTransport.ts`). The budgets spec keeps the dedicated Worker its counters can see
// (IndexedDB transactions, wasm compiles, memory); this one budgets what a viewer waits for, Home's first poster and
// each surface's content, and checks that the SharedWorker is what answered. Its den-edge goes through the bridge
// (`shared-worker-bridge.mjs`), against the build `playwright.budgets-shared.config.ts` makes:
// `npm run test:e2e:budgets:shared`.

import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold, WATCHED_SERIES } from './big-library.mjs';
import { sharedWorkerBridge } from './shared-worker-bridge.mjs';

/** As `big-library-budgets.spec.mjs`: milliseconds from navigation start to a surface's content and its shelves. */
const READY_MS = 4_000;
const SHELVES_MS = 4_000;

const SURFACES = [
  { name: 'Home', path: '/', content: ['billboardText', 'continuePoster'], shelves: true },
  { name: 'Series', path: '/series', content: ['rowPoster'], shelves: true },
  { name: 'Watchlist', path: '/watchlist', content: ['billboardText'], shelves: true },
  { name: 'Series detail', path: `/tv/${WATCHED_SERIES}`, content: ['episodes'] },
  { name: 'Kids Home', path: '/', content: ['billboardText', 'rowPoster'], profile: 'Kids' },
];

/** In the page, from navigation start: when each kind of content first drew. */
function markReady() {
  const ready = (window.__ready = {});
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
    if (performance.now() < 60_000) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function switchProfile(context, edge, profile, bridge) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  // Kept beside a failed switch: the page's startup lines and what the SharedWorker asked den-edge meanwhile.
  const lines = [];
  const bridged = bridge.log.length;
  page.on('console', (message) => lines.push(`${Date.now()} ${message.type()} ${message.text()}`));
  page.on('pageerror', (error) => lines.push(`${Date.now()} pageerror ${error.message}`));
  await page.goto(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: /^Switch profile, current / }).click();
  await page.getByRole('button', { name: `Use ${profile}` }).click();
  // A household with no Owner PIN yet is asked for one, twice, before it leaves the Owner. The ask comes once the
  // switch has reached the library, which is not at once: wait for it or for the switch to finish.
  const pin = page.getByRole('textbox', { name: 'New Owner PIN' });
  const switcher = page.getByRole('dialog', { name: 'Who’s watching?' });
  await expect
    .poll(async () => (await pin.isVisible()) || (await switcher.count()) === 0, {
      timeout: 30_000,
    })
    .toBe(true);
  if (await pin.isVisible()) {
    await pin.fill('1234');
    await page.getByRole('textbox', { name: 'Confirm Owner PIN' }).fill('1234');
  }
  try {
    await expect(switcher).toHaveCount(0, { timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: test.info().outputPath(`switch-${profile}.png`) });
    const text = await page.evaluate(() => document.body.innerText);
    const asked = bridge.log.slice(bridged).join('\n');
    writeFileSync(
      test.info().outputPath(`switch-${profile}.txt`),
      `${text}\n\n${lines.join('\n')}\n\nbridge:\n${asked}`,
    );
    throw error;
  }
  await page.close();
}

/** One returning visit: when its content drew, its `shelves ready`, and what answered its library. */
async function visit(context, edge, bridge, surface, { cpu = 1 } = {}) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  // A dedicated library Worker is the fallback this spec is not about.
  let dedicated = 0;
  page.on('worker', (worker) => {
    if (worker.url().includes('libraryServiceWorker')) dedicated++;
  });
  const marks = {};
  page.on('console', (message) => {
    const match = /^den: startup \+(\d+)ms ([^[(][^(]*?)(?: \(.*\))?$/.exec(message.text());
    if (match && marks[match[2]] === undefined) marks[match[2]] = Number(match[1]);
  });
  const bridged = bridge.served.length;
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
  await page.close();
  return {
    contentMs: surface.content.every((name) => ready?.[name] !== undefined)
      ? Math.max(...surface.content.map((name) => ready[name]))
      : Infinity,
    ...(surface.shelves ? { shelvesMs: marks['shelves ready'] ?? Infinity } : {}),
    firstPosterMs: marks['first poster'] ?? null,
    dedicated,
    libraryReads: bridge.served.slice(bridged).filter((path) => path.startsWith('/lib/')).length,
    drawnAt: ready,
  };
}

const ENGINES = [
  ['WebKit iPhone', webkit, devices['iPhone 13'], {}],
  ['Chromium phone, 4× CPU', chromium, devices['Pixel 7'], { cpu: 4 }],
];

for (const [label, type, device, options] of ENGINES) {
  test(`${label}, SharedWorker: a big household's surfaces draw within their budgets`, async () => {
    test.skip(
      type === webkit && !process.env.CI && !existsSync(webkit.executablePath()),
      'needs WebKit: npx playwright install webkit',
    );
    test.setTimeout(300_000);
    const bridge = await sharedWorkerBridge();
    const browser = await type.launch(
      type === chromium ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    );
    try {
      const { defaultBrowserType: _, ...phone } = device;
      const context = await browser.newContext(phone);
      await context.addInitScript(markReady);
      // The household is made, and its assistant projection settled, with dedicated Workers: the helpers that watch
      // that happen (`watchPublishes`, `holdProjectionBuilds`) see only a dedicated Worker. The visits after it are
      // a returning browser's, with the SharedWorker.
      await context.addInitScript(() => {
        if (localStorage.getItem('den.e2e.sharedWorker') !== '1')
          Object.defineProperty(globalThis, 'SharedWorker', {
            value: undefined,
            configurable: true,
          });
      });
      const edge = newEdge({ profiles: true });
      // Every SharedWorker request this context makes is answered by this page's routes.
      const forwarder = await context.newPage();
      await routeBigHousehold(forwarder, edge);
      await bridge.answerFrom(forwarder);
      await bigHousehold(context, edge);
      await forwarder.evaluate(() => localStorage.setItem('den.e2e.sharedWorker', '1'));
      const measured = [];
      for (const surface of SURFACES) {
        if (surface.profile) {
          await switchProfile(context, edge, surface.profile, bridge);
          await visit(context, edge, bridge, surface, options);
        }
        const result = await visit(context, edge, bridge, surface, options);
        measured.push({ surface: surface.name, ...result });
        expect.soft(result.contentMs, `${surface.name}: ms to content`).toBeLessThan(READY_MS);
        if (surface.shelves)
          expect
            .soft(result.shelvesMs, `${surface.name}: ms to shelves ready`)
            .toBeLessThan(SHELVES_MS);
        // Never a budget met by the fallback: the SharedWorker answered, and read den-edge through the bridge.
        expect.soft(result.dedicated, `${surface.name}: dedicated library Workers`).toBe(0);
        expect
          .soft(result.libraryReads, `${surface.name}: library reads through the bridge`)
          .toBeGreaterThan(0);
      }
      console.log(`${label}, SharedWorker\n${measured.map((m) => JSON.stringify(m)).join('\n')}`);
    } finally {
      await browser.close();
      await bridge.close();
    }
  });
}
