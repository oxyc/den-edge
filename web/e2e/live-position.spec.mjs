// A title playing on another device shows where it is on this page, ticking, for as long as it plays — and stops
// after it does. Two browsers share one in-memory den-edge: this page runs the production RoutedLibrary and Worker
// (so the lifecycle it reports and the refresh cadence it gets are the real ones), and a second browser is the other
// device, writing the position every three seconds as the Apple TV's player does. Real time, not a fake clock: the
// cadence lives in the Worker, which a page clock does not reach.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE as SEED_FIXTURE, routeLibraryEdge } from './library-edge.mjs';
import { routeTmdb } from './network.mjs';

// These real-time scenarios each own their browser contexts and in-memory edge state.
// Let Playwright run them concurrently instead of making one shard wait for all three.
test.describe.configure({ mode: 'parallel' });

const FIXTURE = `${E2E_ORIGIN}/test/live-position.html`;
const WRITE_EVERY_MS = 3_000;
const BETWEEN_PUSHES_MS = 32_000;
const SHORT_PLAYING_MS = 12_000;
const EXPIRE_LIVE_MS = 46_000;
/** A held read of den-edge (25 s) and the sync after it: how often the Apple TV's log reaches den-edge. */
const TV_PUSH_MS = 27_000;

/**
 * One den-edge for both browsers: what one writes, the other pulls. `pulls` lists when each page asked, and
 * `arrivals` how old the device's newest write was each time this page's pull carried it.
 *
 * `pushEveryMs` makes the device push as the Apple TV does: it writes its position every three seconds into its
 * own log, but its log reaches den-edge only when its sync runs. den-edge's request log, with a TV playing, showed
 * its `POST /lib/:id/batch` in bursts about 30 s apart. In den (the tvOS app) that is the reconciliation poll — a
 * 25 s held read of `/changes`, then a sync (`RootView.startReconciliationPoll`, `HeldPoll.wait`) — and a debounced
 * sync that each 3 s progress write pushes back, up to its 60 s cap (`LibraryLogSync.scheduleSync`).
 */
function sharedEdge({ pushEveryMs = 0 } = {}) {
  const generation = 'live-position';
  /** Every row den-edge holds, by key. */
  const rows = new Map();
  /** The device's rows as they will be once its sync next runs. */
  const unpushed = new Map();
  let head = 0;
  const headers = { 'x-den-generation': generation, 'x-den-wire-min': '4' };
  const pulls = new Map();
  const arrivals = [];
  let deviceWrote = 0;
  let pushedWrite = 0;
  let pulledWrite = 0;
  const waiters = new Set();
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const push = () => {
    for (const [k, entry] of unpushed) rows.set(k, entry);
    unpushed.clear();
    pushedWrite = deviceWrote;
    wake();
  };
  const pushing = pushEveryMs ? setInterval(push, pushEveryMs) : undefined;
  const route = async (page, name) => {
    await routeLibraryEdge(page);
    // This fixture needs a reachable player route as well as the paired TV: the regression below checks that the
    // hero's own Resume action follows the live episode, not Continue Watching's independently projected target.
    await page.route('**/routes', (route) =>
      route.fulfill({
        json: {
          addons: {
            scout: [{ url: `${E2E_ORIGIN}/scout` }],
            remux: [{ url: `${E2E_ORIGIN}/remux` }],
          },
        },
      }),
    );
    await page.route(`${E2E_ORIGIN}/remux/health`, (route) =>
      route.fulfill({ json: { status: 'ok' } }),
    );
    // `routeLibraryEdge` names movies only; the seeded series (tv:1003) is named here.
    await routeTmdb(page, (route) => {
      const id = new URL(route.request().url()).pathname.match(/\/tv\/(\d+)$/)?.[1];
      if (!id) return route.fallback();
      return route.fulfill({
        json: {
          id: Number(id),
          name: `Series ${id}`,
          first_air_date: '2026-01-01',
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          vote_average: 7.5,
          vote_count: 500,
          genres: [{ id: 18 }],
          credits: { cast: [], crew: [] },
          seasons: [{ season_number: 1, episode_count: 8 }],
          last_episode_to_air: { season_number: 1, episode_number: 8 },
          external_ids: {},
        },
      });
    });
    // A paired page drains its assistants' queue; this library has no assistant.
    await page.route(`${E2E_ORIGIN}/assistant/**`, (route) => route.fulfill({ status: 404 }));
    pulls.set(name, []);
    // Registered last, so it answers before the per-page edge `routeLibraryEdge` installs.
    await page.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/member') && request.method() === 'PUT')
        return route.fulfill({ status: 200, headers });
      if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
        pulls.get(name).push(Date.now());
        const since = Number(url.searchParams.get('since') ?? 0);
        // The device reads its own log, pushed or not; this page reads only what has reached den-edge.
        const visible = () => new Map([...rows, ...(name === 'device' ? unpushed : [])]);
        let held = visible();
        let entries = [...held.values()].filter((entry) => entry.seq > since);
        const wait = Number(url.searchParams.get('wait') ?? 0);
        if (!entries.length && wait > 0) {
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            };
            const timer = setTimeout(done, wait * 1_000);
            waiters.add(done);
          });
          held = visible();
          entries = [...held.values()].filter((entry) => entry.seq > since);
        }
        if (name === 'page' && pushedWrite > pulledWrite) {
          arrivals.push(Date.now() - pushedWrite);
          pulledWrite = pushedWrite;
        }
        const heldHead = Math.max(0, ...[...held.values()].map((entry) => entry.seq));
        return route.fulfill({
          headers,
          json: { generation, entries, head: heldHead, more: false },
        });
      }
      if (url.pathname.endsWith('/batch') && request.method() === 'POST') {
        const applied = [];
        const conflicts = [];
        const held = name === 'device' && pushEveryMs;
        for (const write of request.postDataJSON().writes) {
          const current = unpushed.get(write.k) ?? rows.get(write.k);
          if ((current?.seq ?? 0) !== write.base) {
            conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
            continue;
          }
          const entry = { k: write.k, seq: ++head, v: write.v };
          (held ? unpushed : rows).set(write.k, entry);
          applied.push({ k: write.k, seq: entry.seq });
        }
        if (name === 'device') {
          deviceWrote = Date.now();
          if (!held) pushedWrite = deviceWrote;
        }
        if (!held) wake();
        return route.fulfill({ headers, json: { applied, conflicts } });
      }
      return route.abort('blockedbyclient');
    });
  };
  return {
    route,
    pulls,
    arrivals,
    close: () => {
      clearInterval(pushing);
      wake();
    },
  };
}

/** This page on the paired library, seeded once, and the other device beside it. */
async function openWithDevice(browser, page, options) {
  const edge = sharedEdge(options);
  await edge.route(page, 'page');
  // Keep wall time for the Worker's real pull cadence, but let expiry advance without sleeping for LIVE_MS.
  await page.clock.install();
  await page.goto(`${SEED_FIXTURE}?seed&online&stale-live`);
  await page
    .getByRole('status')
    .filter({ hasText: 'Worker library seeded' })
    .waitFor({ timeout: 15_000 });
  await page.goto(FIXTURE);
  await expect(page.getByRole('heading', { name: 'Continue Watching' })).toBeVisible({
    timeout: 20_000,
  });

  const context = await browser.newContext();
  const device = await context.newPage();
  await edge.route(device, 'device');
  await device.goto(`${FIXTURE}?writer`);
  await device.getByRole('status').filter({ hasText: 'Writer ready' }).waitFor({ timeout: 15_000 });

  let timer;
  let pausedAt;
  // The write in flight, which `close` waits for: closing the device's context under it would reject it.
  let writing = Promise.resolve();
  /**
   * Writes `title`'s position every three seconds, counting on from `from`, until `stop()`. After `pause()` the
   * writes go on at the position it paused at, as the TV's do while its player is paused.
   */
  const play = (title, from, episode) => {
    const started = Date.now();
    const write = () =>
      (writing = device.evaluate(
        ([title, seconds, episode]) => window.fixturePlay(title, seconds, episode),
        [title, pausedAt ?? from + Math.floor((Date.now() - started) / 1000), episode],
      ));
    void write();
    timer = setInterval(() => void write(), WRITE_EVERY_MS);
    return {
      pause: () => (pausedAt = from + Math.floor((Date.now() - started) / 1000)),
    };
  };
  const stop = () => clearInterval(timer);
  const close = async () => {
    stop();
    await writing;
    edge.close();
    await context.close();
  };
  return { edge, play, stop, close };
}

/** Samples `clock` every 250 ms for `ms`: each sample is its text, or null while it is not shown. */
async function watch(clock, ms) {
  const samples = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    samples.push((await clock.isVisible()) ? await clock.textContent() : null);
    await new Promise((done) => setTimeout(done, 250));
  }
  return samples;
}

/** Each gap between `times` and the next, in ms. */
const gaps = (times) => times.slice(1).map((at, index) => at - times[index]);

/** Samples as runs: "on 12.0s, off 3.5s, …". */
const runs = (samples) => {
  const out = [];
  for (const text of samples) {
    const state = text === null ? 'off' : 'on';
    if (out.at(-1)?.state === state) out.at(-1).count++;
    else out.push({ state, count: 1 });
  }
  return out.map(({ state, count }) => `${state} ${(count / 4).toFixed(1)}s`).join(', ');
};

/** Watches `clock` and expects it shown, and ticking, the whole time. */
async function expectTicking(clock, edge, duration) {
  const pullsBefore = edge.pulls.get('page').length;
  const samples = await watch(clock, duration);
  const pulled = edge.pulls.get('page').slice(pullsBefore);
  console.log(`page pulls while playing, ms apart: ${gaps(pulled).join(' ')}`);
  console.log(`newest write's age when a pull carried it, ms: ${edge.arrivals.join(' ')}`);
  console.log(`clock while playing: ${runs(samples)}`);
  const hidden = samples.filter((text) => text === null).length;
  expect(hidden, `the clock was gone for ${hidden} of ${samples.length} samples`).toBe(0);
  expect(new Set(samples).size, 'the clock ticked').toBeGreaterThan(duration / 1000 - 5);
}

// Not either seeded resume point, so each test observes only the writes it creates.
const PLAYED = { type: 'movie', id: 1002 };
const homeClock = (page) => page.locator('.card', { hasText: 'Movie 1002' }).locator('.live');

test('a title playing on the TV keeps its clock on Home between the TV’s pushes, until it stops', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { edge, play, stop, close } = await openWithDevice(browser, page, {
    pushEveryMs: TV_PUSH_MS,
  });
  try {
    const clock = homeClock(page);
    play(PLAYED, 600);
    await expect(clock).toBeVisible({ timeout: 70_000 });
    await expect(clock).toHaveText(/^1\d:\d\d$/);
    // In the art's lower-right corner, where the card's play glyph is, above its progress bar.
    const art = await page
      .locator('.card', { hasText: 'Movie 1002' })
      .locator('.art')
      .boundingBox();
    const badge = await clock.boundingBox();
    expect(art.x + art.width - (badge.x + badge.width)).toBeCloseTo(8, 0);
    const bottomInset = art.y + art.height - (badge.y + badge.height);
    // Fractional poster sizing can put the nominal 18px inset on either side of a half-pixel rounding boundary.
    expect(bottomInset).toBeGreaterThanOrEqual(17);
    expect(bottomInset).toBeLessThanOrEqual(19);
    // Long enough to span the TV's next real 27-second push and several of this page's 5-second pulls.
    await expectTicking(clock, edge, BETWEEN_PUSHES_MS);

    // Stopped on the TV: no more writes. The clock runs on until the last one is LIVE_MS (45 s) old.
    stop();
    await page.clock.fastForward(EXPIRE_LIVE_MS);
    await expect(clock).toBeHidden();
  } finally {
    await close();
  }
});

test('a series’ page says which device plays which episode, and moves nothing as the clock comes and goes', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { play, close } = await openWithDevice(browser, page);
  try {
    await page.locator('.card', { hasText: 'Series 1003' }).click();
    await expect(page.getByRole('heading', { name: 'Series 1003', level: 1 })).toBeVisible();
    const block = page.locator('.hero .continue');
    const resume = page.locator('header.hero').getByRole('link', { name: 'Resume', exact: true });
    const label = block.locator('strong');
    const clock = block.locator('.live-clock');
    const heading = page.getByRole('heading', { name: 'Series 1003', level: 1 });
    const actions = page.locator('.hero-actions');
    const boxes = async () => [
      await heading.boundingBox(),
      await block.boundingBox(),
      await actions.boundingBox(),
    ];
    // The seeded resume point was written as the page opened, so its own clock may still be running out.
    await expect(clock).toBeHidden({ timeout: 60_000 });
    await expect(label).toHaveText('Continue Watching');
    const projectedResume = await resume.getAttribute('href');
    expect(projectedResume).not.toMatch(/season=1&episode=3&play=1$/);
    const without = await boxes();

    const playing = play({ type: 'tv', id: 1003 }, 600, { season: 1, episode: 3 });
    await expect(clock).toHaveText(/^1\d:\d\d$/, { timeout: 40_000 });
    await expect(label).toHaveText('Playing on Apple TV');
    await expect(block.locator('small')).toHaveText('S1 · E3');
    await expect(block).toHaveAttribute('href', /season=1&episode=3&play=1$/);
    await expect(resume).toHaveAttribute('href', /season=1&episode=3&play=1$/);
    expect(await boxes(), 'nothing moved as the clock appeared').toEqual(without);
    const samples = await watch(clock, 15_000);
    expect(samples.filter((text) => text === null)).toEqual([]);
    expect(new Set(samples).size, 'the clock ticked').toBeGreaterThan(10);
    for (const width of [393, 1280]) {
      await page.setViewportSize({ width, height: width < 500 ? 852 : 800 });
      const track = await block.locator('.resume-track').boundingBox();
      const time = await clock.boundingBox();
      // Beside the track, on its line, inside the page.
      expect(time.x).toBeGreaterThan(track.x + track.width);
      expect(time.x + time.width).toBeLessThanOrEqual(width);
      expect(time.y + time.height / 2).toBeCloseTo(track.y + track.height / 2, 0);
      await page.screenshot({ path: test.info().outputPath(`detail-live-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(clock).toBeVisible();

    playing.pause();
    await expect(clock).toBeHidden({ timeout: 20_000 });
    await expect(label).toHaveText('Continue Watching');
    expect(await boxes(), 'nothing moved as the clock went').toEqual(without);
  } finally {
    await close();
  }
});

test('a title paused on another device stops its clock at the next write that did not move', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { edge, play, close } = await openWithDevice(browser, page);
  try {
    const clock = homeClock(page);
    const playing = play(PLAYED, 600);
    await expect(clock).toBeVisible({ timeout: 40_000 });
    // Two live pulls are enough to prove that fresh writes keep the clock moving before the pause check.
    await expectTicking(clock, edge, SHORT_PLAYING_MS);

    // Paused on the device: it goes on writing every three seconds, at one position.
    playing.pause();
    const paused = Date.now();
    await expect(clock).toBeHidden({ timeout: 20_000 });
    console.log(`clock gone ${Date.now() - paused} ms after the pause`);
  } finally {
    await close();
  }
});
