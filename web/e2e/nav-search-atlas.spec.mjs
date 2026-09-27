import { test, expect, chromium } from '@playwright/test';
import { film, active, input, FIXTURE, setup, openSearch } from './nav-search-fixture.mjs';

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
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?c=decade-1990')}`);
    const grid = active(page).locator('.grid');
    await expect(grid.getByRole('link', { name: 'Atlas 500 2020' })).toBeVisible();
    // All, the default: both types in one question.
    expect(asked).toContain('/index/filter/all/titles.json?sel=decade:1990');
    await expect.poll(() => asked).toContain('/index/filter/all/counts.json?sel=decade:1990');

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
    await expect(page).toHaveURL(/\/search\?c=decade-1990,person-Q2$/);
    await expect(
      active(page)
        .getByRole('group', { name: 'Selected' })
        .getByRole('button', { name: 'Remove Bob Actor' }),
    ).toBeVisible();
    await expect
      .poll(() => asked)
      .toContain('/index/filter/all/titles.json?sel=decade:1990,person:Q2');
    // Nothing of this went to TMDB discover.
    expect(discovered).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a region is picked from the rail and uses strict TMDB origin countries', async () => {
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
    await expect
      .poll(() => discovered.some((url) => url.includes('with_origin_country=SE')))
      .toBe(true);
    expect(asked.some((path) => path.includes('sel=region:nordic'))).toBe(false);
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
    expect(asked).toContain('/index/filter/all/values/made.json?q=nol');
    expect(asked).toContain('/index/filter/all/values/character.json?q=nol');
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

test('country Search uses each type’s strict TMDB origin discovery, interleaved', async () => {
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
    const cards = active(page).locator('.grid').getByRole('link');
    await expect(cards.first()).toHaveAttribute('href', '/movie/100-film-100');
    // A film, then a series, then a film: each type's page in turn, each card opening its own type's page.
    await expect(cards.nth(1)).toHaveAttribute('href', '/tv/700-series-700');
    await expect(cards.nth(2)).toHaveAttribute('href', '/movie/101-film-101');
    // Country browsing never asks Atlas's broader co-production-country index.
    expect(asked.some((path) => path.includes('/titles.json?sel=country:SE'))).toBe(false);
    for (const type of ['movie', 'tv'])
      expect(
        discovered.some(
          (url) => url.includes(`/discover/${type}?`) && url.includes('with_origin_country=SE'),
        ),
      ).toBe(true);
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
      // Once atlas is found the row is rebuilt under its own id, so the region drawn first can leave the page
      // mid-scroll; the locator finds the new one on the next try.
      await expect(() => drama.scrollIntoViewIfNeeded({ timeout: 1000 })).toPass();
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
      return r.fulfill({
        json: {
          ids: [300, 301],
          mixed: [
            { type: 'movie', id: 300 },
            { type: 'series', id: 701 },
            { type: 'movie', id: 301 },
          ],
        },
      });
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
    // Under All, atlas's similar titles of both types: a series among them opens as a series.
    await expect(grid.getByRole('link', { name: 'Series 701 2025' })).toHaveAttribute(
      'href',
      '/tv/701-series-701',
    );

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
