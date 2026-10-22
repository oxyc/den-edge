// A big household's first open in a browser that has never kept it (`big-library.mjs`): what a new phone, a cleared
// browser or a fresh TV profile waits for before Continue Watching. Its rows come from den-edge, a page per round
// trip (`ROUND_TRIP_MS`), on a phone's CPU (Chromium slowed four times). It runs beside the returning-visit budgets
// (`big-library-budgets.spec.mjs`, `npm run test:e2e:budgets`).
//
// Reading the history 64 rows a request made this open 49 round trips one after another: 5.5 s here, most of it
// waiting on the network. The budget is the time to Continue Watching and the number of changes requests.
//
// `HEADED=1` shows the browser, with each round trip slowed by `ROUND_TRIP_MS` (e.g. 600) to watch the progress bar.

import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';

/** One round trip to den-edge from a phone on the internet. */
const ROUND_TRIP_MS = Number(process.env.ROUND_TRIP_MS ?? 80);
/** Milliseconds from navigation to Continue Watching on a first open. 1.5 s here once reads were batched. */
const FIRST_OPEN_MS = 4_000;
/** Changes requests the library Workers may make to read the whole history: about 3,100 rows, 1,000 a request. */
const CHANGES_REQUESTS = 10;

test('a big household opens for the first time within its budget', async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext();
    const edge = newEdge({ profiles: true });
    await bigHousehold(context, edge);

    // Forget every library this browser keeps, but not its keys: the next open reads the history from den-edge.
    const wipe = await context.newPage();
    await routeBigHousehold(wipe, edge);
    await wipe.goto(`${E2E_ORIGIN}/test/seed-library.html`);
    expect(
      await wipe.evaluate(
        () =>
          new Promise((resolve) => {
            const request = indexedDB.deleteDatabase('den-library');
            request.onsuccess = () => resolve('deleted');
            request.onerror = () => resolve(`error ${request.error}`);
            request.onblocked = () => resolve('blocked');
          }),
      ),
    ).toBe('deleted');
    await wipe.close();

    edge.changesLatencyMs = ROUND_TRIP_MS;
    const page = await context.newPage();
    await routeBigHousehold(page, edge);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: process.env.HEADED ? 1 : 4 });
    // Where the time went, printed with the result: each changes page and the page's startup milestones.
    const started = Date.now();
    const log = [];
    const note = (what) => log.push(`+${Date.now() - started}ms ${what}`);
    let reading = true;
    let changes = 0;
    page.on('console', (message) => /^den: startup/.test(message.text()) && note(message.text()));
    page.on('request', (request) => {
      if (reading && /\/lib\/[^/]+\/changes\?/.test(request.url())) {
        changes++;
        note(`changes ${new URL(request.url()).search}`);
      }
    });

    await page.goto(`${E2E_ORIGIN}/`);
    await expect(page.locator('main section[aria-label="Continue Watching"]')).toBeVisible({
      timeout: 60_000,
    });
    reading = false;
    const ms = Date.now() - started;
    note('continue watching visible');
    console.log(log.join('\n'));
    // A watched run is slowed on purpose: it is for seeing the wait, not budgeting it.
    if (process.env.HEADED) {
      await page.waitForTimeout(20_000);
      return;
    }
    expect.soft(ms, 'ms to Continue Watching on a first open').toBeLessThan(FIRST_OPEN_MS);
    expect
      .soft(changes, 'changes requests to read the history')
      .toBeLessThanOrEqual(CHANGES_REQUESTS);
  } finally {
    await browser.close();
  }
});
