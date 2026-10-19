import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const LONG_TITLE =
  'The Remarkably Long Chronicle of a Remote Control Crossing Every Shelf Without Losing Its Way';

const movie = (id, title = `Catalog Movie ${id}`) => ({
  id,
  title,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: `/poster-${id}.jpg`,
  backdrop_path: '/backdrop.jpg',
  overview: 'A catalog title used to exercise the real TV search and library surfaces.',
  genre_ids: [18],
  genres: [{ id: 18, name: 'Drama' }],
  vote_average: 8,
  vote_count: 1_000,
  credits: { cast: [], crew: [] },
  recommendations: { results: [] },
  external_ids: {},
});

async function setup(page) {
  await page.addInitScript(() => {
    globalThis.__tvLibraryStressFocus = [];
    let arrowAt = 0;
    addEventListener(
      'keydown',
      (event) => {
        if (event.key.startsWith('Arrow')) arrowAt = performance.now();
      },
      true,
    );
    addEventListener(
      'focusin',
      () => {
        if (!arrowAt) return;
        globalThis.__tvLibraryStressFocus.push(performance.now() - arrowAt);
        arrowAt = 0;
      },
      true,
    );
  });
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  await page.route('**/tmdb/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/search/')) {
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          total_results: 72,
          results: Array.from({ length: 72 }, (_, index) =>
            movie(7_000 + index, index === 43 ? LONG_TITLE : undefined),
          ),
        },
      });
    }
    const id = Number(path.match(/\/movie\/(\d+)$/)?.[1]);
    if (id) return route.fulfill({ json: movie(id, id === 7_043 ? LONG_TITLE : undefined) });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#345"/></svg>',
    }),
  );
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  return edge;
}

async function attachMeasurements(page, testInfo, name, surface, extra = {}) {
  const measurements = await page.evaluate((surfaceSelector) => {
    const surface = document.querySelector(surfaceSelector);
    return {
      userAgent: navigator.userAgent,
      focusLatencyMs: globalThis.__tvLibraryStressFocus,
      documentElements: document.querySelectorAll('*').length,
      surfaceElements: surface?.querySelectorAll('*').length ?? 0,
      cards: surface?.querySelectorAll('.card').length ?? 0,
      routePages: document.querySelectorAll('[data-route-page]').length,
      activeRoutePages: document.querySelectorAll('[data-route-page][data-active="true"]').length,
    };
  }, surface);
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify({ ...measurements, ...extra }, null, 2));
  await testInfo.attach(`${name}.json`, {
    path,
    contentType: 'application/json',
  });
}

async function focusedCard(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const card = active?.closest?.('[data-tv-focus-key]');
    return {
      key: card?.getAttribute('data-tv-focus-key') ?? null,
      text: card?.textContent?.trim() ?? active?.textContent?.trim() ?? null,
      scrollY,
    };
  });
}

async function focusedCardInViewport(page) {
  return page.evaluate(() => {
    const card = document.activeElement?.closest?.('[data-tv-focus-key]');
    if (!card) return false;
    // The metadata may intentionally continue below the fold; the poster is the large focused surface viewers
    // navigate by and must be wholly visible rather than merely intersecting the viewport.
    const box = (card.querySelector('.art') ?? card).getBoundingClientRect();
    const barBottom = document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0;
    return box.top >= barBottom && box.bottom <= innerHeight;
  });
}

async function waitForDocumentScrollSettled(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let quiet;
        const finish = () => {
          removeEventListener('scroll', moved, true);
          resolve();
        };
        const moved = () => {
          clearTimeout(quiet);
          // This is a synchronization boundary after the last scroll event, not a latency pass threshold.
          quiet = setTimeout(finish, 150);
        };
        addEventListener('scroll', moved, true);
        // Arm after the next paint so a smooth scroll scheduled by the focus change cannot look initially idle.
        requestAnimationFrame(() => requestAnimationFrame(moved));
      }),
  );
}

async function remoteInto(page, locator, keys, limit = 30) {
  for (let step = 0; step < limit; step++) {
    const inside = await locator.evaluate((node) => node.contains(document.activeElement));
    if (inside) return;
    await page.keyboard.press(keys[step % keys.length]);
    await page.waitForTimeout(50);
  }
  throw new Error(
    `remote did not enter ${await locator.evaluate((node) => node.outerHTML.slice(0, 120))}`,
  );
}

test('72-result dense Search: remote deep-grid detail and Back restore focus and scroll', async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.goto(`${E2E_ORIGIN}/search`);
  const search = page.locator('section.search').getByRole('searchbox');
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.type('Catalog');

  const grid = page.locator('section.search .grid');
  await expect(grid.getByRole('link')).toHaveCount(72);
  await page.keyboard.press('ArrowDown');
  await remoteInto(page, grid.getByRole('link').first(), ['ArrowDown']);

  // Use only directional keys and enough row transitions to force the document well below its first viewport.
  for (let column = 0; column < 4; column++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
  }
  for (let row = 0; row < 9; row++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
  }
  // Focus changes synchronously, while the document's smooth scroll can take several old-engine frames. Assert
  // the actual viewing outcome rather than sampling a still-moving scroll at one fixed wall-clock delay.
  await expect.poll(() => focusedCardInViewport(page)).toBe(true);
  await waitForDocumentScrollSettled(page);
  await expect.poll(() => focusedCardInViewport(page)).toBe(true);
  await expect.poll(async () => (await focusedCard(page)).scrollY).toBeGreaterThan(300);
  const before = await focusedCard(page);
  expect(before.key).toMatch(/^movie:/);
  expect(Number(before.key.split(':')[1])).toBeGreaterThanOrEqual(7_040);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/movie/${before.key.split(':')[1]}(?:-|$)`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/search/);
  await expect(search).toHaveValue('Catalog');
  await expect.poll(() => focusedCard(page)).toMatchObject({ key: before.key });
  await expect.poll(() => focusedCardInViewport(page)).toBe(true);
  await waitForDocumentScrollSettled(page);
  await expect.poll(() => focusedCardInViewport(page)).toBe(true);
  await expect
    .poll(async () => Math.abs((await focusedCard(page)).scrollY - before.scrollY))
    .toBeLessThanOrEqual(4);
  const restored = await focusedCard(page);

  const long = grid.getByRole('link', { name: new RegExp(LONG_TITLE) });
  await expect(long).toBeVisible();
  const layout = await long.evaluate((node) => {
    const card = node.closest('.card') ?? node;
    const title = card.querySelector('.name');
    const art = card.querySelector('.art');
    const cardBox = card.getBoundingClientRect();
    const titleBox = title?.getBoundingClientRect();
    const artBox = art?.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      cardLeft: cardBox.left,
      cardRight: cardBox.right,
      titleLeft: titleBox?.left,
      titleRight: titleBox?.right,
      titleHeight: titleBox?.height,
      artWidth: artBox?.width,
      artHeight: artBox?.height,
    };
  });
  expect(layout.cardLeft).toBeGreaterThanOrEqual(0);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.titleLeft).toBeGreaterThanOrEqual(layout.cardLeft - 1);
  expect(layout.titleRight).toBeLessThanOrEqual(layout.cardRight + 1);
  expect(layout.titleHeight).toBeGreaterThan(0);
  expect(layout.artWidth).toBeGreaterThan(100);
  expect(layout.artHeight).toBeGreaterThan(150);
  expect(await grid.locator('.card').count()).toBe(72);
  await attachMeasurements(page, testInfo, 'tv-search-72-measurements', 'section.search .grid', {
    scrollRestoration: {
      before: before.scrollY,
      after: restored.scrollY,
      delta: Math.abs(restored.scrollY - before.scrollY),
    },
  });
});

async function savedLibraryJourney(page, testInfo, count) {
  const edge = await setup(page);

  // Start with a real local write, then accept the guest invite so the app migrates that row into the relay-backed
  // library. Every remaining title is saved through the production detail-page action after that handover.
  await page.goto(`${E2E_ORIGIN}/movie/7000`);
  const firstSave = page.getByRole('button', { name: 'Watchlist', exact: true });
  await firstSave.click();
  await expect(firstSave).toHaveAttribute('aria-pressed', 'true');
  await expect(firstSave).not.toHaveAttribute('aria-busy', 'true');
  await page.goto('about:blank');
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);

  for (let id = 7_001; id < 7_000 + count; id++) {
    await page.goto(`${E2E_ORIGIN}/movie/${id}`);
    const save = page.getByRole('button', { name: 'Watchlist', exact: true });
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
  }
  await expect
    .poll(() => [...edge.libraries.values()][0]?.rows.size ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(count);

  await page.goto(`${E2E_ORIGIN}/watchlist`);
  const grid = page.locator('[data-route-page][data-active="true"] .grid');
  await expect(grid.getByRole('link')).toHaveCount(count);
  // Watchlist is intentionally a plain grid, unlike windowed Home shelves: every saved card is mounted.
  await expect(grid.locator('.card')).toHaveCount(count);
  await grid.getByRole('link').first().focus();
  const rows = count === 24 ? 3 : 30;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < 4; column++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(40);
    }
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(40);
  }
  const before = await focusedCard(page);
  expect(before.key).toMatch(/^movie:/);
  expect(before.scrollY).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/movie/${before.key.split(':')[1]}(?:-|$)`));
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect.poll(() => focusedCard(page)).toMatchObject({ key: before.key });
  expect((await focusedCard(page)).scrollY).toBeGreaterThan(0);
  await attachMeasurements(
    page,
    testInfo,
    `tv-saved-library-${count}-measurements`,
    '[data-route-page][data-active="true"] .grid',
  );
}

test('24-title normal saved library: remote deep-grid detail and Back restore focus and scroll', async ({
  page,
}, testInfo) => {
  // CI runs this old-engine journey beside the long TV soak. Each of the 24 saves deliberately crosses a full
  // production detail route, so preserve the behavioral bound without confusing shared-runner contention for a
  // navigation failure.
  test.setTimeout(4 * 60_000);
  await savedLibraryJourney(page, testInfo, 24);
});

test('200-title opt-in saved-library stress: remote deep-grid detail and Back restore focus and scroll', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.DEN_TV_LIBRARY_STRESS_200 !== '1',
    'Set DEN_TV_LIBRARY_STRESS_200=1 for the bounded 200-title persisted-library stress run.',
  );
  // A cold emulated M87 document takes roughly two seconds per production detail/save round trip. Keep this
  // deliberately opt-in workload bounded while allowing all 200 real encrypted UI writes to complete.
  test.setTimeout(10 * 60_000);
  await savedLibraryJourney(page, testInfo, 200);
});
