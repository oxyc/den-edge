// Episode release dates from atlas (`GET /airing/tv/{id}` for one series, `POST /airing` for a followed library; TVmaze's
// schedule) through the real app, with the clock on
// Saturday 31 Oct 2026. Dexter: Resurrection's S2E1 was on Paramount+ on Friday 30 Oct while TMDB dated it by the
// broadcaster's Sunday slot, 1 Nov. Every answer is a recorded fixture; nothing leaves the browser.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { airingBatch, routeTmdb } from './network.mjs';

const ID = 259909;
const IMDB = 'tt33043892';
const AIRING = JSON.parse(
  readFileSync(new URL('../test/fixtures/airing-dexter.json', import.meta.url), 'utf8'),
);
/** Saturday 31 Oct 2026, midday. */
const SATURDAY = new Date(2026, 9, 31, 12);

const series = {
  id: ID,
  name: 'Dexter: Resurrection',
  first_air_date: '2025-07-11',
  status: 'Returning Series',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'Dexter Morgan wakes up from a coma.',
  external_ids: { imdb_id: IMDB },
  vote_average: 8.2,
  vote_count: 400,
  genres: [{ id: 80, name: 'Crime' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 3 },
  ],
  // TMDB has not counted S2E1 as aired: its date is Sunday's.
  last_episode_to_air: { season_number: 1, episode_number: 2 },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
const seasons = {
  1: [
    { episode_number: 1, name: 'A Beating Heart', air_date: '2025-07-11' },
    { episode_number: 2, name: 'Camera Shy', air_date: '2025-07-18' },
  ],
  2: [
    { episode_number: 1, name: 'Risky Business', air_date: '2026-11-01' },
    { episode_number: 2, name: 'Young Blood', air_date: '2026-11-08' },
    { episode_number: 3, name: 'Three', air_date: '2026-11-15' },
  ],
};

/** A finished series the followed library has watched too, which TVmaze has no show for. */
const ENDED = 1396;
const ended = {
  id: ENDED,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  status: 'Ended',
  poster_path: '/ended.jpg',
  vote_average: 8.9,
  vote_count: 9000,
  seasons: [{ season_number: 1, name: 'Season 1', episode_count: 7 }],
  last_episode_to_air: { season_number: 1, episode_number: 7 },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};

/** A film part watched, which Continue Watching orders by its own activity. */
const FILM = 550;
const film = {
  id: FILM,
  title: 'Fight Club',
  release_date: '1999-10-15',
  poster_path: '/film.jpg',
  vote_average: 8.4,
  vote_count: 9000,
  genres: [{ id: 18, name: 'Drama' }],
  credits: { cast: [] },
  recommendations: { results: [] },
};

/**
 * TMDB as recorded for the series, and atlas's manifest and airing answers for it (the GET for one series, the batch
 * for a followed library); every other atlas route is 404. Returns each airing request, as `<METHOD> <path>` and, for
 * the batch, the series it named.
 */
async function routeSeries(page, answer = AIRING) {
  const airing = [];
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/tv/${ENDED}`)) return route.fulfill({ json: ended });
    if (path.endsWith(`/movie/${FILM}`)) return route.fulfill({ json: film });
    const season = path.match(new RegExp(`/tv/${ID}/season/(\\d+)$`));
    if (season)
      return route.fulfill({
        json: {
          episodes: (seasons[season[1]] ?? []).map((e) => ({ ...e, overview: 'An episode.' })),
        },
      });
    if (path.endsWith(`/tv/${ID}/external_ids`)) return route.fulfill({ json: { imdb_id: IMDB } });
    if (path.endsWith(`/tv/${ID}`)) return route.fulfill({ json: series });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.route(`${E2E_ORIGIN}/atlas/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } });
    if (url.pathname === '/atlas/airing' && route.request().method() === 'POST') {
      const named = route
        .request()
        .postDataJSON()
        .series.map(({ tmdb }) => tmdb);
      airing.push(`POST /atlas/airing ${named.join(',')}`);
      return route.fulfill({
        json: airingBatch(route.request(), (tmdb) => (tmdb === ID ? answer : null)),
      });
    }
    if (url.pathname === `/atlas/airing/tv/${ID}`) {
      airing.push(`${route.request().method()} ${url.pathname}${url.search}`);
      return route.fulfill({
        headers: { 'cache-control': 'public, max-age=21600' },
        json: answer,
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return airing;
}

test('a series page dates its episodes by atlas: out on Paramount+, and Returning', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  await routeGuestEdge(page, newEdge());
  const airing = await routeSeries(page);
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  await page.goto(`${E2E_ORIGIN}/tv/${ID}-dexter-resurrection?season=2`);
  const active = page.locator('[data-route-page][data-active="true"]');
  const episode = (n) => active.locator(`.episode[data-episode="${n}"]`);

  // E2 is TMDB's 8 Nov, atlas's Friday 6 Nov on Paramount+.
  await expect(episode(2).locator('[data-out]')).toHaveText(/^Out Fri, Nov 6 on Paramount\+$/, {
    timeout: 30_000,
  });
  // E1 was out yesterday by atlas's date, though TMDB says tomorrow: no air date, playable like any aired one.
  await expect(episode(1)).toContainText('Risky Business');
  await expect(episode(1).locator('.air-date')).toHaveCount(0);
  await expect(episode(1).locator('.episode-play')).not.toHaveAttribute('aria-disabled', 'true');
  // E3 is dated by atlas too (13 Nov), still a week out.
  await expect(episode(3).locator('[data-out]')).toHaveText(/^Out Fri, Nov 13 on Paramount\+$/);
  await expect(active.locator('[data-series-status]')).toHaveText('Returning');
  // One GET per series, with the IMDb id as TVmaze's lookup hint.
  expect(airing).toContain(`GET /atlas/airing/tv/${ID}?imdb=${IMDB}`);
});

test('without atlas’s answer the page keeps TMDB’s dates', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  await routeGuestEdge(page, newEdge());
  await routeSeries(page);
  await page.route(`${E2E_ORIGIN}/atlas/airing/**`, (route) =>
    route.fulfill({
      status: 404,
      headers: { 'cache-control': 'public, max-age=21600' },
      json: { error: 'not_found' },
    }),
  );
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  await page.goto(`${E2E_ORIGIN}/tv/${ID}-dexter-resurrection?season=2`);
  const active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.locator('.episode[data-episode="1"] .air-date')).toHaveText(
    'Airs Nov 1, 2026',
    { timeout: 30_000 },
  );
  await expect(active.locator('[data-out]')).toHaveCount(0);
  await expect(active.locator('[data-series-status]')).toHaveCount(0);
});

const HEARTH = `${E2E_ORIGIN}/den/hearthcfg/manifest.json`;

/**
 * A library kept in this browser that has watched season 1, and all of a finished series, with the combined Den addon
 * installed: its list for S2E`searched` (the newest released) is empty until a fresh search (`?fresh=1`) finds a
 * release. Every search for it is kept on `searches`, every airing request on `airing`. `behind` leaves S1E2
 * unwatched; `recent` has a film part watched an hour ago, so its Continue Watching entry is newer than the followed
 * series'; `answer` is atlas's airing answer for it.
 */
async function followedLibrary(
  page,
  {
    started = false,
    caughtUp = false,
    behind = false,
    recent = false,
    answer = AIRING,
    searched = 1,
    dismissedAgo,
  } = {},
) {
  const searches = [];
  const airing = await routeSeries(page, answer);
  await page.route(`${E2E_ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${E2E_ORIGIN}/routes`, (route) =>
    route.fulfill({ json: { v: 1, addons: { den: [{ url: `${E2E_ORIGIN}/den` }] } } }),
  );
  await page.route(`${E2E_ORIGIN}/den/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/den/hearthcfg/manifest.json')
      return route.fulfill({
        json: { id: 'com.den.hearth', version: '1.0.0', resources: ['stream'] },
      });
    if (url.pathname === '/den/health') return route.fulfill({ json: { status: 'ok' } });
    // The addon plays through den-edge's unified playback, so the billboard offers Play.
    if (url.pathname === '/den/hearthcfg/playback' && route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204 });
    const stream = decodeURIComponent(url.pathname).match(
      new RegExp(`^/den/hearthcfg/stream/series/${IMDB}:2:(\\d+)\\.json$`),
    );
    if (stream && Number(stream[1]) === searched) {
      searches.push(url.search);
      const fresh = url.searchParams.get('fresh') === '1';
      return route.fulfill({
        headers: { 'cache-control': 'private, max-age=300' },
        json: {
          streams: fresh
            ? [
                {
                  title: 'Dexter.Resurrection.S02E01.1080p.WEB.mkv',
                  url: `${E2E_ORIGIN}/den/p/ticket`,
                  behaviorHints: { filename: 'Dexter.Resurrection.S02E01.1080p.WEB.mkv' },
                  attributes: { cached: true, resolution: '1080p' },
                },
              ]
            : [],
          den: { v: 1, answerKind: fresh ? 'live' : 'empty', coverage: { sources: [] } },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  await page.evaluate(
    ({ install, id, ended, film, started, caughtUp, behind, recent, dismissedAgo }) => {
      const at = [Date.now() - 86_400_000, 0, 'aaaaaaaaaaaaaaaa'];
      const hourAgo = [Date.now() - 3_600_000, 0, 'aaaaaaaaaaaaaaaa'];
      const progress = (value) => ({
        progress: { value, at, viewing: 0 },
        imported: false,
        // Beside a dismissal, a finished episode carries its play: the time it was watched, which the dismissal is
        // weighed against.
        plays: dismissedAgo !== undefined && value >= 1 ? { 0: at[0] } : {},
        cleared: null,
      });
      const watched = progress(1);
      return window.denSeed([
        ...(started || caughtUp
          ? [
              {
                format: 4,
                kind: 'season',
                title: { type: 'tv', id },
                season: 2,
                seasonReset: null,
                episodes: { 1: progress(caughtUp ? 1 : 0.3) },
              },
            ]
          : []),
        {
          kind: 'set',
          schema: 2,
          name: 'plugins',
          values: { [install]: { value: { bool: true }, at } },
        },
        {
          format: 4,
          kind: 'title',
          title: { type: 'tv', id },
          status: { value: 'watched', at },
          addedAt: Date.now() - 100 * 86_400_000,
          ...(dismissedAgo === undefined
            ? {}
            : {
                dismissed: {
                  value: true,
                  at: [Date.now() - dismissedAgo, 0, 'aaaaaaaaaaaaaaaa'],
                },
              }),
        },
        {
          format: 4,
          kind: 'season',
          title: { type: 'tv', id },
          season: 1,
          seasonReset: null,
          episodes: behind ? { 1: watched } : { 1: watched, 2: watched },
        },
        {
          format: 4,
          kind: 'title',
          title: { type: 'tv', id: ended },
          status: { value: 'watched', at },
          addedAt: Date.now() - 400 * 86_400_000,
        },
        ...(recent
          ? [
              {
                format: 4,
                kind: 'title',
                title: { type: 'movie', id: film },
                status: { value: 'inProgress', at: hourAgo },
                resume: { value: 0.4, at: hourAgo, viewing: 0 },
                addedAt: hourAgo[0],
              },
            ]
          : []),
      ]);
    },
    {
      install: HEARTH,
      id: ID,
      ended: ENDED,
      film: FILM,
      started,
      caughtUp,
      behind,
      recent,
      dismissedAgo,
    },
  );
  return { searches, airing };
}

test('a caught-up series stays in Continue Watching while its next episode is due', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  // S2E1, the only episode of season 2 out, was watched yesterday; atlas dates S2E2 Friday 6 Nov.
  const { airing } = await followedLibrary(page, { caughtUp: true });
  await page.goto(`${E2E_ORIGIN}/`);

  const shelf = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: 'Continue Watching' }),
  });
  const card = shelf.locator('.poster-card, a').filter({ hasText: 'Out Fri, Nov 6' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).not.toContainText('New');
  // Nothing of it is out to play: the card opens the series page.
  await expect(shelf.locator(`a[href="/tv/${ID}-dexter-resurrection"]`).first()).toBeVisible();
  await expect(page.locator('.billboard')).not.toContainText('New episode');
  // Coming up has it too: one row for episodes and premieres alike.
  const coming = page.getByRole('region', { name: 'Coming up' });
  await expect(
    coming.locator('.poster-card, a').filter({ hasText: 'New episode · Fri, Nov 6' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: /This week|Coming back soon/ })).toHaveCount(0);
  // Home asked about each series it might follow, once. The finished series watched by its title alone, with no
  // episode watched, is not one: nothing says it was watched up to its newest episode.
  const asked = airing.flatMap((line) =>
    line.startsWith('POST ')
      ? line.split(' ')[2].split(',').map(Number)
      : [Number(/\/tv\/(\d+)/.exec(line)?.[1])],
  );
  expect(asked).toEqual([ID]);
});

/** Continue Watching's cards in order, as `tv:<id>`/`movie:<id>`. */
async function continueOrder(page) {
  return page
    .locator('.windowed')
    .filter({ has: page.getByRole('heading', { name: 'Continue Watching' }) })
    .locator('[data-card-index]')
    .evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-route-focus-key')));
}

test('a followed series’ new episode leads the billboard and Continue Watching, marked new', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  // Season 1 finished yesterday, a film watched an hour ago: caught up, Dexter moves ahead of it.
  const { searches, airing } = await followedLibrary(page, { recent: true });
  await page.goto(`${E2E_ORIGIN}/`);

  // A fresh search, the list only, found S2E1: the billboard's first slide says so, with Play.
  const billboard = page.locator('.billboard');
  await expect(billboard.locator('.slide').first()).toContainText('New episode · S2E1', {
    timeout: 30_000,
  });
  await expect(billboard.locator('.slide').first()).toContainText('Dexter: Resurrection');
  await expect(
    billboard.locator('.slide').first().getByRole('link', { name: 'Play', exact: true }),
  ).toHaveAttribute('href', `/tv/${ID}-dexter-resurrection?play=1`);
  expect(searches).toContain('?fresh=1');

  // Continue Watching leads with it too: the next episode is S2E1, badged New.
  const shelf = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: 'Continue Watching' }),
  });
  const card = shelf.locator('.poster-card, a').filter({ hasText: 'S2 · E1' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('New');
  await expect.poll(() => continueOrder(page)).toEqual([`tv:${ID}`, `movie:${FILM}`]);
  // Found once is enough: the episode is not searched for afresh again while Home stays open.
  expect(searches.filter((search) => search === '?fresh=1')).toHaveLength(1);
  expect(airing.some((asked) => asked.includes(String(ID)))).toBe(true);
});

/**
 * A viewer behind on Dexter, whose entry is `caption`: told of no new episode anywhere. Not searched for, no billboard
 * slide, no badge, and Dexter stays after the film watched more recently.
 */
async function expectBehind(page, searches, caption) {
  const shelf = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: 'Continue Watching' }),
  });
  const card = shelf.locator('.poster-card, a').filter({ hasText: caption }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => continueOrder(page)).toEqual([`movie:${FILM}`, `tv:${ID}`]);
  // Past the moment Home lets Continue Watching land before it searches (`SEARCH_SETTLE_MS`).
  await page.waitForTimeout(3_000);
  expect(searches).not.toContain('?fresh=1');
  await expect(page.locator('.billboard')).not.toContainText('New episode');
  await expect(card).not.toContainText('New');
  expect(await continueOrder(page)).toEqual([`movie:${FILM}`, `tv:${ID}`]);
  // Not followed: its next episode, out within the month, is on no airing row.
  await expect(
    page.getByRole('region', { name: /Coming up|This week|Coming back soon/ }),
  ).toHaveCount(0);
}

/** Dexter caught up to its new episode `code`: the billboard leads with it and so does the row, `caption`, badged New. */
async function expectLeads(page, searches, code, caption) {
  await expect(page.locator('.billboard .slide').first()).toContainText(`New episode · ${code}`, {
    timeout: 30_000,
  });
  expect(searches).toContain('?fresh=1');
  const shelf = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: 'Continue Watching' }),
  });
  const card = shelf.locator('.poster-card, a').filter({ hasText: caption }).first();
  await expect(card).toContainText('New');
  await expect.poll(() => continueOrder(page)).toEqual([`tv:${ID}`, `movie:${FILM}`]);
}

test('a new episode is not announced for a series the viewer is behind on', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  // S1E2 is aired and unwatched when S2E1 comes out, as Grey's Anatomy was left seasons back.
  const { searches } = await followedLibrary(page, { behind: true, recent: true });
  await page.goto(`${E2E_ORIGIN}/`);
  await expectBehind(page, searches, 'S1 · E2');
});

/**
 * Season 2 a week further on: S2E1 out Friday 23 Oct, S2E2 Friday 30 Oct. The clock stays on the 31st rather than
 * moving a week on: with the page clock past the real date the seeded marks fell off the row, presumably because the
 * library Worker does not share the page's fixed clock.
 */
const WEEKLY = {
  ...AIRING,
  next: { season: 2, episode: 3, name: 'Three', date: '2026-11-06' },
  previous: { season: 2, episode: 2, name: 'Young Blood', date: '2026-10-30' },
  upcoming: [{ season: 2, episode: 3, date: '2026-11-06' }],
  seasonPremiere: { season: 2, date: '2026-10-23' },
};

test('weekly, behind: S2E1 unwatched when S2E2 comes out is not new', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  const { searches } = await followedLibrary(page, { recent: true, answer: WEEKLY, searched: 2 });
  await page.goto(`${E2E_ORIGIN}/`);
  await expectBehind(page, searches, 'S2 · E1');
});

test('weekly, caught up: S2E1 watched, S2E2 leads', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  const { searches } = await followedLibrary(page, {
    caughtUp: true,
    recent: true,
    answer: WEEKLY,
    searched: 2,
  });
  await page.goto(`${E2E_ORIGIN}/`);
  await expectLeads(page, searches, 'S2E2', 'S2 · E2');
});

test('a season out at once leads for a viewer who finished the one before', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  // All of season 2 out on Friday 30 Oct: the newest out is S2E3, and the row offers S2E1.
  const drop = {
    ...AIRING,
    next: null,
    previous: { season: 2, episode: 3, name: 'Three', date: '2026-10-30' },
    upcoming: [],
    seasonPremiere: { season: 2, date: '2026-10-30' },
  };
  // S2E1 is what plays, so it is what is searched for and what the billboard names, never the finale.
  const { searches } = await followedLibrary(page, { recent: true, answer: drop, searched: 1 });
  await page.goto(`${E2E_ORIGIN}/`);
  await expectLeads(page, searches, 'S2E1', 'S2 · E1');
  await expect(page.locator('.billboard')).not.toContainText('S2E3');
  await expect(
    page.locator('.billboard .slide').first().getByRole('link', { name: 'Play', exact: true }),
  ).toHaveAttribute('href', `/tv/${ID}-dexter-resurrection?play=1`);
});

test('Remove on Coming up takes a series off every airing surface until it is watched again', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  // Season 1 finished, S2E1 just out and found: new, on Continue Watching and Coming up (S2E2 next Friday).
  await followedLibrary(page, { recent: true });
  await page.goto(`${E2E_ORIGIN}/`);
  const billboard = page.locator('.billboard');
  await expect(billboard.locator('.slide').first()).toContainText('New episode · S2E1', {
    timeout: 30_000,
  });
  const coming = page.getByRole('region', { name: 'Coming up' });
  await expect(
    coming.locator('.poster-card, a').filter({ hasText: 'New episode · Fri, Nov 6' }),
  ).toBeVisible();
  await expect.poll(() => continueOrder(page)).toEqual([`tv:${ID}`, `movie:${FILM}`]);

  await coming.getByRole('button', { name: 'Actions for Dexter: Resurrection' }).click();
  await page
    .getByRole('menu', { name: 'Actions for Dexter: Resurrection' })
    .getByRole('menuitem', { name: 'Remove from Coming up' })
    .click();
  await expect(page.getByRole('status').or(page.getByRole('alert')).first()).toContainText(
    'Removed “Dexter: Resurrection” from Coming up',
  );
  // Off Coming up, off Continue Watching, and no longer announced.
  await expect(coming).toHaveCount(0);
  await expect.poll(() => continueOrder(page)).toEqual([`movie:${FILM}`]);
  await expect(billboard).not.toContainText('New episode');
  // Kept: a reload still has it off every one of them.
  await page.reload();
  await expect.poll(() => continueOrder(page), { timeout: 30_000 }).toEqual([`movie:${FILM}`]);
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('region', { name: 'Coming up' })).toHaveCount(0);
  await expect(billboard).not.toContainText('New episode');
});

test('a series taken off before it was last watched is back on every airing surface', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  // Taken off two days ago, then season 1 finished yesterday: the dismissal is older than the viewer's last watch.
  await followedLibrary(page, { recent: true, dismissedAgo: 2 * 86_400_000 });
  await page.goto(`${E2E_ORIGIN}/`);
  await expect(page.locator('.billboard .slide').first()).toContainText('New episode · S2E1', {
    timeout: 30_000,
  });
  const coming = page.getByRole('region', { name: 'Coming up' });
  await expect(
    coming.locator('.poster-card, a').filter({ hasText: 'New episode · Fri, Nov 6' }),
  ).toBeVisible();
  await expect.poll(() => continueOrder(page)).toEqual([`tv:${ID}`, `movie:${FILM}`]);
});

test('a new episode the viewer has started is not new: no slide, no badge, no search', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  const { searches } = await followedLibrary(page, { started: true });
  await page.goto(`${E2E_ORIGIN}/`);
  // It is simply being watched: Continue Watching resumes it, unbadged.
  const card = page.locator('.poster-card, a').filter({ hasText: 'S2 · E1' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).not.toContainText('New');
  await expect(page.locator('.billboard')).not.toContainText('New episode');
  // Past the moment Home lets Continue Watching land before it searches (`SEARCH_SETTLE_MS`).
  await page.waitForTimeout(3_000);
  expect(searches).not.toContain('?fresh=1');
});
