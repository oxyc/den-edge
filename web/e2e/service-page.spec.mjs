import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/service-page.html`;

/**
 * A service in one country, as TMDB and atlas describe it: Netflix carrying films, and atlas's "New on Netflix"
 * chart, whose first title TMDB has no backdrop for. `chart` decides when that chart answers.
 */
async function serveNetflix(page, { chart = async () => {}, directory } = {}) {
  const asked = [];
  const pageOwned = [];
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
  await routeTmdb(page, async (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.pathname}${url.search}`);
    if (route.request().headers()['x-den-test-fetch-realm'])
      pageOwned.push(`${url.pathname}${url.search}`);
    const path = url.pathname.replace(/^\/(tmdb\/)?3\//, '/');
    if (path.startsWith('/watch/providers/')) {
      if (
        directory &&
        (await directory(route, { path, region: url.searchParams.get('watch_region') }))
      )
        return;
      return route.fulfill({
        json: {
          results:
            path === '/watch/providers/movie'
              ? [
                  {
                    provider_id: 8,
                    provider_name: 'Netflix',
                    logo_path: '/n.jpg',
                    display_priority: 1,
                  },
                ]
              : [],
        },
      });
    }
    if (path.startsWith('/discover/')) return route.fulfill({ json: { results: [] } });
    const id = Number(/^\/movie\/(\d+)$/.exec(path)?.[1]);
    if (id)
      return route.fulfill({
        json: {
          id,
          title: `Film ${id}`,
          overview: `About film ${id}.`,
          // The chart's first title has no picture: the hero must not open on a dark frame for it.
          backdrop_path: id === 101 ? null : `/backdrop-${id}.jpg`,
          poster_path: `/poster-${id}.jpg`,
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="teal"/></svg>',
    }),
  );
  await page.route('**/atlas/manifest.json', (route) => {
    asked.push('/atlas/manifest.json');
    return route.fulfill({
      json: {
        catalogs: [
          { type: 'movie', id: 'jw-nfx-new', name: 'New on Netflix', denProviderIds: [8] },
        ],
      },
    });
  });
  await page.route('**/atlas/catalog/**', async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    await chart();
    return route.fulfill({
      json: {
        metas: [101, 102, 103].map((id) => ({
          type: 'movie',
          moviedb_id: id,
          name: `Film ${id}`,
          posterPath: `/poster-${id}.jpg`,
          releaseInfo: '2026',
        })),
      },
    });
  });
  await page.route('**/metadata/title/query', (route) => route.fulfill({ json: { entries: [] } }));
  return { asked, pageOwned };
}

function requestCount(asked, pathname, params = {}) {
  return asked.filter((request) => {
    const url = new URL(request, E2E_ORIGIN);
    return (
      url.pathname === pathname &&
      Object.entries(params).every(([name, value]) => url.searchParams.get(name) === value)
    );
  }).length;
}

function baseServiceRowCount(asked, sort, votes) {
  const expected = {
    sort_by: sort,
    include_adult: 'false',
    'vote_count.gte': votes,
    with_watch_providers: '8',
    watch_region: 'US',
    with_watch_monetization_types: 'flatrate',
  };
  return asked.filter((request) => {
    const url = new URL(request, E2E_ORIGIN);
    const semantic = [...url.searchParams.keys()].filter(
      (name) => name !== 'api_key' && name !== 'page',
    );
    return (
      url.pathname === '/tmdb/3/discover/movie' &&
      semantic.length === Object.keys(expected).length &&
      Object.entries(expected).every(([name, value]) => url.searchParams.get(name) === value)
    );
  }).length;
}

function servicePageRequests(asked) {
  return {
    manifest: requestCount(asked, '/atlas/manifest.json'),
    movieDirectory: requestCount(asked, '/tmdb/3/watch/providers/movie', {
      watch_region: 'US',
    }),
    tvDirectory: requestCount(asked, '/tmdb/3/watch/providers/tv', { watch_region: 'US' }),
    chart: requestCount(asked, '/atlas/catalog/movie/jw-nfx-new/country=US.json'),
    popular: baseServiceRowCount(asked, 'popularity.desc', '50'),
    acclaimed: baseServiceRowCount(asked, 'vote_average.desc', '300'),
  };
}

function firstScreenRequests(asked) {
  return {
    ...servicePageRequests(asked),
    film101: requestCount(asked, '/tmdb/3/movie/101'),
    film102: requestCount(asked, '/tmdb/3/movie/102'),
    film103: requestCount(asked, '/tmdb/3/movie/103'),
  };
}

const COMPLETE_SERVICE_PAGE = {
  manifest: 1,
  movieDirectory: 1,
  tvDirectory: 1,
  chart: 1,
  popular: 1,
  acclaimed: 1,
};

const COMPLETE_FIRST_SCREEN = {
  ...COMPLETE_SERVICE_PAGE,
  film101: 1,
  film102: 1,
  film103: 1,
};

test('a failed service directory retries in place and resumes the same page', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let unavailable = true;
  const { asked } = await serveNetflix(page, {
    directory: async (route) => {
      if (!unavailable) return false;
      await route.fulfill({ status: 503, json: {} });
      return true;
    },
  });
  await page.goto(`${FIXTURE}?page`);

  const failure = page.getByRole('alert');
  await expect(failure).toContainText(
    'Couldn’t reach the service directory. Check your connection and try again.',
  );
  const retry = failure.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  expect(servicePageRequests(asked)).toMatchObject({ movieDirectory: 1, tvDirectory: 1 });

  unavailable = false;
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Netflix' })).toBeVisible();
  await expect
    .poll(() => servicePageRequests(asked))
    .toMatchObject({
      movieDirectory: 2,
      tvDirectory: 2,
    });
  await expect(page).toHaveURL(`${FIXTURE}?page`);
});

test('only a complete directory presents a service as absent', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let tvUnavailable = false;
  await serveNetflix(page, {
    directory: async (route, { path }) => {
      if (tvUnavailable && path === '/watch/providers/tv')
        await route.fulfill({ status: 503, json: {} });
      else await route.fulfill({ json: { results: [] } });
      return true;
    },
  });

  await page.goto(`${FIXTURE}?page`);
  await expect(page.getByText('This service isn’t listed in US.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  tvUnavailable = true;
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Couldn’t reach the service directory.');
  await expect(page.getByText('This service isn’t listed in US.')).toHaveCount(0);
});

test('a held directory answer cannot replace a newer service route', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let releaseUS;
  const heldUS = new Promise((resolve) => (releaseUS = resolve));
  const { asked } = await serveNetflix(page, {
    directory: async (route, { path, region }) => {
      if (region === 'US') await heldUS;
      const movie = path === '/watch/providers/movie';
      await route.fulfill({
        json: {
          results:
            movie && region === 'CA'
              ? [{ provider_id: 9, provider_name: 'Crave', display_priority: 1 }]
              : movie
                ? [{ provider_id: 8, provider_name: 'Netflix', display_priority: 1 }]
                : [],
        },
      });
      return true;
    },
  });
  await page.goto(`${FIXTURE}?page`);
  await expect
    .poll(() => ({
      movie: requestCount(asked, '/tmdb/3/watch/providers/movie', { watch_region: 'US' }),
      tv: requestCount(asked, '/tmdb/3/watch/providers/tv', { watch_region: 'US' }),
    }))
    .toEqual({ movie: 1, tv: 1 });

  await page.evaluate(() => window.showService(9, 'CA'));
  await expect(page.getByRole('heading', { name: 'Crave' })).toBeVisible();
  releaseUS();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('heading', { name: 'Crave' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Netflix' })).toHaveCount(0);
});

test('the service billboard shows a loading state, then its titles with their picture', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { pageOwned } = await serveNetflix(page, { chart: () => held });
  await page.goto(`${FIXTURE}?page`);

  const hero = page.locator('.hero');
  await expect(hero.getByRole('heading', { name: 'Netflix' })).toBeVisible();
  const loading = hero.getByRole('status');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText('Loading featured titles');
  await expect(page.locator('.billboard .slide')).toHaveCount(0);

  release();
  await expect(loading).toHaveCount(0);
  // Film 101 has no backdrop, so the hero opens on the first title that has one.
  await expect(page.locator('.billboard .slide').first()).toHaveAttribute('aria-label', 'Film 102');
  await expect(page.locator('.billboard img.backdrop.lit')).toHaveAttribute(
    'src',
    /backdrop-102\.jpg$/,
  );
  expect(pageOwned, 'TMDB provider requests must stay inside the content Worker').toEqual([]);
});

test('directional navigation treats the billboard heading as copy, not a duplicate stop', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await serveNetflix(page);
  await page.goto(`${FIXTURE}?page`);

  const hero = page.locator('.hero');
  const headingLink = hero.getByRole('link', { name: 'Film 102', exact: true });
  const more = hero.getByRole('link', { name: 'More', exact: true });
  await expect(headingLink).toBeVisible();
  await more.focus();
  await page.keyboard.press('ArrowUp');
  await expect(headingLink).not.toBeFocused();

  // It remains a normal link in the native Tab order for progressive enhancement.
  await headingLink.focus();
  await expect(headingLink).toBeFocused();
});

test('resting on a service tile starts loading its page before the press', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  const { asked, pageOwned } = await serveNetflix(page);
  await page.goto(FIXTURE);

  const tile = page.getByRole('link', { name: 'Netflix' });
  await expect(tile).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked, 'nothing is fetched for a page nobody has gestured towards').toEqual([]);

  await tile.hover();
  // The hover primes the complete first screen: the Atlas row, its hero art, and the next two rows. Waiting for that
  // semantic boundary avoids mistaking a request still belonging to this first gesture for work from the next one.
  await expect.poll(() => firstScreenRequests(asked)).toEqual(COMPLETE_FIRST_SCREEN);
  expect(pageOwned, 'hover priming must keep TMDB inside the content Worker').toEqual([]);

  // A second gesture within the reuse window asks none of those questions again. A frame lets the pointer event and
  // any fetch it starts become observable without an elapsed-time guess.
  await page.mouse.move(0, 0);
  await tile.hover();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(firstScreenRequests(asked)).toEqual(COMPLETE_FIRST_SCREEN);
});

test('settings re-read with nothing changed leave the page as it is', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  const { asked } = await serveNetflix(page);
  await page.goto(`${FIXTURE}?page`);

  const cards = page.locator('a[href^="/movie/10"]:not(.billboard *)');
  await expect(cards.first()).toBeVisible();
  // Rows below may keep loading while this one is visible; wait on this screen's exact leading questions instead of
  // sampling an unrelated global request count and guessing that 500 ms of quiet means the page is finished.
  await expect.poll(() => servicePageRequests(asked)).toEqual(COMPLETE_SERVICE_PAGE);
  // A row fills its light slots with full cards two per frame (`BrowseRow`'s `materializeNext`), each replacing the
  // slot's placeholder link. Mark the cards once none is still a placeholder, or a card filled in afterwards reads as
  // one the reread rebuilt.
  await expect(page.locator('a.proxy[href^="/movie/10"]:not(.billboard *)')).toHaveCount(0);
  const shown = await cards.count();
  await cards.evaluateAll((all) => all.forEach((card) => (card.dataset.kept = '')));

  await page.evaluate(() => window.reread());
  await expect(page.locator('a[data-kept]')).toHaveCount(shown);
  expect(
    servicePageRequests(asked),
    'nothing that defines this service page is asked again',
  ).toEqual(COMPLETE_SERVICE_PAGE);
});
