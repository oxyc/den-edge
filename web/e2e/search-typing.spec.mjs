import { test, expect, chromium, webkit } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

// Typing in the search field is the input's own business: the address, the query every page reads and the
// results grid follow once typing pauses, not once per letter. Rewriting the address per keystroke (Safari
// throttles `replaceState`) and tearing the grid down for a spinner per keystroke made typing lag.

const film = (id) => ({
  id,
  title: `Film ${id}`,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
});
const films = Array.from({ length: 30 }, (_, i) => film(100 + i));
const FIXTURE = 'http://127.0.0.1:5198/test/nav-search.html';
const active = (page) => page.locator('[data-route-page][data-active="true"]');
const input = (page) =>
  page.getByRole('searchbox', { name: 'Search titles, people, moods, languages…' });
const TYPED = 'on genesis c'; // twelve characters, after "Ne"

async function setup(page) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', (r) => r.fulfill({ status: 404 }));
  await page.route('**/atlas/**', (r) => r.fulfill({ json: { labels: [] } }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="500" height="750" fill="#264c68"/></svg>',
    }),
  );
  await routeTmdb(page, (r) => {
    const url = new URL(r.request().url());
    const match = /\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (match)
      return r.fulfill({
        json: { ...film(Number(match[2])), genres: [], credits: { cast: [] } },
      });
    return r.fulfill({ json: { results: films, total_pages: 1 } });
  });
}

/** Type TYPED with no delay over a search already showing results, and measure what the page did. */
async function measure(page, { cdp }) {
  await page.goto(FIXTURE);
  await input(page).click();
  await input(page).fill('Ne');
  await expect(page).toHaveURL(/q=Ne$/);
  await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
  await page.evaluate(() => {
    const w = window;
    w.replaced = 0;
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      w.replaced++;
      return replace(...args);
    };
    w.events = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.events.push({ name: e.name, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: false });
    w.grid = document.querySelector('[data-active="true"] .grid');
    w.gridLost = false;
    new MutationObserver(() => {
      if (!w.grid.isConnected) w.gridLost = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await input(page).focus();
  await page.keyboard.press('End');
  // Chromium says where its main thread went; WebKit has only Event Timing.
  const session = cdp ? await page.context().newCDPSession(page) : null;
  const MAIN = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
  const main = async () => {
    if (!session) return {};
    const { metrics } = await session.send('Performance.getMetrics');
    return Object.fromEntries(
      metrics.filter((m) => MAIN.includes(m.name)).map((m) => [m.name, m.value]),
    );
  };
  if (session) {
    await session.send('Performance.enable');
    // A phone's CPU, roughly: on a laptop the work per letter is too small to read.
    await session.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  }
  const before = await main();
  await page.keyboard.type(TYPED, { delay: 0 });
  const typed = await main();
  // Let the debounce and the search settle, then read the whole run.
  await expect(page).toHaveURL(/q=Neon%20genesis%20c/);
  await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
  await page.waitForTimeout(400);
  const settled = await main();
  const ms = (after, name) => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
  const result = await page.evaluate(() => ({
    replaced: window.replaced,
    slowEvents: window.events.length,
    sumEvent: window.events.reduce((sum, e) => sum + e.duration, 0),
    gridLost: window.gridLost,
    gridKept: window.grid === document.querySelector('[data-active="true"] .grid'),
  }));
  return {
    ...result,
    typingTaskMs: ms(typed, 'TaskDuration'),
    settledTaskMs: ms(settled, 'TaskDuration'),
    scriptMs: ms(settled, 'ScriptDuration'),
    layoutMs: ms(settled, 'LayoutDuration'),
    styleMs: ms(settled, 'RecalcStyleDuration'),
  };
}

const RUNS = 5;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

for (const [name, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
])
  test(`typing a word over results stays in the field (${name})`, async () => {
    let browser;
    try {
      browser = await engine.launch(
        name === 'chromium'
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      );
    } catch (error) {
      test.skip(true, `${name} is not installed here: ${String(error).split('\n')[0]}`);
      return;
    }
    try {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          reducedMotion: 'reduce',
        });
        await setup(page);
        runs.push(await measure(page, { cdp: name === 'chromium' }));
        await page.close();
      }
      // A median over fresh pages: one run of twelve queued keystrokes is too noisy to read alone.
      const summary = Object.fromEntries(
        Object.keys(runs[0]).map((key) => [
          key,
          typeof runs[0][key] === 'number'
            ? median(runs.map((r) => r[key]))
            : runs.map((r) => r[key]),
        ]),
      );
      console.log(`search typing (${name}), median of ${RUNS}:`, JSON.stringify(summary));
      for (const run of runs) {
        expect(run.replaced, 'address rewrites while typing a word').toBeLessThanOrEqual(2);
        expect(run.gridLost, 'the results grid stays on screen while typing').toBe(false);
        expect(run.gridKept).toBe(true);
      }
    } finally {
      await browser.close();
    }
  });
