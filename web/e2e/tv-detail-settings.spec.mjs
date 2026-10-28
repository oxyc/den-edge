import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const series = {
  id: 9,
  name: 'Remote Series',
  first_air_date: '2024-01-01',
  last_air_date: '2024-02-01',
  status: 'Ended',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A series for remote-control journeys.',
  external_ids: { imdb_id: 'tt9' },
  vote_average: 8,
  vote_count: 1000,
  genres: [{ id: 18, name: 'Drama' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 2 },
  ],
  last_episode_to_air: { season_number: 2, episode_number: 2 },
  aggregate_credits: { cast: [], crew: [] },
};

const episodes = (season) => ({
  episodes: [1, 2].map((episode) => ({
    episode_number: episode,
    name: `Season ${season} episode ${episode}`,
    still_path: `/s${season}e${episode}.jpg`,
    runtime: 45,
    air_date: `2024-0${season}-${episode === 1 ? '01' : '08'}`,
    overview: `Episode ${episode}.`,
  })),
});

async function numericBack(page, keyCode) {
  await page.evaluate((code) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { get: () => code });
    (document.activeElement ?? window).dispatchEvent(event);
  }, keyCode);
}

async function setupSeries(page, { linked = false, playback = false } = {}) {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  if (playback) {
    // A ready release has a Play action only when this device has a playback service. Keep that capability local
    // to the source-selection journey instead of weakening its assertion to the download-only fallback.
    await page.route('**/routes', (route) =>
      route.fulfill({ json: { remux: [{ url: `${E2E_ORIGIN}/remux` }] } }),
    );
    await page.route('**/remux/health', (route) => route.fulfill({ json: { status: 'ok' } }));
  }
  await page.route('**/tmdb/3/tv/9*', (route) => route.fulfill({ json: series }));
  await page.route('**/tmdb/3/tv/9/season/**', (route) => {
    const season = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ json: episodes(season) });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#345"/></svg>',
    }),
  );
  // Enter on the title itself. Hard-reloading immediately after onboarding can abort the still-loading
  // Home Worker/WASM in WebKit, reporting unload errors unrelated to the pairing journey being checked.
  await page.goto(`${E2E_ORIGIN}/tv/9`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Remote Series', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  if (linked) {
    // A local-only library has nothing for another device to open. Saving one real row before accepting the
    // invite starts the same relay-backed guest library used by the established pairing coverage.
    const saved = page.getByRole('button', { name: 'Watchlist', exact: true });
    await saved.click();
    await expect(saved).toHaveAttribute('aria-pressed', 'true');
    await expect(saved).not.toHaveAttribute('aria-busy', 'true');
    // The invite is consumed only during application bootstrap; leave the document so this is a fresh entry.
    await page.goto('about:blank');
    await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await page
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: 'Accept this invite?' })).toBeHidden();
    await expect(page).toHaveURL(`${E2E_ORIGIN}/`);
    await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => [...edge.libraries.values()][0]?.rows.size ?? 0).toBeGreaterThan(0);
    // The relay sees the upload before the page commits its new identity and resets to Home. Do not navigate
    // during that handover; the saved title on the linked Home surface is the user-visible completion boundary.
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]').length))
      .toBe(1);
    await expect(
      page
        .getByRole('region', { name: 'Watchlist', exact: true })
        .getByRole('link', { name: /Remote Series/ }),
    ).toBeVisible({ timeout: 15_000 });
    return edge;
  }
  return edge;
}

async function installSourcePlugin(page, sourceRequests = []) {
  await page.route('**/scout/fixture-install/manifest.json', (route) =>
    route.fulfill({
      json: {
        id: 'com.den.scout',
        name: 'Fixture Scout',
        version: '1.0.0',
        resources: ['stream'],
      },
    }),
  );
  await page.route('**/scout/fixture-install/stream/series/**', (route) => {
    sourceRequests.push(decodeURIComponent(route.request().url()));
    return route.fulfill({
      json: {
        streams: [
          {
            title: 'Remote.Series.1080p.WEB.mkv',
            url: `${E2E_ORIGIN}/scout/fixture-install/play/remote-series`,
            behaviorHints: { filename: 'Remote.Series.1080p.WEB.mkv' },
            attributes: { resolution: '1080p', cached: true, seeders: 5 },
          },
        ],
      },
    });
  });
  await page.goto(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .getByRole('region', { name: 'Plugins' })
    .getByRole('textbox', { name: 'Plugin manifest URL' })
    .fill(`${E2E_ORIGIN}/scout/fixture-install/manifest.json`);
  await page.getByRole('button', { name: 'Add plugin' }).click();
  await expect(
    page.getByRole('button', { name: `More actions for ${new URL(E2E_ORIGIN).host}` }),
  ).toBeVisible({ timeout: 30_000 });
  await page.goto(`${E2E_ORIGIN}/tv/9`);
  await expect(page.getByRole('heading', { name: 'Remote Series', level: 1 })).toBeVisible();
}

test('remote changes seasons from the focused season tab', async ({ page }) => {
  await setupSeries(page);

  const season1 = page.getByRole('tab', { name: 'Season 1' });
  const season2 = page.getByRole('tab', { name: 'Season 2' });
  // Isolate the tab contract before the end-to-end journey below: the one direct focus avoids a heuristic
  // traversal hiding a single swallowed remote press.
  await season1.focus();
  await expect(season1).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowRight');
  await expect(season2).toBeFocused();
  await expect(season2).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('link', { name: 'Play episode 1: Season 2 episode 1' }),
  ).toBeVisible();

  const firstEpisode = page.getByRole('link', {
    name: 'Play episode 1: Season 2 episode 1',
  });
  const secondEpisode = page.getByRole('link', {
    name: 'Play episode 2: Season 2 episode 2',
  });
  await secondEpisode.focus();
  await page.keyboard.press('ArrowUp');
  await expect(firstEpisode).toBeFocused();

  await firstEpisode.focus();
  await page.keyboard.press('ArrowUp');
  await expect(season2).toBeFocused();
});

test('TV detail utility buttons share the large action height', async ({ page }) => {
  await setupSeries(page, { playback: true });

  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
  const seen = page.getByRole('button', { name: 'Mark watched', exact: true });
  await expect(watchlist).toBeVisible();
  await expect(seen).toBeVisible();
  const [watchlistBox, seenBox] = await Promise.all([watchlist.boundingBox(), seen.boundingBox()]);
  expect(watchlistBox).not.toBeNull();
  expect(seenBox).not.toBeNull();
  expect(watchlistBox.height).toBe(58);
  expect(watchlistBox.height).toBe(seenBox.height);

  const seasons = page.getByRole('region', { name: 'Episodes' });
  const firstEpisode = page.getByRole('link', {
    name: 'Play episode 1: Season 1 episode 1',
  });
  const episodeMenu = page.getByRole('button', { name: 'Options for episode 1' });
  const [seasonsBox, menuBox] = await Promise.all([
    seasons.boundingBox(),
    episodeMenu.boundingBox(),
  ]);
  expect(seasonsBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(seasonsBox.width).toBe(1280);
  expect(seasonsBox.x + seasonsBox.width - (menuBox.x + menuBox.width)).toBe(12);
  await expect(firstEpisode.locator('strong')).toHaveCSS('font-size', '28px');
  await expect(firstEpisode.locator('.facts')).toHaveCSS('font-size', '24px');
  await expect(page.getByRole('button', { name: 'Not for me' })).toHaveCSS('font-size', '24px');
});

test('opening a TV detail focuses Play and keeps a saved Watchlist visually secondary', async ({
  page,
}) => {
  await setupSeries(page, { playback: true });
  await installSourcePlugin(page);

  const play = page.locator('header.hero').getByRole('link', { name: 'Play', exact: true });
  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
  await watchlist.focus();
  await page.keyboard.press('Enter');
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
  const [watchlistBackground, playBackground] = await Promise.all([
    watchlist.evaluate((node) => getComputedStyle(node).backgroundColor),
    play.evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  expect(watchlistBackground).not.toBe(playBackground);

  const home = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Home', exact: true });
  await home.focus();
  await page.keyboard.press('Enter');
  // A windowed shelf holds a title as a transparent placeholder link until the row is placed, then replaces it with
  // the card. Select the card the remote lands on, not the placeholder that is about to leave the page.
  const card = page
    .getByRole('region', { name: 'Watchlist', exact: true })
    .getByRole('link', { name: /Remote Series/ })
    .and(page.locator('.card'));
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/tv\/9/);
  await expect(play).toBeFocused();
});

test('remote reveals an off-screen episode without animating every intermediate frame', async ({
  page,
}) => {
  await setupSeries(page);

  const firstEpisode = page.getByRole('link', {
    name: 'Play episode 1: Season 1 episode 1',
  });
  const secondEpisode = page.getByRole('link', {
    name: 'Play episode 2: Season 1 episode 2',
  });
  await expect(secondEpisode).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await firstEpisode.evaluate((node) => node.focus({ preventScroll: true }));
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.evaluate(() => {
    window.__episodeRevealScrolls = 0;
    window.__countEpisodeRevealScroll = () => window.__episodeRevealScrolls++;
    addEventListener('scroll', window.__countEpisodeRevealScroll, { passive: true });
  });

  await page.keyboard.press('ArrowDown');
  await expect(secondEpisode).toBeFocused();
  const result = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            removeEventListener('scroll', window.__countEpisodeRevealScroll);
            const box = document.activeElement?.getBoundingClientRect();
            resolve({
              events: window.__episodeRevealScrolls,
              scrollY,
              fullyVisible: !!box && box.top >= 0 && box.bottom <= innerHeight,
            });
          }),
        ),
      ),
  );
  expect(result.fullyVisible).toBe(true);
  expect(result.scrollY).toBeGreaterThan(0);
  expect(result.events).toBeLessThanOrEqual(2);
});

test('season download asks for its target instead of inheriting the focused tab', async ({
  page,
}) => {
  const sourceRequests = [];
  await setupSeries(page);
  await installSourcePlugin(page, sourceRequests);

  const season2 = page.getByRole('tab', { name: 'Season 2' });
  await season2.focus();
  await page.keyboard.press('Enter');
  await expect(season2).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('link', { name: 'Play episode 1: Season 2 episode 1' }),
  ).toBeVisible();
  sourceRequests.length = 0;

  const download = page.getByRole('button', { name: 'Download a season' });
  const [downloadIcon, downloadLabel] = await Promise.all([
    download.locator('svg').boundingBox(),
    download.getByText('Download', { exact: true }).boundingBox(),
  ]);
  expect(downloadIcon).not.toBeNull();
  expect(downloadLabel).not.toBeNull();
  expect(
    Math.abs(
      downloadIcon.y + downloadIcon.height / 2 - (downloadLabel.y + downloadLabel.height / 2),
    ),
  ).toBeLessThan(2);
  await download.focus();
  await page.keyboard.press('Enter');
  const firstSeason = page.getByRole('menuitem', { name: 'Season 1', exact: true });
  await expect(firstSeason).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(season2).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toContainText('2 already ready');
  await expect.poll(() => sourceRequests.some((url) => url.includes('tt9:1:'))).toBe(true);
  expect(sourceRequests.some((url) => url.includes('tt9:2:'))).toBe(false);
});

test('watched action chooses a season without changing the episode tab', async ({ page }) => {
  await setupSeries(page);
  const season2 = page.getByRole('tab', { name: 'Season 2' });
  await season2.focus();
  await page.keyboard.press('Enter');
  await expect(season2).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /Mark season 2/ })).toHaveCount(0);

  const seen = page.getByRole('button', { name: 'Mark watched', exact: true });
  await expect(seen).toHaveCSS('display', 'flex');
  const [seenIcon, seenLabel] = await Promise.all([
    seen.locator('svg').boundingBox(),
    seen.getByText('Seen', { exact: true }).boundingBox(),
  ]);
  expect(seenIcon).not.toBeNull();
  expect(seenLabel).not.toBeNull();
  expect(
    Math.abs(seenIcon.y + seenIcon.height / 2 - (seenLabel.y + seenLabel.height / 2)),
  ).toBeLessThan(2);
  await seen.focus();
  await page.keyboard.press('Enter');
  const season1 = page.getByRole('menuitemcheckbox', { name: 'Season 1', exact: true });
  await expect(season1).toHaveAttribute('aria-checked', 'false');
  await season1.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByText('2 of 4 watched', { exact: true })).toBeVisible();
  await expect(season2).toHaveAttribute('aria-selected', 'true');
  await seen.focus();
  await page.keyboard.press('Enter');
  await expect(season1).toHaveAttribute('aria-checked', 'true');
});

test('remote reaches the actions on a saved title without hover', async ({ page }) => {
  await setupSeries(page);

  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
  await watchlist.focus();
  await page.keyboard.press('Enter');
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');

  await page.goto(`${E2E_ORIGIN}/watchlist`);
  const card = page.getByRole('link', { name: /Remote Series/ }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.focus();
  await page.keyboard.press('ArrowUp');
  const markWatched = page.getByRole('button', { name: 'Mark watched Remote Series' });
  await expect(markWatched).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Watched' }).getByRole('link', { name: /Remote Series/ }),
  ).toBeVisible();
});

test('pairing keeps remote focus as its code becomes an approval', async ({ browser, page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.ClipboardItem = class RefusesPromisedBlob {
      constructor() {
        throw new TypeError('This engine accepts a Blob, not a promised Blob');
      }
    };
  });
  const edge = await setupSeries(page, { linked: true });
  // Accepting the invite has just started the household Worker. Enter Settings as the TV does instead of tearing
  // that Worker down with an immediate hard navigation while WebKit is still completing its IndexedDB transaction.
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${E2E_ORIGIN}/settings`);

  const linkedDevices = page.getByRole('button', { name: /Linked devices/ });
  await linkedDevices.focus();
  await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: 'Linked devices' });
  const getCode = region.getByRole('button', { name: 'Get a code' });
  await getCode.focus();
  await page.keyboard.press('Enter');

  const code = region.locator('.code[role="button"]');
  await expect(code).toBeVisible();
  await expect(code).toBeFocused();
  const codeText = await code.textContent();

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const joiner = await context.newPage();
    await routeGuestEdge(joiner, edge);
    await joiner.goto(E2E_ORIGIN);
    await joiner.getByLabel('Link code, twelve characters').fill(codeText ?? '');
    await joiner.getByLabel('This device’s name').fill('Bedroom TV');
    await joiner.getByRole('button', { name: 'Link', exact: true }).click();

    const allow = region.getByRole('button', { name: 'Allow', exact: true });
    await expect(allow).toBeVisible();
    await expect(allow).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(joiner.getByRole('heading', { name: 'Open your Den library' })).toBeHidden();
    await expect(region.getByRole('button', { name: 'Get a code' })).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a promised-Blob clipboard refusal cannot strand a failed pairing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.ClipboardItem = class RefusesPromisedBlob {
      constructor() {
        throw new TypeError('This engine accepts a Blob, not a promised Blob');
      }
    };
  });
  await setupSeries(page, { linked: true });
  await page.route('**/pair/new', (route) => route.fulfill({ status: 503, json: {} }));
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: /Linked devices/ }).click();
  const region = page.getByRole('region', { name: 'Linked devices' });
  await region.getByRole('button', { name: 'Get a code' }).click();
  await expect(region.getByText('Too many pairings started here just now.')).toBeVisible();
  await expect(region.getByRole('button', { name: 'Get a code' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('hardware Back leaves recovery editing, then closes its Settings row', async ({ page }) => {
  // Focus restoration gives up after its own 1.5 s timer (`tv/navigation.ts`): the test moves the clock past it.
  await page.clock.install();
  await setupSeries(page);
  await page.goto(`${E2E_ORIGIN}/settings`);

  const recoveryRow = page.getByRole('button', { name: /Recovery code/ });
  await recoveryRow.focus();
  await page.keyboard.press('Enter');
  await expect(recoveryRow).toHaveAttribute('aria-expanded', 'true');

  const recoveryCode = page.getByRole('region', { name: 'Recovery code' }).getByRole('textbox');
  await recoveryCode.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('ABCD');
  await numericBack(page, 461);
  await expect(recoveryCode).toBeFocused();
  await expect(recoveryRow).toHaveAttribute('aria-expanded', 'true');

  await numericBack(page, 461);
  await expect(recoveryRow).toHaveAttribute('aria-expanded', 'false');
  await page.clock.runFor(1_600);
  await expect(recoveryRow).toBeFocused();
});

test('episode Sources hands remote focus to the ranked source choices', async ({
  page,
}, testInfo) => {
  await setupSeries(page, { playback: true });
  await installSourcePlugin(page);

  const search = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', {
    name: 'Search',
    exact: true,
  });
  const titlePlay = page.locator('header.hero').getByRole('link', { name: 'Play', exact: true });
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(titlePlay).toBeFocused();

  const episodeMenu = page.getByRole('button', { name: 'Options for episode 1' });
  await expect(episodeMenu).toBeVisible({ timeout: 30_000 });
  await episodeMenu.focus();
  await page.keyboard.press('Enter');
  const sourcesAction = page.getByRole('menuitem', { name: 'Sources', exact: true });
  await expect(sourcesAction).toBeVisible();
  await sourcesAction.focus();
  await page.keyboard.press('Enter');

  const disclosure = page.getByRole('button', { name: /Sources, 1 available/ });
  await expect(disclosure).toBeFocused();
  const play = page
    .getByRole('listitem')
    .filter({ hasText: 'Remote.Series.1080p.WEB.mkv' })
    .getByRole('link', { name: 'Play', exact: true });
  await expect(play).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(play).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('sources-focus.png') });
  await page.keyboard.press('ArrowUp');
  await expect(disclosure).toBeFocused();
});

test('episode overflow exposes the Apple TV actions without a TV handoff', async ({ page }) => {
  await setupSeries(page);
  await installSourcePlugin(page);

  const options = page.getByRole('button', { name: 'Options for episode 1' });
  await options.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Sources', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Start download', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Play on TV', exact: true })).toHaveCount(0);

  const mark = page.getByRole('menuitem', { name: 'Mark watched', exact: true });
  await mark.focus();
  await page.keyboard.press('Enter');
  await expect(mark).toHaveCount(0);
  // The menu closes immediately; wait for the library write to come back before asserting the next menu state.
  await expect(page.getByText('1 of 4 watched', { exact: true })).toBeVisible();
  await options.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Mark unwatched', exact: true })).toBeVisible();

  const start = page.getByRole('menuitem', { name: 'Start download', exact: true });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('This episode is already ready to play.', { exact: true }),
  ).toBeVisible();
});
