import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const film = (id, title = `Movie ${id}`) => ({
  id,
  title,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: `/poster-${id}.jpg`,
  backdrop_path: '/backdrop.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1_000,
});

async function setup(page, path = '') {
  await routeGuestEdge(page, newEdge());
  await page.route('**/tmdb/**', (route) => {
    if (new URL(route.request().url()).pathname.includes('/search/'))
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: Array.from({ length: 18 }, (_, index) => film(1002 + index)),
        },
      });
    return route.fallback();
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#2c4770"/><stop offset="1" stop-color="#161922"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><circle cx="200" cy="220" r="86" fill="#d7def0" opacity=".16"/></svg>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}${path}`);
}

async function focusedInside(locator) {
  return locator.evaluateAll((nodes) =>
    nodes.some((node) => node === document.activeElement || node.contains(document.activeElement)),
  );
}

/** Reach a real control using only keys emitted by a directional remote. */
async function remoteTo(page, locator, keys, rounds = 12) {
  const trail = [];
  await expect(locator).toBeVisible({ timeout: 30_000 });
  for (let round = 0; round < rounds; round++) {
    if (await focusedInside(locator)) return;
    for (const key of keys) {
      await page.keyboard.press(key);
      if (await focusedInside(locator)) return;
      // Match a physical remote's repeat cadence and give route/row updates a rendering frame.
      await page.waitForTimeout(80);
      trail.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute('aria-label') ??
            document.activeElement?.textContent?.trim(),
        ),
      );
      if (await focusedInside(locator)) return;
    }
  }
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim(),
    label: document.activeElement?.getAttribute('aria-label'),
  }));
  throw new Error(
    `remote did not reach target; focus ended at ${JSON.stringify(focused)}; trail ${JSON.stringify(trail)}`,
  );
}

async function browse(page) {
  const look = page.getByRole('button', { name: 'Look around instead' });
  await remoteTo(page, page.getByText('Open with a recovery code', { exact: true }), ['ArrowDown']);
  await remoteTo(page, look, ['ArrowDown']);
  await page.keyboard.press('Enter');
  await expect(look).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

async function numericBack(page, keyCode) {
  await page.evaluate((code) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { get: () => code });
    (document.activeElement ?? window).dispatchEvent(event);
  }, keyCode);
}

test('remote can pass onboarding, enter search, open a title, and restore its result on Back', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__tvFocusLatencies = [];
    let pressedAt = 0;
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key.startsWith('Arrow')) pressedAt = performance.now();
      },
      true,
    );
    document.addEventListener(
      'focusin',
      () => {
        if (pressedAt) {
          window.__tvFocusLatencies.push(performance.now() - pressedAt);
          pressedAt = 0;
        }
      },
      true,
    );
  });
  await setup(page);
  await browse(page);
  await expect(page.getByText('Services unavailable')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('tv-home-1920.png'), fullPage: false });

  const search = page.getByRole('searchbox', {
    name: 'Search titles, people, moods, languages…',
  });
  await remoteTo(page, search, ['ArrowUp', 'ArrowRight', 'ArrowLeft']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search/);
  const pageSearch = page.locator('section.search').getByRole('searchbox');
  await expect(pageSearch).toBeFocused();
  await page.keyboard.type('Movie');
  await expect(page).toHaveURL(/\/search/);

  // The search field owns Down and transfers focus into its real result grid.
  const result = page.getByRole('link', { name: /Movie 1002/ }).first();
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('section.search .grid').getByRole('link')).toHaveCount(18);
  const resultBox = await result.boundingBox();
  expect(resultBox?.width).toBeGreaterThanOrEqual(190);
  const editor = page.locator('section.search .tv-search-editor');
  expect((await editor.boundingBox())?.width).toBeGreaterThan(1_600);
  await expect(editor.getByRole('searchbox')).toHaveCSS('font-size', '28px');
  await page.screenshot({ path: testInfo.outputPath('tv-search-1920.png'), fullPage: false });
  await page.evaluate(() => (window.__tvFocusLatencies = []));
  await page.keyboard.press('ArrowDown');
  await remoteTo(page, result, ['ArrowDown'], 20);
  await page.keyboard.press('ArrowLeft');
  expect(
    await focusedInside(page.locator('section.search .rail')),
    'Left from the first result returns to the category rail',
  ).toBe(true);
  await remoteTo(page, result, ['ArrowRight'], 10);
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('link', { name: /Movie 1006/ }).first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('link', { name: /Movie 1011/ }).first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
  await expect(result).toBeFocused();
  const focusLatencies = await page.evaluate(() => window.__tvFocusLatencies);
  const orderedLatencies = [...focusLatencies].sort((a, b) => a - b);
  const focusTiming = {
    samples: focusLatencies.length,
    medianMs: orderedLatencies[Math.floor(orderedLatencies.length / 2)],
    p95Ms: orderedLatencies[Math.ceil(orderedLatencies.length * 0.95) - 1],
    worstMs: orderedLatencies.at(-1),
  };
  console.log('TV_SEARCH_FOCUS_LATENCY', JSON.stringify(focusTiming));
  await testInfo.attach('tv-search-focus-latency.json', {
    body: Buffer.from(JSON.stringify(focusTiming, null, 2)),
    contentType: 'application/json',
  });
  expect(focusTiming.samples).toBeGreaterThanOrEqual(10);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movie\/1002(?:-|$)/);
  await expect(page.getByRole('heading', { name: 'Movie 1002', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: testInfo.outputPath('tv-detail-1920.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/search/);
  await expect(pageSearch).toHaveValue('Movie');
  await expect(result).toBeFocused({ timeout: 5_000 });
});

test('remote opens Settings and Back returns to the previously focused navigation item', async ({
  page,
}, testInfo) => {
  await setup(page);
  await browse(page);

  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await remoteTo(page, settings, ['ArrowUp', 'ArrowRight']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

  const audioLanguage = page.getByRole('combobox', { name: 'Audio language', exact: true });
  await expect(audioLanguage).toBeVisible({ timeout: 30_000 });
  await expect(audioLanguage).toBeEnabled();
  // Follow one intentional route through the rendered geometry, asserting every junction. A generic
  // alternating search can validly cycle between the navbar and the page-level Expand all control.
  await expect(settings).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('link', { name: 'Watchlist', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Expand all in Settings' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(audioLanguage).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  const contentSection = page.getByRole('link', { name: 'Content', exact: true });
  await expect(contentSection).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const expandContent = page.getByRole('button', { name: 'Expand all in Content' });
  await remoteTo(page, expandContent, ['ArrowRight'], 4);
  const hiddenGenres = page.getByRole('button', { name: 'Hidden genres', exact: true });
  await remoteTo(page, hiddenGenres, ['ArrowLeft', 'ArrowDown'], 12);
  await page.keyboard.press('Enter');
  const hiddenGenre = page.locator('#hidden-genres input[type="checkbox"]').first();
  await expect(hiddenGenre).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await remoteTo(page, hiddenGenre, ['ArrowLeft'], 10);
  await page.keyboard.press('Enter');
  await expect(hiddenGenre).toBeChecked();
  await expect(hiddenGenre.locator('xpath=..').locator('.mark')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tv-settings-checkbox.png'), fullPage: false });
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/);
  await expect(settings).toBeFocused({ timeout: 5_000 });
});

test('directional focus remains inside a native modal until remote Back closes it', async ({
  page,
}) => {
  await setup(page);
  await browse(page);
  await page.goto(`${E2E_ORIGIN}/movies#invite=${CODE}`);

  const dialog = page.getByRole('dialog', { name: 'Accept this invite?' });
  await expect(dialog).toBeVisible();

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowDown');
    expect(await focusedInside(dialog), `focus escaped the dialog after move ${i + 1}`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: 'Den home' })).toBeFocused();
});

test('LG Back closes a real ARIA trailer dialog without leaving its detail route', async ({
  page,
}) => {
  await setup(page);
  await browse(page);
  await page.route('**/tmdb/3/movie/1002*', (route) =>
    route.fulfill({
      json: {
        ...film(1002),
        overview: 'A movie with a trailer.',
        genres: [{ id: 18, name: 'Drama' }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        external_ids: {},
        videos: {
          results: [{ site: 'YouTube', type: 'Trailer', official: true, key: 'fixture-key' }],
        },
      },
    }),
  );
  await page
    .context()
    .route(/^https:\/\/www\.youtube(-nocookie)?\.com\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>YouTube fixture</title>' }),
    );
  await page.goto(`${E2E_ORIGIN}/movie/1002`);

  const trailer = page.getByRole('button', { name: 'Trailer', exact: true });
  await remoteTo(page, trailer, ['ArrowDown', 'ArrowRight'], 20);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Movie 1002: trailer' });
  await expect(dialog).toBeVisible();
  const detailURL = page.url();

  await numericBack(page, 461);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(detailURL);
  await expect(trailer).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(detailURL);
  await expect(trailer).toBeFocused();
});

test('LG Back on a deep-linked title returns Home and a canceled root exit stays in-app', async ({
  page,
}) => {
  await setup(page, '/movie/1002');
  await browse(page);
  await expect(page).toHaveURL(/\/movie\/1002(?:-|$)/);
  await expect(page.getByRole('heading', { name: 'Movie 1002', level: 1 })).toBeVisible();

  await numericBack(page, 461);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

  await page.evaluate(() => {
    window.__exitRequests = 0;
    window.addEventListener('den:tv-exit-request', (event) => {
      window.__exitRequests += 1;
      event.preventDefault();
    });
  });
  await numericBack(page, 461);
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => window.__exitRequests)).toBe(1);
});
