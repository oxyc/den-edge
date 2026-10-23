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
  await expect(page.getByText('Services unavailable')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('tv-home-1920.png'), fullPage: false });

  const search = page.getByRole('button', { name: 'Search', exact: true });
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
  await expect(editor.getByRole('searchbox')).toHaveCSS('font-size', '32px');
  await page.screenshot({ path: testInfo.outputPath('tv-search-1920.png'), fullPage: false });
  await page.evaluate(() => (window.__tvFocusLatencies = []));
  await page.keyboard.press('ArrowDown');
  await expect(result).toBeFocused();
  const focusRing = await result.evaluate((card) => {
    const cardStyle = getComputedStyle(card);
    const artStyle = getComputedStyle(card.querySelector('.art'));
    return {
      cardOutline: cardStyle.outlineStyle,
      cardShadow: cardStyle.boxShadow,
      artOutline: artStyle.outlineStyle,
      artOutlineColor: artStyle.outlineColor,
      artOutlineWidth: artStyle.outlineWidth,
      artOutlineOffset: artStyle.outlineOffset,
      artShadow: artStyle.boxShadow,
    };
  });
  expect(focusRing).toMatchObject({
    cardOutline: 'none',
    cardShadow: 'none',
    artOutline: 'solid',
    artOutlineColor: 'rgb(255, 255, 255)',
    artOutlineWidth: '4px',
    artOutlineOffset: '-4px',
    artShadow: 'none',
  });
  await page.keyboard.press('ArrowLeft');
  expect(
    await focusedInside(page.locator('section.search .rail')),
    'Left from the first result returns to the category rail',
  ).toBe(true);
  await remoteTo(page, result, ['ArrowRight'], 10);
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('link', { name: /Movie 1006/ }).first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const secondRowResult = page.getByRole('link', { name: /Movie 1011/ }).first();
  await expect(secondRowResult).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('link', { name: /Movie 1006/ }).first()).toBeFocused();
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

test('a touch preview opens Search and focuses its editor within the activating tap', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.__tvSearchTouchActivation = null;
      document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.tv-search-button'))
          return;
        window.__tvSearchTouchActivation = {
          active: navigator.userActivation.isActive,
          editorFocused: document.activeElement?.classList.contains('tv-search-input') ?? false,
        };
      });
    });
    await setup(page);
    await browse(page);
    await page.getByRole('button', { name: 'Search', exact: true }).tap();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator('section.search').getByRole('searchbox')).toBeFocused();
    expect(await page.evaluate(() => window.__tvSearchTouchActivation)).toEqual({
      active: true,
      editorFocused: true,
    });
  } finally {
    await context.close();
  }
});

test('an iPhone preview scales one complete 1920px TV canvas', async ({ browser, browserName }) => {
  test.skip(
    browserName !== 'webkit',
    'The fixed-width iPhone preview is a WebKit viewport contract',
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await setup(page);
    await browse(page);
    await expect(page.getByText('Services unavailable')).toBeVisible({ timeout: 30_000 });
    const layout = await page.evaluate(() => ({
      bodyWidth: document.body.getBoundingClientRect().width,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
      bar: (() => {
        const box = document.querySelector('header.bar')?.getBoundingClientRect();
        return box && { left: box.left, right: box.right, width: box.width };
      })(),
      main: (() => {
        const box = document.querySelector('main')?.getBoundingClientRect();
        return box && { left: box.left, right: box.right, width: box.width };
      })(),
      billboard: (() => {
        const box = document.querySelector('.billboard')?.getBoundingClientRect();
        return box && { left: box.left, right: box.right, width: box.width };
      })(),
      services: (() => {
        const box = document.querySelector('[aria-label="Services"]')?.getBoundingClientRect();
        return box && { left: box.left, right: box.right, width: box.width };
      })(),
    }));
    expect(layout).toMatchObject({
      clientWidth: 1920,
      scrollWidth: 1920,
      viewport: 'width=1920, initial-scale=1',
    });
    expect(layout.bodyWidth).toBeCloseTo(1920);
    expect(layout.bar?.left).toBeCloseTo(96);
    expect(layout.bar?.right).toBeCloseTo(1824);
    expect(layout.bar?.width).toBeCloseTo(1728);
    expect(layout.main?.left).toBeCloseTo(0);
    expect(layout.main?.right).toBeCloseTo(1920);
    expect(layout.main?.width).toBeCloseTo(1920);
    expect(layout.billboard?.left).toBeCloseTo(0);
    expect(layout.billboard?.right).toBeCloseTo(1920);
    expect(layout.billboard?.width).toBeCloseTo(1920);
    expect(layout.services?.left).toBeCloseTo(96);
    expect(layout.services?.right).toBeCloseTo(1824);
    expect(layout.services?.width).toBeCloseTo(1728);
  } finally {
    await context.close();
  }
});

test('Home returns to the TV root without loading a backend document', async ({ page }) => {
  await setup(page, '/movies');
  await browse(page);
  const documents = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents.push(request.url());
  });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(`${E2E_ORIGIN}/`);
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(documents).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
});

test('remote opens Settings and Back returns to the previously focused navigation item', async ({
  page,
}) => {
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
  // The selected page-level navigation item enters the first declared Settings section at its representative
  // control, regardless of row height or which later row happens to share its x coordinate.
  await expect(settings).toBeFocused();
  await remoteTo(page, audioLanguage, ['ArrowDown'], 2);
  await page.keyboard.press('ArrowLeft');
  const contentSection = page.getByRole('link', { name: 'Content', exact: true });
  await remoteTo(page, contentSection, ['ArrowDown'], 2);
  await page.keyboard.press('Enter');
  // RoutePage performs its retained-focus pass on the next animation frame. Under a loaded CI runner a fixed
  // timeout can expire before that frame, letting the pass replace the test's deliberately focused row.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.getByRole('button', { name: /(?:Expand|Collapse) all/ })).toHaveCount(0);

  const subtitleChoices = page.locator('#subtitles-per-language input[type="radio"]');
  const selectedBefore = await subtitleChoices.evaluateAll((radios) =>
    radios.findIndex((radio) => radio.checked),
  );
  expect(selectedBefore).toBeGreaterThanOrEqual(0);
  // Start on the real row immediately above: this isolates the regression where a remote Down skipped both
  // transparent native radios and the following switch while still exercising the production focus engine.
  await page.getByRole('button', { name: /^Visible subtitle languages/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(subtitleChoices.nth(selectedBefore)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const selectedAfter = (selectedBefore + 1) % (await subtitleChoices.count());
  await expect(subtitleChoices.nth(selectedAfter)).toBeFocused();
  await expect(subtitleChoices.nth(selectedAfter)).toBeChecked();

  const hideWatched = page.getByRole('switch', { name: 'Hide watched', exact: true });
  await expect(hideWatched).toBeEnabled();
  await page.keyboard.press('ArrowDown');
  await expect(hideWatched).toBeFocused();
  const wasHidingWatched = await hideWatched.isChecked();
  await page.keyboard.press('Enter');
  await expect(hideWatched).toBeChecked({ checked: !wasHidingWatched });
  await expect(hideWatched).toBeEnabled();
  await expect(hideWatched).toBeFocused();

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
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
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

  const trailer = page.getByRole('link', { name: 'Trailer', exact: true });
  const sources = page.locator('header.hero').getByRole('button', { name: 'Sources', exact: true });
  const search = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', {
    name: 'Search',
    exact: true,
  });
  await expect(sources).toBeVisible({ timeout: 30_000 });
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(sources).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(trailer).toBeFocused();
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
