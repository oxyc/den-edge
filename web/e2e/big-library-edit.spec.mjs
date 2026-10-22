// What one edit costs a big household (`big-library.mjs`) on a phone's CPU (Chromium slowed four times): a title
// added to the watchlist from Home and taken off again, on a returning visit, and the visit after them. It runs beside
// the returning-visit budgets (`big-library-budgets.spec.mjs`, `npm run test:e2e:budgets`).
//
// The library this browser keeps is kept a document at a time (`libraryFactStore.ts`); each edit kept the whole of it
// again besides, as one value: 2.26 MB for one watchlist add, and the visit after rewrote 6.3 MB of it. What the edit
// itself changes is a document of a few hundred bytes, and its facts. The budget is what the library Workers write
// of the library for an edit and for the visit after it, and how soon the edit shows.

import { test, expect, chromium, devices } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import {
  WATCHED_SERIES,
  bigHousehold,
  routeBigHousehold,
  settleProjection,
} from './big-library.mjs';

/** KB of the library kept here that an edit, or the visit after one, may write. About 1.6 KB for one add. */
const LIBRARY_KB = 64;
/** Milliseconds from the menu item's click to the page saying the edit is done. About 250 ms here. */
const SHOWN_MS = 1_000;
/** Where the library is kept in this browser: its documents and facts, the saved views, and older whole copies. */
const LIBRARY = new Set(['library-facts.v1', 'finished-views.v1', 'log.v4', 'log.v1']);

/** Each Worker's IndexedDB writes from the moment it is seen, in bytes, by the name the value is kept under. */
function countWorkerWrites(page) {
  const workers = [];
  page.on('worker', (worker) =>
    workers.push(
      worker
        .evaluate(() => {
          globalThis.__written = {};
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (value, key) {
            // `<library id>:<name>:…`
            const name = String(key)
              .replace(/^[^:]*:/, '')
              .split(':')[0];
            globalThis.__written[name] =
              (globalThis.__written[name] ?? 0) + (value?.byteLength ?? 0);
            return put.call(this, value, key);
          };
        })
        .then(() => worker)
        .catch(() => null),
    ),
  );
  /** KB written of the library since the last call, and every name's bytes since the page opened. */
  let before = 0;
  return async () => {
    const written = {};
    for (const worker of await Promise.all(workers)) {
      const held = await worker?.evaluate(() => globalThis.__written).catch(() => null);
      for (const [name, bytes] of Object.entries(held ?? {}))
        written[name] = (written[name] ?? 0) + bytes;
    }
    const library = Object.entries(written)
      .filter(([name]) => LIBRARY.has(name))
      .reduce((sum, [, bytes]) => sum + bytes, 0);
    const kb = Math.round(((library - before) / 1024) * 10) / 10;
    before = library;
    return { kb, written };
  };
}

/** A returning visit to Home on the throttled phone, its Worker writes counted. */
async function home(context, edge) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const written = countWorkerWrites(page);
  await page.goto(`${E2E_ORIGIN}/`);
  const row = page.getByRole('region', { name: 'New Releases', exact: true });
  await expect(row.getByRole('link', { name: 'Film 300000' }).first()).toBeVisible({
    timeout: 30_000,
  });
  // Let the Workers finish what the visit set off.
  await page.waitForTimeout(3_000);
  return { page, row, written };
}

/** `action` from Film 300000's menu: the ms until the page says `done`, and the KB of the library it wrote. */
async function edit({ page, row, written }, action, done) {
  await written();
  await row.getByRole('link', { name: 'Film 300000' }).first().hover();
  await row.getByRole('button', { name: 'Actions for Film 300000' }).first().click();
  const item = page
    .getByRole('menu', { name: 'Actions for Film 300000' })
    .getByRole('menuitemcheckbox', { name: action });
  await expect(item).toBeVisible();
  const started = Date.now();
  await item.click();
  await expect(page.getByText(done, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  const shownMs = Date.now() - started;
  await page.waitForTimeout(3_000);
  return { action, shownMs, ...(await written()) };
}

/**
 * Season 3 episode 1 of the watched series (seasons 1–2 are watched) marked watched from its card's menu: the ms until
 * the season list counts it, and the KB of the library it wrote.
 */
async function markEpisode({ page, written }) {
  await page.goto(`${E2E_ORIGIN}/tv/${WATCHED_SERIES}`);
  const episodes = page.getByRole('region', { name: 'Episodes' });
  await expect(episodes.getByText('20 of 40 watched')).toBeVisible({ timeout: 30_000 });
  await episodes.getByRole('combobox', { name: 'Season' }).selectOption({ index: 2 });
  const season = episodes.getByRole('tabpanel', { name: 'Season 3' });
  await expect(season).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await written();
  await season.getByRole('link', { name: /^Play episode 1:/ }).hover({ timeout: 10_000 });
  await season
    .getByRole('button', { name: 'Options for episode 1', exact: true })
    .click({ timeout: 10_000 });
  const item = page.getByRole('menuitem', { name: 'Mark watched' });
  await expect(item).toBeVisible();
  const started = Date.now();
  await item.click();
  await expect(episodes.getByText('21 of 40 watched')).toBeVisible({ timeout: 30_000 });
  const shownMs = Date.now() - started;
  await page.waitForTimeout(3_000);
  return { action: 'Mark episode watched', shownMs, ...(await written()) };
}

test('an edit to a big household writes only what it changed', async () => {
  test.setTimeout(600_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { defaultBrowserType: _, ...phone } = devices['Pixel 7'];
    const context = await browser.newContext(phone);
    const edge = newEdge({ profiles: true });
    await bigHousehold(context, edge);
    await settleProjection(context, edge);

    const visit = await home(context, edge);
    const edits = [
      await edit(visit, 'Add to watchlist', 'to your watchlist'),
      await edit(visit, 'Remove from watchlist', 'from your watchlist'),
      await edit(visit, 'Mark as seen', 'as seen'),
      await markEpisode(visit),
    ];
    await visit.page.close();
    const after = await home(context, edge);
    const next = { visit: 'after the edits', ...(await after.written()) };
    await after.page.close();
    console.log([...edits, next].map((measured) => JSON.stringify(measured)).join('\n'));

    for (const { action, shownMs, kb, written } of edits) {
      expect.soft(shownMs, `${action}: ms until it shows`).toBeLessThan(SHOWN_MS);
      expect
        .soft(kb, `${action}: KB written of the library ${JSON.stringify(written)}`)
        .toBeLessThan(LIBRARY_KB);
    }
    expect
      .soft(next.kb, `the visit after: KB written of the library ${JSON.stringify(next.written)}`)
      .toBeLessThan(LIBRARY_KB);
  } finally {
    await browser.close();
  }
});
