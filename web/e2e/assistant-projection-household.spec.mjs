// Every device of a household builds the same assistant projection from the same log, and a build costs a phone's
// library Worker seconds and its build Worker about 61 MB. den-edge says what library state the projection it holds
// was built from, so a device that finds it holding the one it would build builds nothing, and of the devices due to
// build at once, the one that claims the build builds it. Two browsers of the big household, both open, one change:
// one build between them, and one upload. Real time throughout: each page's publish tick and debounce are its own
// (`@soak`).
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, firstPublish, forgetRecords, routeBigHousehold } from './big-library.mjs';

/** A film nobody in the household has touched: putting it on the Watchlist is a change of the projection. */
const FILM = 990_001;
/** Two publish ticks of each page (30 s): any build either would make after the first upload is made by then. */
const AFTER_MS = 70_000;

/**
 * A second browser of the household: everything `from` keeps for this origin (its localStorage and every IndexedDB
 * database), copied into `to` on the seed page, which starts no library.
 */
async function copyBrowser(from, to, edge) {
  const pageOf = async (context) => {
    const page = await context.newPage();
    await routeBigHousehold(page, edge);
    await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
    return page;
  };
  const source = await pageOf(from);
  const kept = await source.evaluate(async () => {
    const done = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const databases = [];
    for (const { name } of await indexedDB.databases()) {
      // TMDB's answers, hundreds of MB here: the second browser asks for its own.
      if (/tmdb/i.test(name)) continue;
      const db = await done(indexedDB.open(name));
      const stores = [];
      for (const storeName of db.objectStoreNames) {
        const store = db.transaction(storeName).objectStore(storeName);
        const keys = await done(store.getAllKeys());
        const values = await done(store.getAll());
        stores.push({
          name: storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map((index) => {
            const { keyPath, unique, multiEntry } = store.index(index);
            return { index, keyPath, unique, multiEntry };
          }),
          // Out-of-line keys go back as they were; in-line ones come with their values.
          records: keys.map((key, i) => [store.keyPath === null ? key : null, values[i]]),
        });
      }
      databases.push({ name, version: db.version, stores });
      db.close();
    }
    return { local: Object.entries(localStorage), databases };
  });
  await source.close();
  const target = await pageOf(to);
  await target.evaluate(async ({ local, databases }) => {
    for (const [key, value] of local) localStorage.setItem(key, value);
    for (const { name, version, stores } of databases) {
      const open = indexedDB.open(name, version);
      open.onupgradeneeded = () => {
        for (const { name: storeName, keyPath, autoIncrement, indexes } of stores) {
          const store = open.result.createObjectStore(storeName, { keyPath, autoIncrement });
          for (const { index, keyPath: path, unique, multiEntry } of indexes)
            store.createIndex(index, path, { unique, multiEntry });
        }
      };
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      for (const { name: storeName, records } of stores) {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        for (const [key, value] of records) {
          if (key === null) store.put(value);
          else store.put(value, key);
        }
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        });
      }
      db.close();
    }
  }, kept);
  await target.close();
}

/** Every projection a library Worker of `context` builds, from its own line, on the page or the Worker. */
function countBuilds(context) {
  const pages = [];
  context.on('page', (page) => {
    const built = { page: 0, worker: 0 };
    pages.push(built);
    const isBuild = (message) => message.text().startsWith('den: assistant projection built');
    page.on('console', (message) => isBuild(message) && built.page++);
    page.on('worker', (worker) =>
      worker.on?.('console', (message) => isBuild(message) && built.worker++),
    );
  });
  return () => pages.reduce((sum, built) => sum + Math.max(built.page, built.worker), 0);
}

test('two browsers of a household open on one change build its projection once between them @soak', async () => {
  test.setTimeout(900_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const edge = newEdge({ profiles: true });
    const laptop = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await bigHousehold(laptop, edge);
    // A second browser of the household, holding what the first holds, that has never published for it.
    const phone = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await copyBrowser(laptop, phone, edge);
    await forgetRecords(phone, edge);
    const laptopBuilds = countBuilds(laptop);
    const phoneBuilds = countBuilds(phone);

    const film = await laptop.newPage();
    await routeBigHousehold(film, edge);
    const home = await phone.newPage();
    await routeBigHousehold(home, edge);
    const uploads = edge.assistant.projections.length;
    // The phone has no record of publishing, and finds den-edge holding the projection of the library it has read.
    expect(await firstPublish(film, `/movie/${FILM}`)).toBe('current');
    expect(await firstPublish(home, '/')).toBe('current');
    expect(laptopBuilds() + phoneBuilds(), 'builds while nothing changed').toBe(0);

    // The last upload as long ago as a change may be sent after (five minutes), so the change goes once it has stood.
    edge.assistant.agedMs = 10 * 60_000;
    const watchlist = film.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => edge.assistant.projections.length, { timeout: 120_000 })
      .toBe(uploads + 1);
    await film.waitForTimeout(AFTER_MS);

    const sent = edge.assistant.projections.slice(uploads);
    expect(sent, 'uploads after the change').toHaveLength(1);
    expect(sent[0].state).toMatch(/^[0-9a-f]{64}$/);
    expect(
      { laptop: laptopBuilds(), phone: phoneBuilds(), total: laptopBuilds() + phoneBuilds() },
      'builds after the change',
    ).toMatchObject({ total: 1 });
  } finally {
    await browser.close();
  }
});
