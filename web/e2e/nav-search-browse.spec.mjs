import { test, expect, chromium } from '@playwright/test';
import {
  film,
  films,
  shows,
  active,
  input,
  FIXTURE,
  setup,
  openSearch,
} from './nav-search-fixture.mjs';

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
    // Empty query: All, and For You of both types, filled from the popular films and top series since the fixture
    // library holds nothing. Each card opens its own type's page.
    await expect(active(page).getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('For You')).toHaveAttribute('aria-pressed', 'true');
    const grid = active(page).locator('.grid');
    await expect(grid.getByRole('link', { name: 'Film 100 2026' })).toHaveAttribute(
      'href',
      '/movie/100-film-100',
    );
    await expect(grid.getByRole('link', { name: 'Series 700 2025' })).toHaveAttribute(
      'href',
      '/tv/700-series-700',
    );
    expect(discovered).toContain('/tmdb/3/movie/popular?');

    // A genre is its own history entry and its own feed, and leaves its section for the Selected pills. Under All it
    // is the films' Action and the series' Action & Adventure.
    await chip('Action').click();
    await expect(page).toHaveURL(/\/search\?c=genre-28$/);
    await expect
      .poll(() => discovered)
      .toEqual(expect.arrayContaining(['/tmdb/3/discover/movie?28', '/tmdb/3/discover/tv?10759']));
    await expect(pill('Action')).toBeVisible();
    await expect(chip('Action')).toHaveCount(0);

    // Series keeps a related genre open rather than one with nothing in it.
    await chip('Series').click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-10759$/);
    await expect(pill('Action & Adventure')).toBeVisible();
    await expect(chip('Series')).toHaveAttribute('aria-pressed', 'true');

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
    await expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
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
      // No Swedish series: under All the grid is these films alone.
      if (url.pathname.endsWith('/tv'))
        return r.fulfill({ json: { results: [], total_pages: 1, total_results: 0 } });
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
    // One query carries both picks. Where it lands among the page requests depends on how the feed pages, so
    // look for it rather than at a fixed position.
    expect(
      asked.some((q) => q.includes('with_genres=28') && q.includes('with_origin_country=SE')),
      asked.join('\n'),
    ).toBe(true);
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
          : url.pathname.endsWith('/tv')
            ? shows
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

test('under All, a pick series have no form of shows films alone and says so', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    const discovered = [];
    page.on('request', (r) => {
      if (r.url().includes('/discover/')) discovered.push(new URL(r.url()).pathname);
    });
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=recipe-romantic-comedy')}`);
    await expect(active(page).getByText('Romantic Comedy: movies only.')).toBeVisible();
    await expect.poll(() => discovered).toContain('/tmdb/3/discover/movie');
    expect(discovered).not.toContain('/tmdb/3/discover/tv');
    // Under Movies there is nothing to say.
    await active(page).getByRole('button', { name: 'Movies', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?type=movie&c=recipe-romantic-comedy$/);
    await expect(active(page).getByText('Romantic Comedy: movies only.')).toHaveCount(0);
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
