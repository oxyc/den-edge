import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const film = (id, title = `Film ${id}`) => ({
  id,
  title,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
});
const films = Array.from({ length: 30 }, (_, i) => film(100 + i));
const active = (page) => page.locator('[data-route-page][data-active="true"]');
const input = (page) =>
  page.getByRole('searchbox', { name: 'Search titles, people, moods, languages…' });
// The fixture is a file on the dev server, so its own path is where Home lives: the app reads the path, and
// returning Home returns to the address the document was opened at.
const FIXTURE = 'http://127.0.0.1:5198/test/nav-search.html';
const HOME = /\/test\/nav-search\.html$/;
async function setup(page, { atlasGate, catalogueGate, searchGate } = {}) {
  await guardNetwork(page);
  const queries = [];
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', async (r) => {
    if (!atlasGate) return r.fulfill({ status: 404 });
    await atlasGate;
    return r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } });
  });
  await page.route('**/atlas/catalog/**', async (r) => {
    await catalogueGate;
    return r.fulfill({ json: { metas: [] } });
  });
  // Once atlas is found it ranks the billboard itself.
  await page.route('**/atlas/recommend', async (r) => {
    await catalogueGate;
    return r.fulfill({ json: { version: 1, slides: [] } });
  });
  // Search and the browse rows ask atlas's indexes.
  await page.route('**/atlas/index/**', (r) =>
    r.fulfill({
      json: r.request().url().includes('suggest') ? { perSeed: [], pooled: [] } : { labels: [] },
    }),
  );
  // atlas's stackable filters aren't deployed: a 404, as live, unless a test serves them.
  await page.route('**/atlas/index/filter/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>',
    }),
  );
  await routeTmdb(page, async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.includes('/search/')) {
      const q = url.searchParams.get('query');
      queries.push(q);
      await searchGate?.(q);
      return r.fulfill({
        json: {
          results: q.startsWith('empty')
            ? []
            : q.startsWith('Slow')
              ? [film(999, 'Slow result')]
              : films,
          total_pages: 1,
        },
      });
    }
    const match = /\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (match)
      return r.fulfill({
        json: {
          ...film(Number(match[2])),
          overview: 'A movie description.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: { cast: [] },
          recommendations: { results: [] },
        },
      });
    return r.fulfill({ json: { results: films, total_pages: 1 } });
  });
  return queries;
}
async function openSearch(page, width) {
  if (width < 760) await page.getByRole('button', { name: 'Search', exact: true }).click();
  else await input(page).click();
  // Reopening search returns to the search it was left on, so the query rides along in the address.
  await expect(page).toHaveURL(/\/search(\?.*)?$/);
  await expect(input(page)).toBeFocused();
}

for (const width of [320, 390, 1280])
  test(`navbar search preserves Home and result history at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 760,
        reducedMotion: 'reduce',
      });
      let documents = 0;
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents++;
      });
      const queries = await setup(page);
      await page.goto(FIXTURE);
      await expect(active(page).locator('.billboard .slide').first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (width < 760) {
        const bar = await page.locator('.bar').boundingBox();
        const search = await page
          .getByRole('button', { name: 'Search', exact: true })
          .boundingBox();
        expect(search.x + search.width).toBeLessThanOrEqual(bar.x + bar.width - 4);
      }
      await page.screenshot({ path: test.info().outputPath(`navbar-${width}.png`) });
      await active(page).locator('.billboard .dot').nth(1).click();
      await page.evaluate(() => {
        window.homeHero = document.querySelector('.billboard');
        scrollTo(0, 700);
      });
      const homeY = await page.evaluate(() => scrollY);
      expect(homeY).toBeGreaterThan(300);
      const closedBar = width < 760 ? await page.locator('.bar').boundingBox() : null;
      await openSearch(page, width);
      if (width < 760) {
        const geometry = await page.evaluate(() => {
          const bar = document.querySelector('.bar');
          const form = document.querySelector('form.search');
          const field = form.querySelector('input');
          const rect = (element) => {
            const box = element.getBoundingClientRect();
            return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
          };
          return {
            position: getComputedStyle(bar).position,
            bar: rect(bar),
            form: rect(form),
            field: rect(field),
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.position, 'focused iOS input leaves the fixed formatting context').toBe(
          'absolute',
        );
        expect(Math.abs(geometry.bar.top - closedBar.y)).toBeLessThanOrEqual(1);
        expect(geometry.field.top).toBeGreaterThanOrEqual(geometry.form.top);
        expect(geometry.field.bottom).toBeLessThanOrEqual(geometry.form.bottom);
        expect(geometry.form.left).toBeGreaterThanOrEqual(geometry.bar.left);
        expect(geometry.form.right).toBeLessThanOrEqual(geometry.bar.right);
        expect(geometry.scrollWidth).toBe(width);
      }
      await input(page).fill('Neon');
      // Explore's grid shows the same fixture films, so wait for the search itself to answer.
      await expect(page).toHaveURL(/\/search\?q=Neon$/);
      await expect(
        active(page).getByRole('heading', { name: 'Search', exact: true }),
      ).toBeVisible();
      await expect(active(page).getByRole('link', { name: 'Film 108 2026' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (width < 760) {
        const editingBar = await page.locator('.bar').boundingBox();
        expect(Math.abs(editingBar.y - closedBar.y)).toBeLessThanOrEqual(1);
        await expect(input(page)).toBeInViewport();
      }
      await page.screenshot({ path: test.info().outputPath(`search-${width}.png`) });
      const card = active(page).getByRole('link', { name: 'Film 108 2026' });
      await card.scrollIntoViewIfNeeded();
      const searchY = await page.evaluate(() => scrollY);
      const count = queries.length;
      await card.click();
      await expect(active(page).locator('h1')).toHaveText('Film 108');
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.goBack();
      await expect(input(page)).toHaveValue('Neon');
      await expect(active(page).getByRole('link', { name: 'Film 108 2026' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(searchY);
      expect(queries.length).toBe(count);
      await page.goBack();
      await expect(page).toHaveURL(HOME);
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(homeY);
      expect(
        await page.evaluate(
          () => document.querySelector('[data-active="true"] .billboard') === window.homeHero,
        ),
      ).toBe(true);
      await expect(active(page).locator('.billboard .dot').nth(1)).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      if (width < 760) {
        await expect(input(page)).toBeHidden();
        await openSearch(page, width);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page).toHaveURL(HOME);
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(homeY);
        await expect(input(page)).toBeHidden();
        await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
      }
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await openSearch(page, width);
      await input(page).fill('empty');
      await expect(active(page).getByText('No matches.', { exact: true })).toBeVisible();
      await input(page).fill('');
      await expect(
        active(page).getByRole('heading', { name: 'Explore', exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
      expect(documents).toBe(1);
    } finally {
      await browser.close();
    }
  });

test('a late search cannot replace a newer query', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    let release;
    const slow = new Promise((r) => (release = r));
    const queries = await setup(page, {
      searchGate: (q) => (q.startsWith('Slow') ? slow : Promise.resolve()),
    });
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    await input(page).fill('Slow');
    await expect.poll(() => queries.includes('Slow')).toBe(true);
    await input(page).fill('Neon');
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    const response = page.waitForResponse((r) => r.url().includes('query=Slow'));
    release();
    await response;
    await expect(active(page).getByRole('link', { name: 'Slow result 2026' })).toHaveCount(0);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(HOME);
  } finally {
    await browser.close();
  }
});

// Each chip and Movies/Series switch is its own history entry, so a Cancel that stepped back once walked
// through every pick, one tap each, before it ever left Search.
test('Cancel leaves Search in one tap, however many picks were made in it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    const chip = (name) => active(page).getByRole('button', { name, exact: true });
    await chip('Action').click();
    await expect(page).toHaveURL(/\/search\?c=genre-28$/);
    await chip('Series').click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-10759$/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(HOME);
    // And Forward still leads back into Search, so nothing was thrown away.
    await page.goForward();
    await expect(page).toHaveURL(/\/search/);
  } finally {
    await browser.close();
  }
});

test('Explore browses before typing, remaps across types, and comes back after a query', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const discovered = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname.includes('/discover/') || url.pathname.endsWith('/popular'))
        discovered.push(url.pathname + '?' + (url.searchParams.get('with_genres') ?? ''));
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const chip = (name) => active(page).getByRole('button', { name, exact: true });
    const pill = (name) =>
      active(page)
        .getByRole('group', { name: 'Selected' })
        .getByRole('button', { name: `Remove ${name}`, exact: true });
    // Empty query: For You, filled from the popular tail since the fixture library holds nothing.
    await expect(active(page).getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(chip('For You')).toHaveAttribute('aria-pressed', 'true');
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    expect(discovered).toContain('/tmdb/3/movie/popular?');

    // A genre is its own history entry and its own feed, and leaves its section for the Selected pills.
    await chip('Action').click();
    await expect(page).toHaveURL(/\/search\?c=genre-28$/);
    await expect.poll(() => discovered.at(-1)).toBe('/tmdb/3/discover/movie?28');
    await expect(pill('Action')).toBeVisible();
    await expect(chip('Action')).toHaveCount(0);

    // Series keeps a related genre open rather than one with nothing in it.
    await chip('Series').click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-10759$/);
    await expect(pill('Action & Adventure')).toBeVisible();
    await expect.poll(() => discovered.at(-1)).toBe('/tmdb/3/discover/tv?10759');

    // Typing searches over it; Esc clears the query back to the same view, then leaves.
    await input(page).fill('Neon');
    await expect(page).toHaveURL(/\/search\?q=Neon&type=tv&c=genre-10759$/);
    await expect(active(page).getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
    await input(page).press('Escape');
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-10759$/);
    await expect(pill('Action & Adventure')).toBeVisible();

    // Back walks the picks that were made, on the same page.
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?c=genre-28$/);
    await expect(pill('Action')).toBeVisible();
    await expect(chip('Movies')).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(chip('For You')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await browser.close();
  }
});

test('while typing, a genre narrows the results and a recipe opens in their place', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    const chip = (name) => rail.getByRole('button', { name, exact: true });
    const picks = active(page).getByRole('group', { name: 'Selected' });
    const pill = (name) => picks.getByRole('button', { name: `Remove ${name}`, exact: true });
    const heading = (name) => active(page).getByRole('heading', { name, exact: true });

    await input(page).fill('Neon');
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(heading('Search')).toBeVisible();
    // The rail stays, and nothing in it is open: the query is what's showing.
    await expect(rail.getByRole('button', { pressed: true })).toHaveCount(0);

    // A genre narrows the typed results and keeps the query; the fixture's films are all dramas.
    await chip('Drama').click();
    await expect(page).toHaveURL(/\/search\?q=Neon&c=genre-18$/);
    await expect(pill('Drama')).toBeVisible();
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    // Genres stack, all applying: no drama here is also a comedy.
    await chip('Comedy').click();
    await expect(page).toHaveURL(/\/search\?q=Neon&c=genre-18,genre-35$/);
    await expect(active(page).getByText('No matches.', { exact: true })).toBeVisible();
    // A pill takes its pick back out; Clear all takes the rest, and the query stays.
    await pill('Comedy').click();
    await expect(page).toHaveURL(/\/search\?q=Neon&c=genre-18$/);
    await picks.getByRole('button', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(picks).toHaveCount(0);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();

    // A recipe can't be combined with a query: it opens in its place, and Back returns to the search.
    await chip('Heist').click();
    await expect(page).toHaveURL(/\/search\?c=recipe-heist$/);
    await expect(heading('Explore')).toBeVisible();
    await expect(input(page)).toHaveValue('');
    await expect(pill('Heist')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(input(page)).toHaveValue('Neon');
    await expect(heading('Search')).toBeVisible();

    // The typed text points at categories, offered above the results with their kind.
    await input(page).fill('heist');
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    await expect(browse.getByRole('button', { name: 'Heist · recipe' })).toBeVisible();
    await browse.getByRole('button', { name: 'Heist · recipe' }).click();
    await expect(page).toHaveURL(/\/search\?c=recipe-heist$/);
    await expect(heading('Explore')).toBeVisible();

    // Each section shows its first few; "Show all" opens the rest in place.
    const recipes = rail.getByRole('group', { name: 'Recipes' });
    await expect(recipes.getByRole('button', { name: 'Zombie', exact: true })).toHaveCount(0);
    await recipes.getByRole('button', { name: /^Show all \d+ ›$/ }).click();
    await expect(recipes.getByRole('button', { name: 'Zombie', exact: true })).toBeVisible();
    await recipes.getByRole('button', { name: 'Show fewer' }).click();
    await expect(recipes.getByRole('button', { name: 'Zombie', exact: true })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('facets stack: Sweden, then + Action, narrows the grid; Back takes Action out', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    // Swedish films: 200–203 are action, 204–207 drama. One page each, then the end — so each feed loads whole.
    const swedish = (id, genres) => ({ ...film(id), genre_ids: genres, original_language: 'sv' });
    const catalogue = [
      ...[200, 201, 202, 203].map((id) => swedish(id, [28, 18])),
      ...[204, 205, 206, 207].map((id) => swedish(id, [18])),
    ];
    const asked = [];
    await page.route('**/tmdb/3/discover/**', (r) => {
      const url = new URL(r.request().url());
      asked.push(url.search);
      const genres = (url.searchParams.get('with_genres') ?? '').split(',').filter(Boolean);
      const results =
        url.searchParams.get('page') !== '1'
          ? []
          : catalogue.filter((f) => genres.every((g) => f.genre_ids.includes(Number(g))));
      return r.fulfill({ json: { results, total_pages: 1, total_results: results.length } });
    });
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    const card = (id) => active(page).getByRole('link', { name: `Film ${id} 2026` });

    // Sweden is found by the search field, and picking it turns the query into a pill over the grid.
    await input(page).fill('swe');
    await active(page)
      .getByRole('group', { name: 'Browse', exact: true })
      .getByRole('button', { name: 'Sweden · country', exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    await expect(input(page)).toHaveValue('');
    await expect(rail.getByRole('group', { name: 'Genres' })).toBeVisible();
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(rail.getByRole('group', { name: 'Selected' })).toHaveCount(0);
    await expect(selected.getByRole('button', { name: 'Remove Sweden' })).toBeVisible();
    await expect(card(205)).toBeVisible();

    // + Action: both apply, in one discover query.
    await rail
      .getByRole('group', { name: 'Genres' })
      .getByRole('button', { name: 'Action', exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?c=country-SE,genre-28$/);
    await expect(selected.getByRole('button', { name: 'Remove Sweden' })).toBeVisible();
    await expect(selected.getByRole('button', { name: 'Remove Action' })).toBeVisible();
    await expect(card(200)).toBeVisible();
    await expect(card(205)).toHaveCount(0);
    expect(asked.at(-2)).toContain('with_genres=28');
    expect(asked.at(-2)).toContain('with_origin_country=SE');
    // Action left its section. The feed is loaded whole, and nothing in it is a comedy: no Comedy on offer.
    const genres = rail.getByRole('group', { name: 'Genres' });
    await expect(genres.getByRole('button', { name: 'Action', exact: true })).toHaveCount(0);
    await expect(genres.getByRole('button', { name: 'Comedy', exact: true })).toHaveCount(0);
    await expect(genres.getByRole('button', { name: 'Drama', exact: true })).toBeVisible();

    // Back takes the last pick out.
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    await expect(selected.getByRole('button', { name: 'Remove Action' })).toHaveCount(0);
    await expect(card(205)).toBeVisible();
  } finally {
    await browser.close();
  }
});

/**
 * atlas's stackable filters, mocked: counts beside any selection (dramas and thrillers; two people; one runtime),
 * a page of four titles, and the typeahead's people and characters. Each address asked is recorded as sent.
 */
async function serveFilter(page, { titles = true, countsGate } = {}) {
  const asked = [];
  const card = (id) => ({
    type: 'movie',
    id,
    title: `Atlas ${id}`,
    year: 2020,
    posterPath: '/p.jpg',
  });
  // atlas's cards ask den-edge what other browsers know of them (ratings); nothing, here.
  await page.route('**/metadata/title/query', (r) => r.fulfill({ json: { titles: [] } }));
  await page.route('**/atlas/index/filter/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^.*\/atlas/, '') + url.search;
    asked.push(path);
    const sel = url.searchParams.get('sel') ?? '';
    if (url.pathname.endsWith('/counts.json')) {
      await countsGate;
      const person = /person:(Q\d+)/.exec(sel)?.[1];
      return r.fulfill({
        json: {
          total: 12,
          kinds: {
            genre: { mode: 'and', complete: true, values: { 18: 7, 53: 2 } },
            language: { mode: 'and', complete: false, values: { sv: 3 } },
            person: {
              mode: 'and',
              complete: false,
              values: { Q2: 5, Q1: 2 },
              labels: { Q1: 'Ann Director', Q2: 'Bob Actor' },
              ...(person ? { selected: [person] } : {}),
            },
            runtime: { mode: 'single', complete: true, values: { 'under-90': 4 } },
            region: {
              mode: 'single',
              complete: true,
              values: { nordic: 6, 'east-asian': 2 },
              labels: { nordic: 'Nordic', 'east-asian': 'East Asian' },
              ...(/region:nordic/.test(sel) ? { selected: ['nordic'] } : {}),
            },
          },
          ignored: [],
        },
      });
    }
    if (url.pathname.endsWith('/titles.json')) {
      if (!titles) return r.fulfill({ status: 404, body: '' });
      return r.fulfill({
        json: { titles: [500, 501, 502, 503].map(card), total: 4, order: 'o', ignored: [] },
      });
    }
    const kind = /values\/([a-z]+)\.json$/.exec(url.pathname)?.[1];
    const values = {
      made: [{ id: 'Q25191', name: 'Christopher Nolan', count: 12 }],
      cast: [
        { id: 'Q25191', name: 'Christopher Nolan', count: 1 },
        { id: 'Q7', name: 'Nolan North', count: 3 },
      ],
      character: [{ id: 'nolan-shaw', name: 'Nolan Shaw', count: 1 }],
    }[kind];
    return r.fulfill({ json: { kind, values: values ?? [], complete: true } });
  });
  return asked;
}

test('atlas’s filter feeds the grid, judges the options and lists its people, at its canonical addresses', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const asked = await serveFilter(page);
    const discovered = [];
    page.on('request', (r) => {
      if (r.url().includes('/discover/')) discovered.push(r.url());
    });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=country-SE')}`);
    const grid = active(page).locator('.grid');
    await expect(grid.getByRole('link', { name: 'Atlas 500 2020' })).toBeVisible();
    expect(asked).toContain('/index/filter/movie/titles.json?sel=country:SE');
    await expect.poll(() => asked).toContain('/index/filter/movie/counts.json?sel=country:SE');

    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    const genres = rail.getByRole('group', { name: 'Genres' });
    await expect(genres.getByRole('button', { name: 'Drama', exact: true })).toBeVisible();
    await expect(genres.getByRole('button', { name: 'Comedy', exact: true })).toHaveCount(0);
    // Languages are listed incompletely: none is judged by its absence.
    await expect(
      rail.getByRole('group', { name: 'Languages' }).getByRole('button', { name: 'English' }),
    ).toBeVisible();
    await expect(
      rail.getByRole('group', { name: 'Runtime' }).getByRole('button', { name: 'Under 90 min' }),
    ).toBeVisible();

    // A person from the People section stacks onto the selection, named by atlas.
    await rail
      .getByRole('group', { name: 'People' })
      .getByRole('button', { name: 'Bob Actor', exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?c=country-SE,person-Q2$/);
    await expect(
      active(page)
        .getByRole('group', { name: 'Selected' })
        .getByRole('button', { name: 'Remove Bob Actor' }),
    ).toBeVisible();
    await expect
      .poll(() => asked)
      .toContain('/index/filter/movie/titles.json?sel=country:SE,person:Q2');
    // Nothing of this went to TMDB discover.
    expect(discovered).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a region is picked from the rail’s Regions, one at a time, and asks atlas for region:<slug>', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const asked = await serveFilter(page);
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search')}`);
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    const regions = rail.getByRole('group', { name: 'Regions' });
    await expect(regions).toBeVisible();
    // Directly under Countries, and without the regions atlas counts no titles for.
    const headings = await rail.getByRole('heading').allTextContents();
    expect(headings.indexOf('Regions')).toBe(headings.indexOf('Countries') + 1);
    await expect(regions.getByRole('button', { name: 'Slavic', exact: true })).toHaveCount(0);
    await expect(regions.getByRole('button', { name: 'East Asian', exact: true })).toBeVisible();

    await regions.getByRole('button', { name: 'Nordic', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?c=region-nordic$/);
    await expect(
      active(page).getByRole('group', { name: 'Selected' }).getByRole('button', {
        name: 'Remove Nordic',
      }),
    ).toBeVisible();
    await expect.poll(() => asked).toContain('/index/filter/movie/titles.json?sel=region:nordic');
    // One region at a time: the others leave the rail until it is taken out.
    await expect(rail.getByRole('group', { name: 'Regions' })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a fresh address names a person “Person…” until atlas’s counts name them', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    let counted;
    await serveFilter(page, { countsGate: new Promise((resolve) => (counted = resolve)) });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=person-Q2')}`);
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(selected.getByRole('button', { name: 'Remove Person…' })).toBeVisible();
    counted();
    await expect(selected.getByRole('button', { name: 'Remove Bob Actor' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('the search field finds people and characters through atlas, and a person picked is a pill', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const asked = await serveFilter(page);
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    await input(page).fill('nol');
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    await expect(
      browse.getByRole('button', { name: 'Christopher Nolan · director/writer' }),
    ).toBeVisible();
    await expect(browse.getByRole('button', { name: 'Nolan North · actor' })).toBeVisible();
    await expect(browse.getByRole('button', { name: 'Nolan Shaw · character' })).toBeVisible();
    expect(asked).toContain('/index/filter/movie/values/made.json?q=nol');
    expect(asked).toContain('/index/filter/movie/values/character.json?q=nol');
    await browse.getByRole('button', { name: 'Christopher Nolan · director/writer' }).click();
    await expect(page).toHaveURL(/\/search\?c=person-Q25191$/);
    await expect(input(page)).toHaveValue('');
    await expect(
      active(page)
        .getByRole('group', { name: 'Selected' })
        .getByRole('button', { name: 'Remove Christopher Nolan' }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('where atlas’s filter has no titles route, the grid is TMDB discover as before', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const asked = await serveFilter(page, { titles: false });
    const discovered = [];
    page.on('request', (r) => {
      if (r.url().includes('/discover/')) discovered.push(r.url());
    });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=country-SE')}`);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    expect(asked).toContain('/index/filter/movie/titles.json?sel=country:SE');
    expect(discovered.some((url) => url.includes('with_origin_country=SE'))).toBe(true);
  } finally {
    await browser.close();
  }
});

for (const titles of [true, false])
  test(`the Movies tab’s genre rows are ${titles ? 'atlas’s filter' : 'TMDB discover where atlas’s filter is missing'}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'reduce',
      });
      await setup(page, { atlasGate: Promise.resolve() });
      const asked = await serveFilter(page, { titles });
      const discovered = [];
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname.includes('/discover/'))
          discovered.push(url.pathname + '?' + (url.searchParams.get('with_genres') ?? ''));
      });
      await page.goto(`${FIXTURE}?at=${encodeURIComponent('/movies')}`);
      // Drama: the fixture's TMDB films are all dramas, so TMDB's shelf has them too.
      const drama = active(page).getByRole('region', { name: 'Drama', exact: true });
      await drama.scrollIntoViewIfNeeded();
      const primary = '/index/filter/movie/titles.json?sel=primary:Drama';
      await expect.poll(() => asked).toContain(primary);
      // The row may have drawn TMDB's page before atlas was found; once it is, the row is atlas's alone.
      const [atlasCard, tmdbCard] = ['Atlas 500 2020', 'Film 100 2026'].map((name) =>
        drama.getByRole('link', { name }),
      );
      await expect(atlasCard).toHaveCount(titles ? 1 : 0);
      await expect(tmdbCard).toHaveCount(titles ? 0 : 1);
      if (!titles) expect(discovered).toContain('/tmdb/3/discover/movie?18');
    } finally {
      await browser.close();
    }
  });

test('"More like this" on a poster adds a "Like" pill without opening the title, and feeds atlas’s similar', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const similar = [];
    await page.route('**/atlas/index/similar/**', (r) => {
      similar.push(new URL(r.request().url()).pathname + new URL(r.request().url()).search);
      return r.fulfill({ json: { ids: [300, 301] } });
    });
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const grid = active(page).locator('.grid');
    const selected = active(page).getByRole('group', { name: 'Selected' });

    // The control sits on the poster, beside its link: pressing it keeps Search open.
    await grid.getByRole('link', { name: 'Film 101 2026' }).hover();
    await grid.getByRole('button', { name: 'More like Film 101', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?c=like-movie-101$/);
    await expect(selected.getByRole('button', { name: 'Remove Like Film 101' })).toBeVisible();
    await expect(grid.getByRole('link', { name: 'Film 300 2026' })).toBeVisible();
    expect(similar[0]).toBe('/atlas/index/similar/movie/101.json?limit=200');

    // One "Like" at a time: while it is picked no poster offers another, and a mood can't join it.
    await expect(grid.getByRole('button', { name: /^More like / })).toHaveCount(0);
    await expect(
      active(page)
        .getByRole('navigation', { name: 'Browse by category' })
        .getByRole('group', { name: 'Moods' }),
    ).toHaveCount(0);

    // Back takes it out, and the posters offer it again.
    await page.goBack();
    await expect(page).toHaveURL(/\/search$/);
    await expect(selected).toHaveCount(0);
    await expect(grid.getByRole('button', { name: 'More like Film 101', exact: true })).toHaveCount(
      1,
    );
  } finally {
    await browser.close();
  }
});

test('beside a "Like", a genre none of its titles has is not offered, in the rail or the Browse row', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    // Its similar titles are the fixture's: all dramas, none of them action. TMDB's tail never answers, so the feed
    // is never loaded to its end: what is judged is what has loaded.
    await page.route('**/atlas/index/similar/**', (r) => r.fulfill({ json: { ids: [300, 301] } }));
    await page.route('**/recommendations**', () => {});
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=like-movie-949')}`);
    await expect(active(page).getByRole('link', { name: 'Film 300 2026' })).toBeVisible();
    const genres = active(page)
      .getByRole('navigation', { name: 'Browse by category' })
      .getByRole('group', { name: 'Genres' });
    await expect(genres.getByRole('button', { name: 'Drama', exact: true })).toBeVisible();
    await expect(genres.getByRole('button', { name: 'Action', exact: true })).toHaveCount(0);
    // Typed, the Browse row offers it no more than the rail does.
    await input(page).fill('action');
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    await expect(browse.getByRole('button', { name: 'Action · genre', exact: true })).toHaveCount(
      0,
    );
    await input(page).fill('drama');
    await expect(browse.getByRole('button', { name: 'Drama · genre', exact: true })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a "Like" from the address says "Like…" until its title is named', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    await page.route('**/atlas/index/similar/**', (r) => r.fulfill({ json: { ids: [300] } }));
    let name;
    const named = new Promise((resolve) => (name = resolve));
    // The title's own lookup waits; the feed's titles don't.
    await page.route(/\/movie\/949(\?|$)/, async (r) => {
      await named;
      return r.fulfill({ json: { ...film(949, 'Heat'), genres: [], credits: { cast: [] } } });
    });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=like-movie-949')}`);
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(selected.getByRole('button', { name: 'Remove Like…' })).toBeVisible();
    name();
    await expect(selected.getByRole('button', { name: 'Remove Like Heat' })).toBeVisible();
    await expect(active(page).getByRole('link', { name: 'Film 300 2026' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a rating floor is picked from the Browse row, and asks TMDB for it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    const asked = [];
    await page.route('**/tmdb/3/discover/**', (r) => {
      asked.push(new URL(r.request().url()).searchParams);
      return r.fulfill({ json: { results: films, total_pages: 1 } });
    });
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    await input(page).fill('7+');
    await active(page)
      .getByRole('group', { name: 'Browse', exact: true })
      .getByRole('button', { name: '★ 7+ · rating', exact: true })
      .click();
    await expect(page).toHaveURL(/\/search\?c=rating-7$/);
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(selected.getByRole('button', { name: 'Remove ★ 7+' })).toBeVisible();
    await expect.poll(() => asked.at(-1)?.get('vote_average.gte')).toBe('7');
    expect(asked.at(-1)?.get('vote_count.gte')).toBe('10');
    // One floor at a time: the others leave the rail until it is removed.
    const ratings = active(page)
      .getByRole('navigation', { name: 'Browse by category' })
      .getByRole('group', { name: 'Rating' });
    await expect(ratings).toHaveCount(0);
    await selected.getByRole('button', { name: 'Remove ★ 7+' }).click();
    await expect(ratings.getByRole('button', { name: '★ 8+', exact: true })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a selection that shows nothing names the pick to take out, and takes it out in one tap', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    // Nothing at ★ 6+; Swedish comedies otherwise.
    await page.route('**/tmdb/3/discover/**', (r) => {
      const url = new URL(r.request().url());
      const results =
        url.searchParams.get('vote_average.gte') || url.searchParams.get('page') !== '1'
          ? []
          : films;
      return r.fulfill({ json: { results, total_pages: 1 } });
    });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=lang-sv,genre-35,rating-6')}`);
    const feed = active(page);
    await expect(feed.getByText('No results with ★ 6+.')).toBeVisible();
    await feed.getByRole('button', { name: 'Remove ★ 6+' }).last().click();
    await expect(page).toHaveURL(/\/search\?c=lang-sv,genre-35$/);
    await expect(feed.getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a language, country or decade picked offers no other of its kind until it is removed', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=lang-sv,decade-1990')}`);
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    await expect(rail.getByRole('group', { name: 'Genres' })).toBeVisible();
    await expect(rail.getByRole('group', { name: 'Languages' })).toHaveCount(0);
    await expect(rail.getByRole('group', { name: 'Decades' })).toHaveCount(0);
    await expect(rail.getByRole('group', { name: 'Countries' })).toBeVisible();
    // The Browse row too, though the picks are paused while a query is typed.
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    await input(page).fill('english');
    await expect(browse.getByRole('button', { name: 'England · country' })).toHaveCount(0);
    await expect(browse.getByRole('button', { name: 'English · language' })).toHaveCount(0);
    await input(page).fill('british');
    await expect(browse.getByRole('button', { name: 'United Kingdom · country' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a title’s "More like this" row links to Search with its "Like"', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    await page.route('**/atlas/index/similar/**', (r) => r.fulfill({ json: { ids: [300, 301] } }));
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/movie/101')}`);
    const row = active(page).getByRole('region', { name: 'More like this' });
    await expect(row.getByRole('link', { name: 'Film 300 2026' })).toBeVisible();
    await row.getByRole('link', { name: 'Explore similar ›' }).click();
    await expect(page).toHaveURL(/\/search\?c=like-movie-101$/);
    await expect(
      active(page)
        .getByRole('group', { name: 'Selected' })
        .getByRole('button', { name: 'Remove Like Film 101' }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

for (const width of [1100, 1440])
  test(`the search field finds every kind, and the rail never scrolls sideways at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      await setup(page);
      await page.goto(FIXTURE);
      await openSearch(page, width);
      const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
      const sideways = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-route-page][data-active="true"] .rail')].map(
            (el) => el.scrollWidth - el.clientWidth,
          ),
        );
      await expect(rail.getByRole('group', { name: 'Genres' })).toBeVisible();
      expect(await sideways()).toEqual([0, 0]);
      // Every kind is browsable without typing, each opened in place (the eight decades need no "Show all").
      await expect(rail.getByRole('group', { name: 'Decades' })).toBeVisible();
      for (const name of ['Recipes', 'Genres', 'Languages', 'Countries'])
        await rail
          .getByRole('group', { name })
          .getByRole('button', { name: /^Show all/ })
          .click();
      expect(await sideways()).toEqual([0, 0]);

      // The one search field finds every kind, in one ranked row, typos forgiven: "sweidsh" is Swedish.
      await input(page).fill('sweidsh');
      const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
      await expect(browse.getByRole('button').first()).toHaveText('Swedish · language');
      expect(await sideways()).toEqual([0, 0]);
      await input(page).fill('90s');
      await browse.getByRole('button', { name: '1990s · decade' }).click();
      await expect(page).toHaveURL(/\/search\?c=decade-1990$/);
      await expect(
        active(page).getByRole('heading', { name: 'Explore', exact: true }),
      ).toBeVisible();
    } finally {
      await browser.close();
    }
  });

test('on a phone, More… opens every category in a sheet', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    const more = active(page).getByRole('button', { name: 'More…', exact: true });
    const sheet = page.getByRole('dialog', { name: 'All categories' });

    // Back closes it without picking, and leaves Search where it was.
    await more.click();
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);
    // So does its ✕.
    await more.click();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);

    await more.click();
    for (const name of ['For You', 'Genres', 'Countries', 'Rating'])
      await expect(sheet.getByRole('heading', { name, exact: true })).toBeVisible();
    // Each section is one row; "All ›" opens it out in place.
    const recipes = sheet.getByRole('group', { name: 'Recipes' });
    await recipes.getByRole('button', { name: 'All Recipes' }).click();
    await expect(recipes.getByRole('button', { name: 'All Recipes' })).toHaveCount(0);
    await recipes.getByRole('button', { name: 'Nordic Noir', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/search\?c=recipe-nordic-noir$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // The pick is one entry: Back returns to Search as it was before the sheet opened.
    await page.goBack();
    await expect(page).toHaveURL(/\/search$/);
    await expect(sheet).toBeHidden();
  } finally {
    await browser.close();
  }
});

test('the Browse row: the whole query first, fewer for long queries, a pick replaces the query', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    const heading = (name) => active(page).getByRole('heading', { name, exact: true });

    // A short form counts in full: "uk" is the United Kingdom, first, its name a little heavier.
    await input(page).fill('uk');
    const first = browse.getByRole('button').first();
    await expect(first).toHaveText('United Kingdom · country');
    await expect(first).toHaveClass(/exact/);
    // Two letters already offer something, more than a handful.
    await input(page).fill('dr');
    await expect.poll(() => browse.getByRole('button').count()).toBeGreaterThan(6);
    // Three words or more: likelier a title, so only the closest three.
    await input(page).fill('slow burn bleak thriller');
    await expect.poll(() => browse.getByRole('button').count()).toBeLessThanOrEqual(3);

    // Enter searches the text; it never turns into a facet.
    await input(page).fill('sweden');
    await input(page).press('Enter');
    await expect(page).toHaveURL(/\/search\?q=sweden$/);
    await expect(heading('Search')).toBeVisible();

    // Picking from the row turns the query into that pill, and Back brings the query back.
    await browse.getByRole('button', { name: 'Sweden · country', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    await expect(input(page)).toHaveValue('');
    await expect(heading('Explore')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=sweden$/);
    await expect(input(page)).toHaveValue('sweden');
  } finally {
    await browser.close();
  }
});

test('the whole-query match is not drawn as picked: it looks like its siblings until pressed', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    await input(page).fill('swedish');
    const browse = active(page).getByRole('group', { name: 'Browse', exact: true });
    const sweden = browse.getByRole('button', { name: 'Sweden · country', exact: true });
    await expect(sweden).toBeVisible();
    // The first chip is the one drawn as the query's whole name.
    const first = browse.getByRole('button').first();
    await expect(first).toHaveClass(/exact/);

    // No picked semantics, and nothing a pick wears: the same border, fill and colour as the chips beside it.
    const look = (chip) =>
      chip.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.borderTopStyle, s.borderTopColor, s.backgroundColor, s.color];
      });
    for (const chip of [first, sweden]) {
      await expect(chip).not.toHaveAttribute('aria-pressed', /.*/);
      await expect(chip).not.toHaveAttribute('aria-selected', /.*/);
    }
    expect(await look(first)).toEqual(await look(browse.getByRole('button').nth(1)));
    expect(await look(sweden)).toEqual(await look(browse.getByRole('button').last()));
    const picks = active(page).getByRole('group', { name: 'Selected' });
    await expect(picks).toHaveCount(0);

    // Pressed, it is picked: a pill over the grid, and out of the rail's Countries.
    await sweden.click();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    await expect(picks.getByRole('button', { name: 'Remove Sweden' })).toBeVisible();
    await expect(
      active(page)
        .getByRole('navigation', { name: 'Browse by category' })
        .getByRole('group', { name: 'Countries' })
        .getByRole('button', { name: 'Sweden', exact: true }),
    ).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('while typing, picks that can’t apply stay shown, paused; results come before the rail', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=country-SE,genre-18')}`);
    const picks = active(page).getByRole('group', { name: 'Selected' });
    await expect(picks.getByRole('button', { name: 'Remove Sweden' })).toBeVisible();
    await input(page).fill('drama');
    await expect(page).toHaveURL(/\/search\?q=drama&c=country-SE,genre-18$/);
    // Drama still narrows the results; Sweden waits, shown and said so.
    await expect(picks.getByRole('button', { name: 'Remove Sweden' })).toHaveClass(/paused/);
    await expect(picks.getByRole('button', { name: 'Remove Drama' })).not.toHaveClass(/paused/);
    await expect(
      picks.getByText('Paused while searching — clear search to apply', { exact: true }),
    ).toBeVisible();

    // The Browse row and the results come before the rail, and ArrowDown goes from the field into them.
    const order = await page.evaluate(() => {
      const page = document.querySelector('[data-route-page][data-active="true"]');
      const row = page.querySelector('.browse');
      const rail = page.querySelector('nav.rail');
      return !!(row.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
    await input(page).focus();
    await input(page).press('ArrowDown');
    await expect(
      active(page).getByRole('group', { name: 'Browse', exact: true }).getByRole('button').first(),
    ).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('on a phone, only the bar stays pinned, and the strip gives way to the Browse row while typing', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    // Scrolled into the grid, what stays on screen at the top is the bar alone.
    const pinned = await page.evaluate(async () => {
      scrollTo(0, 1200);
      await new Promise((r) => setTimeout(r, 200));
      let bottom = document.querySelector('.bar').getBoundingClientRect().bottom;
      for (const el of document.querySelectorAll('main *')) {
        if (!['fixed', 'sticky'].includes(getComputedStyle(el).position)) continue;
        const box = el.getBoundingClientRect();
        if (box.height > 0 && box.top < 200 && box.bottom > 0)
          bottom = Math.max(bottom, box.bottom);
      }
      return bottom;
    });
    expect(pinned).toBeLessThanOrEqual(120);
    // Typing: the strip steps aside, and its More… with it.
    await input(page).fill('drama');
    await expect(active(page).getByRole('group', { name: 'Browse', exact: true })).toBeVisible();
    await expect(active(page).getByRole('button', { name: 'More…', exact: true })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

for (const [name, options, focused] of [
  ['with a mouse', { viewport: { width: 1280, height: 800 } }, true],
  [
    'on a touch screen',
    { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true },
    false,
  ],
])
  test(`a fresh load of search puts the cursor in the field only ${name}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({ ...options, reducedMotion: 'reduce' });
      await setup(page);
      await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=genre-18')}`);
      await expect(
        active(page).getByRole('heading', { name: 'Explore', exact: true }),
      ).toBeVisible();
      if (focused) await expect(input(page)).toBeFocused();
      else {
        // Drawn open, but left alone: focus would raise the keyboard over the grid.
        await expect(input(page)).toBeVisible();
        await page.waitForTimeout(200);
        await expect(input(page)).not.toBeFocused();
      }
      if (!focused) return;
      // Coming back from a title keeps focus where it was, rather than jumping to the field.
      const card = active(page).getByRole('link', { name: 'Film 100 2026' });
      await card.click();
      await expect(active(page).locator('h1')).toHaveText('Film 100');
      await page.goBack();
      await expect(
        active(page).getByRole('heading', { name: 'Explore', exact: true }),
      ).toBeVisible();
      await expect(input(page)).not.toBeFocused();
    } finally {
      await browser.close();
    }
  });

test('late discovery keeps the already visible billboard and selected slide', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    let releaseAtlas, releaseCatalogue;
    const atlasGate = new Promise((r) => (releaseAtlas = r)),
      catalogueGate = new Promise((r) => (releaseCatalogue = r));
    await setup(page, { atlasGate, catalogueGate });
    await page.goto(FIXTURE);
    const hero = active(page).locator('.billboard');
    await expect(hero.locator('.slide').first()).toBeVisible();
    await hero.locator('.dot').nth(1).click();
    await expect(hero.locator('.backdrop.lit')).toHaveCount(1);
    await page.evaluate(() => {
      window.heroBlanked = false;
      new MutationObserver(() => {
        if (
          !document.querySelector('.billboard .slide') ||
          !document.querySelector('.billboard .backdrop.lit')
        )
          window.heroBlanked = true;
      }).observe(document.querySelector('.billboard'), {
        subtree: true,
        childList: true,
        attributes: true,
      });
    });
    const fetching = page.waitForRequest('**/atlas/recommend');
    releaseAtlas();
    await fetching;
    await expect(hero.locator('.slide').first()).toBeAttached();
    const response = page.waitForResponse('**/atlas/recommend');
    releaseCatalogue();
    await response;
    await page.waitForTimeout(150);
    await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
    expect(await page.evaluate(() => window.heroBlanked)).toBe(false);
  } finally {
    await browser.close();
  }
});

test('immediate search cancellation returns Home during its opening animation', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 800 }, hasTouch: true });
    await setup(page);
    await page.goto(FIXTURE);
    await expect(active(page).locator('.billboard')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.search-toggle').click();
      document.querySelector('.cancel').click();
    });
    await expect(page).toHaveURL(HOME);
    await expect(active(page).locator('.billboard')).toBeVisible();
    await expect(input(page)).toBeHidden();
  } finally {
    await browser.close();
  }
});

for (const width of [320, 393, 1280])
  test(`billboard opens by mobile slide tap and keeps desktop actions at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 760,
        reducedMotion: 'reduce',
      });
      await setup(page);
      await page.goto(FIXTURE);
      const hero = active(page).locator('.billboard');
      await expect(hero.locator('.slide').first()).toBeVisible();
      if (width >= 760) {
        await expect(
          hero.locator('.slide').first().getByRole('link', { name: 'More', exact: true }),
        ).toBeVisible();
        await expect(hero.locator('.slide-link').first()).toBeHidden();
        return;
      }
      await expect(hero.getByRole('link', { name: 'More', exact: true })).toHaveCount(0);
      await expect(hero.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
      await expect(hero.locator('.actions').first()).toBeHidden();
      const cdp = await page.context().newCDPSession(page);
      const start = width - 50;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: start, y: 220 }],
      });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start - (i * (start - 50)) / 6, y: 220 }],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(hero.locator('.dot').first()).not.toHaveAttribute('aria-current', 'true');
      await expect(page).toHaveURL(HOME);
      // Dots remain independent of the full-slide link and select a predictable destination.
      await hero.locator('.dot').nth(1).click();
      await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
      const slide = hero.locator('.slide-link[tabindex="0"]');
      const href = await slide.getAttribute('href');
      await page.screenshot({ path: test.info().outputPath(`mobile-slide-${width}.png`) });
      await slide.tap({ position: { x: width / 2, y: 180 } });
      await expect(page).toHaveURL(new RegExp(href + '$'));
      await expect(active(page).locator('h1')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(HOME);
      await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
    } finally {
      await browser.close();
    }
  });
