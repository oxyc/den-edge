// A title playing on another device shows where it is on this page, ticking, for as long as it plays — and stops
// after it does. Two browsers share one in-memory den-edge: this page runs the production RoutedLibrary and Worker
// (so the lifecycle it reports and the refresh cadence it gets are the real ones), and a second browser is the other
// device, writing its first eligible position immediately and then every 30 seconds. Real time, not a fake clock:
// the save, debounce and pull cadences live outside the page clock.
import { hkdfSync } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE as SEED_FIXTURE, routeLibraryEdge } from './library-edge.mjs';
import { routeTmdb } from './network.mjs';

// These real-time scenarios each own their browser contexts and in-memory edge state.
// Let Playwright run them concurrently instead of making one shard wait for all three.
test.describe.configure({ mode: 'parallel' });

const FIXTURE = `${E2E_ORIGIN}/test/live-position.html`;
const WRITE_EVERY_MS = 30_000;
const DELIVERY_DEBOUNCE_MS = 5_000;
const ONE_LOST_DELIVERY_MS = 72_000;
const SHORT_PLAYING_MS = 12_000;
const EXPIRE_LIVE_MS = 76_000;
const HOUSEHOLD_TV_QUEUE = Buffer.from(
  hkdfSync('sha256', Buffer.alloc(32, 9), 'den/link/v1', 'inbox', 24),
).toString('hex');

/**
 * One den-edge for both browsers: what one writes, the other pulls. `pulls` lists when each page asked, and
 * `arrivals` how old the device's newest write was each time this page's pull carried it.
 *
 * `loseOnePeriodicDelivery` holds the device's writes before den-edge: the first eligible save is delivered at once,
 * the 30 s save is lost, and the 60 s replacement waits for the native five-second delivery debounce. The page then
 * observes it through its production five-second active-playback pull.
 */
function sharedEdge({ loseOnePeriodicDelivery = false } = {}) {
  const generation = 'live-position';
  /** Every row den-edge holds, by key. */
  const rows = new Map();
  /** The device's rows as they will be once its sync next runs. */
  const unpushed = new Map();
  let head = 0;
  const headers = { 'x-den-generation': generation, 'x-den-wire-min': '4' };
  const pulls = new Map();
  /** The `wait` each page's pulls asked den-edge to hold for, in order (0: none). */
  const waits = new Map();
  const arrivals = [];
  const controls = [];
  let deviceWrote = 0;
  let pushedWrite = 0;
  let pulledWrite = 0;
  let deviceWrites = 0;
  let deliveryArmed = false;
  const waiters = new Set();
  const deliveryTimers = new Set();
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
  const after = (delay, work) => {
    const timer = setTimeout(() => {
      deliveryTimers.delete(timer);
      work();
    }, delay);
    deliveryTimers.add(timer);
  };
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
    await page.route(`${E2E_ORIGIN}/inbox/append`, (route) => {
      controls.push({
        header: route.request().headers()['x-den-link'],
        body: route.request().postDataJSON(),
      });
      return route.fulfill({ status: 200, json: { queued: true } });
    });
    await page.route(`${E2E_ORIGIN}/inbox/listening`, (route) =>
      route.fulfill({ status: 200, json: { listening: true } }),
    );
    pulls.set(name, []);
    waits.set(name, []);
    // Registered last, so it answers before the per-page edge `routeLibraryEdge` installs.
    await page.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/member') && request.method() === 'PUT')
        return route.fulfill({ status: 200, headers });
      if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
        pulls.get(name).push(Date.now());
        waits.get(name).push(Number(url.searchParams.get('wait') ?? 0));
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
        const held = name === 'device' && loseOnePeriodicDelivery && deliveryArmed;
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
          deviceWrites++;
          if (!held) pushedWrite = deviceWrote;
          else if (deviceWrites === 1) push();
          // The second save stays private to the device: its replacement supersedes it before the next delivery.
          else if (deviceWrites > 2) after(DELIVERY_DEBOUNCE_MS, push);
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
    waits,
    arrivals,
    controls,
    deviceWrites: () => deviceWrites,
    armLostDelivery: () => {
      deliveryArmed = true;
      deviceWrites = 0;
    },
    close: () => {
      for (const timer of deliveryTimers) clearTimeout(timer);
      deliveryTimers.clear();
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
  edge.armLostDelivery();

  let timer;
  let pausedAt;
  // The write in flight, which `close` waits for: closing the device's context under it would reject it.
  let writing = Promise.resolve();
  /**
   * Writes `title`'s first eligible position immediately and then every 30 seconds, counting on from `from`, until
   * `stop()`. `pause()` writes the explicit transition immediately, as production does.
   */
  const play = (title, from, episode) => {
    const started = Date.now();
    const write = (playing = true) =>
      (writing = device.evaluate(
        ([title, seconds, episode, playing]) =>
          window.fixturePlay(title, seconds, episode, playing),
        [title, pausedAt ?? from + Math.floor((Date.now() - started) / 1000), episode, playing],
      ));
    void write();
    timer = setInterval(() => void write(), WRITE_EVERY_MS);
    return {
      pause: () => {
        pausedAt = from + Math.floor((Date.now() - started) / 1000);
        void write(false);
      },
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
    loseOnePeriodicDelivery: true,
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
    // Span the lost 30 s delivery and the 60 s replacement's five-second delivery debounce plus a consumer pull.
    // The first eligible save, meanwhile, was delivered immediately: all three writes cross the production model.
    await expectTicking(clock, edge, ONE_LOST_DELIVERY_MS);
    expect(edge.deviceWrites(), 'first save, lost periodic save, and replacement save').toBe(3);
    expect(
      edge.arrivals,
      'only the first and replacement deliveries reached den-edge',
    ).toHaveLength(2);
    expect(
      edge.arrivals[1],
      'replacement delivery included the five-second debounce',
    ).toBeGreaterThanOrEqual(DELIVERY_DEBOUNCE_MS - 500);

    // An abandoned player has no explicit transition. The last write still retires after the bounded 75 s window;
    // the helper's focused boundary test proves that exactly 75 s remains inclusive and the next millisecond is not.
    stop();
    await page.clock.fastForward(EXPIRE_LIVE_MS);
    await expect(clock).toBeHidden();
  } finally {
    await close();
  }
});

test('a series’ page says which device plays which episode, and keeps controls when playback pauses', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { edge, play, close } = await openWithDevice(browser, page);
  try {
    await page.locator('.card', { hasText: 'Series 1003' }).click();
    await expect(page.getByRole('heading', { name: 'Series 1003', level: 1 })).toBeVisible();
    const block = page.locator('.hero .continue-row');
    const resume = page.locator('header.hero').getByRole('link', { name: 'Resume', exact: true });
    const label = block.locator('strong');
    const clock = block.locator('.live-clock, .remote-clock');
    const heading = page.getByRole('heading', { name: 'Series 1003', level: 1 });
    const actions = page.locator('.hero-actions');
    const boxes = async () => [
      await heading.boundingBox(),
      await block.boundingBox(),
      await actions.boundingBox(),
    ];
    // The seeded resume point can still be within the inclusive 75 s live window when the production Worker opens.
    await expect(clock).toBeHidden({ timeout: 90_000 });
    await expect(label).toHaveText('Continue Watching');
    const continueIcon = await block.locator('.lead-icon').boundingBox();
    const projectedResume = await resume.getAttribute('href');
    expect(projectedResume).not.toMatch(/season=1&episode=3&play=1$/);
    const playing = play({ type: 'tv', id: 1003 }, 600, { season: 1, episode: 3 });
    await expect(clock).toHaveText(/^1\d:\d\d$/, { timeout: 40_000 });
    await expect(label).toHaveText('Playing on Apple TV');
    const sentBefore = edge.controls.length;
    const controls = page.getByLabel('Controls for Apple TV');
    await expect(controls).toBeVisible();
    const remoteIcon = await controls.locator('.lead-icon').boundingBox();
    expect(remoteIcon.x).toBeCloseTo(continueIcon.x, 0);
    expect(remoteIcon.y).toBeCloseTo(continueIcon.y, 0);
    const withLive = await boxes();
    const addressBeforeRemotePause = page.url();
    await controls.getByRole('link', { name: 'Playing on Apple TV' }).click();
    await expect(label).toHaveText('Paused on Apple TV');
    expect(
      page.url(),
      'pressing the live row controls the TV rather than opening Web playback',
    ).toBe(addressBeforeRemotePause);
    await controls.getByRole('button', { name: 'Skip back 10 seconds' }).click();
    await controls.getByRole('button', { name: 'Resume' }).click();
    await expect(label).toHaveText('Playing on Apple TV');
    await controls.getByRole('button', { name: 'Skip forward 10 seconds' }).click();
    await expect(controls.getByRole('slider')).toHaveCount(0);
    await expect(controls.locator('.resume-track')).toBeVisible();
    await expect.poll(() => edge.controls.length).toBe(sentBefore + 4);
    expect(
      edge.controls
        .slice(sentBefore)
        .every(
          ({ header, body }) =>
            header === HOUSEHOLD_TV_QUEUE && Object.keys(body).join() === 'sealed',
        ),
    ).toBe(true);
    await expect(block.locator('small')).toHaveText('S1 · E3');
    await expect(block.locator('.remote-title')).toHaveAttribute(
      'href',
      /season=1&episode=3&play=1$/,
    );
    await expect(resume).toHaveAttribute('href', /season=1&episode=3&play=1$/);
    const samples = await watch(clock, 15_000);
    expect(samples.filter((text) => text === null)).toEqual([]);
    expect(new Set(samples).size, 'the clock ticked').toBeGreaterThan(10);
    for (const width of [393, 1280]) {
      await page.setViewportSize({ width, height: width < 500 ? 852 : 800 });
      const widget = await controls.boundingBox();
      expect(widget.x).toBeGreaterThanOrEqual(0);
      expect(widget.x + widget.width).toBeLessThanOrEqual(width);
      await expect(controls.locator('.resume-track')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`detail-live-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(clock).toBeVisible();

    playing.pause();
    await expect(label).toHaveText('Paused on Apple TV', { timeout: 20_000 });
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeVisible();
    const controlsBeforePrimaryResume = edge.controls.length;
    const addressBeforePrimaryResume = page.url();
    const remoteResume = page.getByRole('button', { name: 'Resume on Apple TV', exact: true });
    const moreWays = page.getByRole('button', { name: 'More ways to resume on apple tv' });
    await moreWays.click();
    await expect(page.getByRole('menuitem', { name: 'Resume here', exact: true })).toBeVisible();
    await moreWays.click();
    await remoteResume.click();
    await expect.poll(() => edge.controls.length).toBe(controlsBeforePrimaryResume + 1);
    expect(page.url(), 'resuming the TV stays on the title page').toBe(addressBeforePrimaryResume);
    const pausedSamples = await watch(clock, 3_000);
    expect(new Set(pausedSamples).size, 'the paused clock stayed frozen').toBe(1);
    expect(await boxes(), 'nothing moved when playback paused').toEqual(withLive);
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

    // Paused on the device: the transition is written immediately with explicit producer state.
    playing.pause();
    const paused = Date.now();
    await expect(clock).toBeHidden({ timeout: 20_000 });
    console.log(`clock gone ${Date.now() - paused} ms after the pause`);
  } finally {
    await close();
  }
});

test('this browser’s own playback never pulls the library faster; another device’s does', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { edge, play, close } = await openWithDevice(browser, page);
  // Another tab of this browser: the same stamp device as the page, so its writes are this device's own playback.
  const own = await page.context().newPage();
  let timer;
  try {
    await edge.route(own, 'own');
    await own.goto(`${FIXTURE}?writer`);
    await own.getByRole('status').filter({ hasText: 'Writer ready' }).waitFor({ timeout: 15_000 });
    const started = Date.now();
    const write = () =>
      own.evaluate(
        ([title, seconds]) => window.fixturePlay(title, seconds),
        [PLAYED, 600 + Math.floor((Date.now() - started) / 1000)],
      );
    await write();
    timer = setInterval(() => void write().catch(() => {}), WRITE_EVERY_MS);
    // The page has its own playback on Home (the clock shows it) and goes on holding its idle read.
    await expect(homeClock(page)).toBeVisible({ timeout: 40_000 });
    const from = edge.waits.get('page').length;
    await page.waitForTimeout(15_000);
    const waits = edge.waits.get('page').slice(from);
    console.log(`page pulls' wait while this browser plays: ${waits.join(' ')}`);
    expect(waits.length, 'the page went on reading').toBeGreaterThan(0);
    expect(
      waits.filter((wait) => wait === 5),
      'no live-playback pulls',
    ).toEqual([]);
    clearInterval(timer);

    // Another device playing: the page does pull at the live cadence.
    play({ type: 'movie', id: 1004 }, 300);
    await expect
      .poll(() => edge.waits.get('page').slice(from).includes(5), { timeout: 60_000 })
      .toBe(true);
  } finally {
    clearInterval(timer);
    await own.close();
    await close();
  }
});

test('the library is not maintained under this page’s player, and catches up when it closes', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { edge, close } = await openWithDevice(browser, page);
  try {
    await page.locator('.card', { hasText: 'Series 1003' }).click();
    const resume = page.locator('header.hero').getByRole('link', { name: 'Resume', exact: true });
    await resume.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Whatever read was under way when it opened ends; then nothing more is read.
    await page.waitForTimeout(3_000);
    const before = edge.pulls.get('page').length;
    await page.waitForTimeout(35_000);
    expect(edge.pulls.get('page').length, 'reads while the player was open').toBe(before);

    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect
      .poll(() => edge.pulls.get('page').length, { timeout: 5_000 })
      .toBeGreaterThan(before);
  } finally {
    await close();
  }
});
