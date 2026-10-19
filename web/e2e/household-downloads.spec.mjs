// Downloads on a household split into profiles, through the real app and the in-memory den-edge of `guest-edge.mjs`.
// The download queue and the source plugins it searches are the household's (profiles-v1 §6.1): Owner's activity
// moves to a library of its own, but `set:plugins` and every `download:*` row stay on the household's library, which
// is also where the TV reads the queue. A title page opened as Owner lists the household's sources and queues there.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { routeBigHousehold } from './big-library.mjs';
import { CODE, newEdge } from './guest-edge.mjs';

const SERIES = 1399;
const IMDB = 'tt0001399';
/** The one release the plugin lists for an episode of season 2. */
const release = (episode) => `Series.1399.S02E0${episode}.1080p.WEB.H264-GRP.mkv`;
const RELEASE = release(1);

/** den-edge's routes table, as the public name serves it: each Den service under this origin. */
const ROUTES = {
  v: 1,
  addons: {
    scout: [{ url: `${E2E_ORIGIN}/scout` }],
    play: [{ url: `${E2E_ORIGIN}/scout` }],
    den: [{ url: `${E2E_ORIGIN}/den` }],
  },
};

/**
 * The household's own source plugin: `install` its manifest URL, `base` where this page asks it, `ticket` the play URL
 * its episode list names, and `relayed` the prefix this page redeems that ticket under.
 */
const SCOUT = {
  id: 'com.den.scout',
  install: `${E2E_ORIGIN}/scout/scoutcfg/manifest.json`,
  base: '/scout/scoutcfg',
  ticket: `${E2E_ORIGIN}/scout/p/episode-ticket`,
  relayed: '/scout/p/',
};

/**
 * The combined Den addon (den-hearth `den.rs`): streams at `/den/<config>/stream/…`, and play tickets at `/den/p/…`,
 * keyed apart from Scout's so that Scout's `/scout/p/` refuses them.
 */
const HEARTH = {
  id: 'com.den.hearth',
  install: `${E2E_ORIGIN}/den/hearthcfg/manifest.json`,
  base: '/den/hearthcfg',
  ticket: `${E2E_ORIGIN}/den/p/episode-ticket`,
  relayed: '/den/p/',
};

/**
 * One page of the household: the big-library fixture's den-edge and TMDB, the routes table, and `addon` answering its
 * manifest, each season 2 episode's list and its play ticket (every ticket request is kept on `asked`). Episode 1's
 * ticket is `addon.ticket`, and episode N's `addon.ticket-N`.
 */
async function routeHousehold(page, edge, addon, asked = []) {
  await routeBigHousehold(page, edge, { atlas: false });
  await page.route('**/routes', (route) => route.fulfill({ json: ROUTES }));
  await page.route(`${E2E_ORIGIN}${addon.base}/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `${addon.base}/manifest.json`)
      return route.fulfill({ json: { id: addon.id, version: '1.0.0', resources: ['stream'] } });
    const episode = decodeURIComponent(path).match(
      new RegExp(`^${addon.base}/stream/series/${IMDB}:2:(\\d+)\\.json$`),
    );
    if (episode) {
      const n = Number(episode[1]);
      return route.fulfill({
        json: {
          streams: [
            {
              title: release(n),
              url: n === 1 ? addon.ticket : `${addon.ticket}-${n}`,
              behaviorHints: { filename: release(n) },
              attributes: { resolution: '1080p', cached: false, seeders: 12, sizeBytes: 2e9 },
            },
          ],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route(`${E2E_ORIGIN}${addon.relayed}**`, (route) => {
    const url = new URL(route.request().url());
    asked.push(`${route.request().method()} ${url.pathname}${url.search}`);
    return route.fulfill({
      status: 202,
      json: { progress: 0.25, bytesPerSecond: 1_000_000, state: 'downloading', seeds: 5, peers: 9 },
    });
  });
  return asked;
}

/**
 * The household this browser made for itself, split into profiles with Owner active, whose library lists `addon` and
 * nothing else. It is made as a guest's is (an invite on a profile host starts one), and the grant is then ended, so
 * the host's addons are gone and the household's own plugin is the only one left. Returns the household's library id.
 */
async function splitHousehold(page, edge, addon) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  const at = [Date.now() - 60_000, 0, 'aaaaaaaaaaaaaaaa'];
  await page.evaluate(
    (rows) => window.denSeed(rows),
    [
      {
        kind: 'set',
        schema: 2,
        name: 'plugins',
        values: { [addon.install]: { value: { bool: true }, at } },
      },
    ],
  );
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect(page.getByRole('button', { name: 'Switch profile, current Owner' })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(3);
  edge.grant.live = false;
  return [...edge.libraries].find(([, library]) => library.wireMin === 5)[0];
}

/** How many rows each library holds: the household's, and every other (Owner's and Kid's) together. */
const rowCounts = (edge, household) => {
  let others = 0;
  for (const [id, library] of edge.libraries) if (id !== household) others += library.rows.size;
  return { household: edge.libraries.get(household).rows.size, others };
};

async function downloadsAnEpisode(addon) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    const asked = await routeHousehold(page, edge, addon);
    // Every ticket either addon could be asked about, wherever it went: one addon's ticket on the other's route
    // would be refused there.
    const tickets = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (/^\/(?:scout|den)\/p\//.test(pathname)) tickets.push(pathname);
    });
    const household = await splitHousehold(page, edge, addon);

    await page.goto(`${E2E_ORIGIN}/tv/${SERIES}`);
    const active = page.locator('[data-active="true"]');
    await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
    const row = active.locator('.episode').first();
    await row.getByRole('button', { name: 'Options for episode 1', exact: true }).click();
    await row.getByRole('menuitem', { name: 'Sources', exact: true }).click();
    const panel = active.locator('.source-panel');
    await expect(panel.getByText('Sources for S2 · E1')).toBeVisible();
    // The household's own plugin answers for Owner: its release, not "Add Den Scout".
    const source = panel.locator('li').filter({ hasText: RELEASE });
    await expect(source).toBeVisible({ timeout: 30_000 });
    await expect(panel).not.toContainText('Add Den Scout');

    const before = rowCounts(edge, household);
    await source.getByRole('button', { name: 'Download', exact: true }).click();
    // The queue is the household's: the add (a prefetch) goes to the plugin's own ticket route, and the row is
    // written to the household's library, not Owner's.
    await expect.poll(() => asked[0]).toBe(`GET ${addon.relayed}episode-ticket?prefetch=1`);
    await expect.poll(() => rowCounts(edge, household).household).toBeGreaterThan(before.household);
    expect(rowCounts(edge, household).others).toBe(before.others);

    // The Downloads page reads it back from the household after a reload, and keeps probing that ticket.
    await page.goto(`${E2E_ORIGIN}/downloads`);
    const card = page.locator(`[data-download="tv:${SERIES}:2:1"]`);
    await expect(card).toContainText('Downloading 25%', { timeout: 30_000 });
    await expect
      .poll(() => asked.some((ask) => ask === `GET ${addon.relayed}episode-ticket?probe=1`))
      .toBe(true);
    expect(asked.every((ask) => ask.startsWith(`GET ${addon.relayed}episode-ticket?`))).toBe(true);
    expect(new Set(tickets)).toEqual(new Set([`${addon.relayed}episode-ticket`]));
    expect(rowCounts(edge, household).others).toBe(before.others);
  } finally {
    await browser.close();
  }
}

/**
 * Sources opened for S2·E1 switch to E3 from the picker beside their heading: the heading, the list and a Download are
 * then E3's, as if Sources had been opened from E3's own menu.
 */
async function switchesEpisode(browserType, viewport) {
  const browser = await browserType.launch(
    browserType === chromium
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  );
  try {
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    const asked = await routeHousehold(page, edge, SCOUT);
    await splitHousehold(page, edge, SCOUT);

    await page.setViewportSize(viewport);
    await page.goto(`${E2E_ORIGIN}/tv/${SERIES}`);
    // Once the series page is open: WebKit reports the service probes a navigation cuts short as page errors.
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const active = page.locator('[data-active="true"]');
    // A phone is too narrow for the four seasons' chips, and offers them as one picker.
    const seasons = active.getByRole('combobox', { name: 'Season', exact: true });
    const seasonTab = active.getByRole('tab', { name: 'Season 2', exact: true });
    await expect(seasons.or(seasonTab)).toBeVisible({ timeout: 30_000 });
    if (await seasons.isVisible()) await seasons.selectOption('2');
    else await seasonTab.click();
    const row = active.locator('.episode').first();
    await expect(row).toContainText('Episode 1');
    await row.getByRole('button', { name: 'Options for episode 1', exact: true }).click();
    await row.getByRole('menuitem', { name: 'Sources', exact: true }).click();

    const panel = active.locator('.source-panel');
    await expect(panel.getByText('Sources for S2 · E1')).toBeVisible();
    await expect(panel.locator('li').filter({ hasText: release(1) })).toBeVisible({
      timeout: 30_000,
    });
    const episodes = panel.getByRole('combobox', { name: 'Episode', exact: true });
    await expect(episodes).toHaveValue('1');
    const options = await episodes.locator('option').allTextContents();
    expect(options).toHaveLength(10);
    expect(options[2]).toBe('E3 · Episode 3');

    // The picker sits at the heading's right, and neither runs out of the panel.
    const [heading, picker, box] = await Promise.all([
      panel.getByText('Sources for S2 · E1').boundingBox(),
      episodes.locator('..').boundingBox(),
      panel.boundingBox(),
    ]);
    expect(picker.x).toBeGreaterThan(heading.x);
    expect(picker.x + picker.width).toBeLessThanOrEqual(box.x + box.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

    await episodes.selectOption('3');
    await expect(panel.getByText('Sources for S2 · E3')).toBeVisible();
    const source = panel.locator('li').filter({ hasText: release(3) });
    await expect(source).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('li').filter({ hasText: release(1) })).toHaveCount(0);
    await expect(episodes).toHaveValue('3');

    await source.getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(() => asked[0]).toBe(`GET ${SCOUT.relayed}episode-ticket-3?prefetch=1`);
    // Read before leaving the page, for the same reason.
    expect(errors).toEqual([]);
    await page.goto(`${E2E_ORIGIN}/downloads`);
    await expect(page.locator(`[data-download="tv:${SERIES}:2:3"]`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(`[data-download="tv:${SERIES}:2:1"]`)).toHaveCount(0);
  } finally {
    await browser.close();
  }
}

const needsWebKit = () =>
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

for (const [name, viewport] of [
  ['a phone', { width: 390, height: 844 }],
  ['a desktop', { width: 1280, height: 900 }],
]) {
  test(`Sources switch to another episode from the picker by their heading, on ${name}`, async () => {
    await switchesEpisode(chromium, viewport);
  });
  test(`Sources switch to another episode from the picker by their heading, on ${name}, in WebKit`, async () => {
    needsWebKit();
    await switchesEpisode(webkit, viewport);
  });
}

test('on a split household Owner lists the household’s Scout sources and queues on the household', async () => {
  await downloadsAnEpisode(SCOUT);
});

// The owner's household after it moved to Den Hearth: the combined addon is its only source plugin. Sources and
// downloads use it as playback does, and its tickets are redeemed on Hearth's own `/den/p/` route.
test('on a split household with only Den Hearth, Owner lists Hearth’s sources and queues on the household', async () => {
  await downloadsAnEpisode(HEARTH);
});
