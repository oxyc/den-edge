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
const input = (page) => page.getByRole('searchbox', { name: 'Search movies, series and people' });
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
    const pill = (name) => chip(`Remove ${name}`);
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
    const heading = (name) => active(page).getByRole('heading', { name, exact: true });

    await input(page).fill('Neon');
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(heading('Search')).toBeVisible();
    // The rail stays, and nothing in it is open: the query is what's showing.
    await expect(rail.getByRole('button', { pressed: true })).toHaveCount(0);

    // A genre narrows the typed results and keeps the query; the fixture's films are all dramas.
    await chip('Drama').click();
    await expect(page).toHaveURL(/\/search\?q=Neon&c=genre-18$/);
    await expect(chip('Remove Drama')).toBeVisible();
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    // Genres stack, all applying: no drama here is also a comedy.
    await chip('Comedy').click();
    await expect(page).toHaveURL(/\/search\?q=Neon&c=genre-18,genre-35$/);
    await expect(active(page).getByText('No matches.', { exact: true })).toBeVisible();
    // A pill takes its pick back out.
    await chip('Remove Comedy').click();
    await chip('Remove Drama').click();
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();

    // A recipe can't be combined with a query: it opens in its place, and Back returns to the search.
    await chip('Heist').click();
    await expect(page).toHaveURL(/\/search\?c=recipe-heist$/);
    await expect(heading('Explore')).toBeVisible();
    await expect(input(page)).toHaveValue('');
    await expect(chip('Remove Heist')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=Neon$/);
    await expect(input(page)).toHaveValue('Neon');
    await expect(heading('Search')).toBeVisible();

    // The typed text points at categories, offered above the results with their kind.
    await input(page).fill('heist');
    const suggestions = active(page).getByRole('group', { name: 'Browse instead' });
    await expect(suggestions.getByRole('button', { name: 'Heist · recipe' })).toBeVisible();
    await suggestions.getByRole('button', { name: 'Heist · recipe' }).click();
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

    // Sweden is found by the filter, and becomes a pill at the top.
    await rail.getByRole('searchbox', { name: 'Filter categories' }).fill('swe');
    await rail.getByRole('button', { name: 'Sweden · country', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    const selected = rail.getByRole('group', { name: 'Selected' });
    await expect(selected.getByRole('button', { name: 'Remove Sweden' })).toBeVisible();
    await expect(card(205)).toBeVisible();

    // + Action: both apply, in one discover query.
    await rail.getByRole('searchbox', { name: 'Filter categories' }).fill('');
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

test('atlas’s counts take out what would show nothing, and only in the kinds they count', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page, { atlasGate: Promise.resolve() });
    const asked = [];
    // Beside Sweden: dramas and thrillers only. Languages go uncounted.
    await page.route('**/atlas/index/facets/**', (r) => {
      asked.push(new URL(r.request().url()).pathname + new URL(r.request().url()).search);
      return r.fulfill({ json: { genre: { 18: 7, 53: 2 } } });
    });
    await page.goto(FIXTURE);
    await openSearch(page, 1280);
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    await rail.getByRole('searchbox', { name: 'Filter categories' }).fill('sweden');
    await rail.getByRole('button', { name: 'Sweden · country', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?c=country-SE$/);
    await expect.poll(() => asked.at(-1)).toBe('/atlas/index/facets/movie.json?sel=country:SE');
    await rail.getByRole('searchbox', { name: 'Filter categories' }).fill('');
    const genres = rail.getByRole('group', { name: 'Genres' });
    await expect(genres.getByRole('button', { name: 'Comedy', exact: true })).toHaveCount(0);
    await expect(genres.getByRole('button', { name: 'Drama', exact: true })).toBeVisible();
    await expect(genres.getByRole('button', { name: 'Thriller', exact: true })).toBeVisible();
    // Languages weren't counted, so none of them is hidden.
    await rail.getByRole('searchbox', { name: 'Filter categories' }).fill('english');
    await expect(rail.getByRole('button', { name: 'English · language' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

for (const width of [1100, 1440])
  test(`the rail's one filter finds every kind, and the rail never scrolls sideways at ${width}px`, async () => {
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
      for (const name of ['Recipes', 'Genres'])
        await rail
          .getByRole('group', { name })
          .getByRole('button', { name: /^Show all/ })
          .click();
      expect(await sideways()).toEqual([0, 0]);

      // One filter across every kind, one ranked list, typos forgiven: "sweidsh" is Swedish.
      const filter = rail.getByRole('searchbox', { name: 'Filter categories' });
      await filter.fill('sweidsh');
      const matches = rail.getByRole('group', { name: 'Matches' });
      await expect(matches.getByRole('button').first()).toHaveText('Swedish · language');
      await expect(rail.getByRole('group', { name: 'Recipes' })).toHaveCount(0);
      expect(await sideways()).toEqual([0, 0]);
      await filter.fill('90s');
      await matches.getByRole('button', { name: '1990s · decade' }).click();
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
    await active(page).getByRole('button', { name: 'More…', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'All categories' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Genres' })).toBeVisible();
    await sheet.getByRole('searchbox', { name: 'Filter categories' }).fill('noir');
    await expect(sheet.getByRole('button', { name: 'Action', exact: true })).toHaveCount(0);
    // A filter result names its kind beside it.
    await sheet.getByRole('button', { name: 'Nordic Noir · recipe', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/search\?c=recipe-nordic-noir$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
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
