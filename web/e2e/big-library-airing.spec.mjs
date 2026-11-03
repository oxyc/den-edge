// What Home's release-date sweep costs a household the size of a long-lived one (`big-library.mjs`), over a slow
// network: how many requests reach atlas, how long until the last is answered, and how many den-edge's relay refuses
// (`MEMBER_PER_WINDOW`, 600 a minute per member). And that every followed series with a date shows it on Coming up.
// WebKit at an iPhone's size, and Chromium at a phone's with its page CPU slowed six times; every
// answer `AIRING_LATENCY_MS` (150 ms) late. It runs against the production build, alone, beside the budgets
// (`playwright.budgets.config.ts`).
//
// Atlas answers the household's series in the split measured on den's live atlas on 2026-11-03 (794 followed series:
// 511 ended with nothing dated ahead, 161 TVmaze has no show for, 110 running or undecided with nothing ahead, 12
// dated), each with the freshness atlas gives it (`tvmaze::max_age`), through both its routes: the single series' GET and
// the batched `POST /airing`.

import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import {
  BIG_LIBRARY_SCALE,
  PHONE_PROJECTION_MS,
  bigHousehold,
  routeBigHousehold,
} from './big-library.mjs';

const LATENCY_MS = Number(process.env.AIRING_LATENCY_MS ?? 150);
/** den-edge's relay allowance for a member, per minute (`relay.rs` `MEMBER_PER_WINDOW`). */
const RELAY_PER_MINUTE = 600;
const HOUR = 3600;
const DAY = 86_400;

const pad = (n) => String(n).padStart(2, '0');
/** `days` from today, where this machine (and so the browser) is. */
function dayFrom(days) {
  const at = new Date(Date.now() + days * DAY * 1000);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Which of the live split a series falls in, by its id: the same for every run. Of the dated ones, half have an
 * episode this week and half a season starting in twelve days.
 */
function kind(tmdb) {
  const h = (tmdb * 2_654_435_761) % 1000;
  if (h < 644) return 'ended';
  if (h < 847) return 'unknown';
  if (h < 985) return 'open';
  return h % 2 ? 'week' : 'back';
}

function schedule(tmdb) {
  const status = {
    ended: 'ended',
    unknown: null,
    open: 'running',
    week: 'running',
    back: 'running',
  }[kind(tmdb)];
  if (!status) return null;
  const previous = { season: 2, episode: 8, name: 'Last', date: '2024-05-01' };
  const answer = { source: 'tvmaze', status, service: 'Network', previous, upcoming: [] };
  if (kind(tmdb) === 'week') {
    const next = { season: 3, episode: 2, name: 'Next', date: dayFrom(3) };
    return { ...answer, next, upcoming: [next], seasonPremiere: { season: 3, date: dayFrom(-4) } };
  }
  if (kind(tmdb) === 'back') {
    const next = { season: 3, episode: 1, name: 'Premiere', date: dayFrom(12) };
    return { ...answer, next, upcoming: [next], seasonPremiere: { season: 3, date: dayFrom(12) } };
  }
  return { ...answer, seasonPremiere: { season: 2, date: '2024-03-20' } };
}

/** atlas's `tvmaze::max_age`: a settled series five days plus up to 96 hours by id, anything else six hours. */
const maxAge = (tmdb) =>
  ['ended', 'unknown'].includes(kind(tmdb)) ? 5 * DAY + (tmdb % 96) * HOUR : 6 * HOUR;

/**
 * Atlas's airing routes behind den-edge's relay, `LATENCY_MS` late: every request, the series it named, and the relay's
 * refusals once a minute holds more than `RELAY_PER_MINUTE`.
 */
async function routeAiring(page, seen) {
  await page.route('**/atlas/airing**', async (route) => {
    const request = route.request();
    const at = Date.now();
    seen.window = seen.window.filter((t) => at - t < 60_000);
    seen.requests.push(at);
    if (seen.window.length >= RELAY_PER_MINUTE) {
      seen.refused++;
      await new Promise((done) => setTimeout(done, LATENCY_MS));
      return route.fulfill({
        status: 429,
        headers: { 'retry-after': '60' },
        json: { error: 'rate_limited' },
      });
    }
    seen.window.push(at);
    await new Promise((done) => setTimeout(done, LATENCY_MS));
    seen.answered = Date.now();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/atlas/airing') {
      const { series } = request.postDataJSON();
      for (const { tmdb } of series) seen.series.add(tmdb);
      return route.fulfill({
        headers: { 'cache-control': 'no-store' },
        json: {
          airing: series.map(({ tmdb }) => ({
            tmdb,
            maxAge: maxAge(tmdb),
            airing: schedule(tmdb),
          })),
        },
      });
    }
    const tmdb = Number(/\/airing\/tv\/(\d+)$/.exec(path)?.[1]);
    seen.series.add(tmdb);
    const answer = schedule(tmdb);
    return route.fulfill({
      status: answer ? 200 : 404,
      headers: { 'cache-control': `public, max-age=${maxAge(tmdb)}` },
      json: answer ?? { error: 'not_found' },
    });
  });
}

/** One visit to Home: the sweep's requests, refusals and time, and the dated series it names on its rows. */
async function visit(context, edge, { cpu = 1 } = {}) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge, { latencyMs: LATENCY_MS, projectionMs: PHONE_PROJECTION_MS });
  const seen = { requests: [], window: [], refused: 0, series: new Set(), answered: 0 };
  await routeAiring(page, seen);
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  const started = Date.now();
  await page.goto(`${E2E_ORIGIN}/`);
  // Settled: some airing was asked, and nothing more for five seconds.
  await expect
    .poll(() => seen.requests.length > 0 && Date.now() - Math.max(...seen.requests) > 5_000, {
      timeout: 240_000,
      intervals: [500],
    })
    .toBe(true);
  const dated = [...seen.series].filter((tmdb) => ['week', 'back'].includes(kind(tmdb)));
  const shown = async (row, id) =>
    (await page.getByRole('region', { name: row }).locator(`a[href^="/tv/${id}-"]`).count()) > 0;
  const missing = [];
  for (const id of dated) {
    if (!(await shown('Coming up', id))) missing.push(`Coming up: ${id}`);
  }
  const result = {
    requests: seen.requests.length,
    series: seen.series.size,
    refused: seen.refused,
    sweepMs: seen.answered ? seen.answered - started : null,
    dated: dated.length,
    missing,
  };
  await page.close();
  return result;
}

const ENGINES = [
  ['WebKit iPhone', webkit, devices['iPhone 13'], {}],
  ['Chromium phone, 6× CPU', chromium, devices['Pixel 7'], { cpu: 6 }],
];

for (const [label, type, device, options] of ENGINES) {
  test(`${label}: Home asks for a big household's release dates in a few requests, and shows every date`, async () => {
    test.skip(
      type === webkit && !process.env.CI && !existsSync(webkit.executablePath()),
      'needs WebKit: npx playwright install webkit',
    );
    test.setTimeout(600_000 * BIG_LIBRARY_SCALE);
    const browser = await type.launch(
      type === chromium ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    );
    const { defaultBrowserType: _, ...phone } = device;
    const context = await browser.newContext(phone);
    try {
      const edge = newEdge({ profiles: true });
      await bigHousehold(context, edge);
      const first = await visit(context, edge, options);
      const again = await visit(context, edge, options);
      console.log(
        `airing sweep ${label} scale=${BIG_LIBRARY_SCALE} latency=${LATENCY_MS}ms: ` +
          JSON.stringify({ first, again }),
      );
      for (const one of [first, again]) {
        expect(one.missing, 'every dated series is on its row').toEqual([]);
        expect(one.refused, 'den-edge refuses none').toBe(0);
        expect(one.requests, 'a request per 512 series, not one each').toBeLessThanOrEqual(
          Math.ceil(one.series / 512) + 2,
        );
      }
      expect(first.dated, 'the household follows dated series').toBeGreaterThan(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
