import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

const spatialModule = /\/(?:src\/lib\/spatialNavigation\.ts|assets\/spatialNavigation-[^/]+\.js)$/;

async function openGuest(page) {
  await routeGuestEdge(page, newEdge());
  await page.goto(E2E_ORIGIN);
}

async function browse(page) {
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

test('pointer-only browsing does not fetch directional geometry', async ({ page }) => {
  const geometryRequests = [];
  page.on('request', (request) => {
    if (spatialModule.test(new URL(request.url()).pathname)) geometryRequests.push(request.url());
  });
  await openGuest(page);
  await page.getByLabel('This device’s name').click();
  await page.getByLabel('This device’s name').fill('Keyboard fixture');
  await browse(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(geometryRequests).toEqual([]);
});

test('Tab and Enter remain native while arrows progressively add directional focus', async ({
  page,
  browserName,
}) => {
  const geometryRequests = [];
  page.on('request', (request) => {
    if (spatialModule.test(new URL(request.url()).pathname)) geometryRequests.push(request.url());
  });
  await openGuest(page);

  const browseButton = page.getByRole('button', { name: 'Look around instead' });
  if (browserName === 'webkit') {
    // macOS WebKit follows the system's default keyboard-access policy: Tab visits form fields but
    // skips links and buttons unless Full Keyboard Access is enabled.
    await page.getByLabel('Link code, twelve characters').click();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('This device’s name')).toBeFocused();
    await browseButton.focus();
  } else {
    for (
      let tabs = 0;
      tabs < 32 && !(await browseButton.evaluate((node) => node === document.activeElement));
      tabs++
    )
      await page.keyboard.press('Tab');
    await expect(browseButton).toBeFocused();
  }
  await page.keyboard.press('Enter');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();

  const home = nav.getByRole('link', { name: 'Home', exact: true });
  const movies = nav.getByRole('link', { name: 'Movies', exact: true });
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect(movies).toBeFocused();
  expect(geometryRequests.length).toBeGreaterThan(0);
});

test('editable controls keep arrow keys for their native caret', async ({ page }) => {
  await openGuest(page);
  await browse(page);
  const input = page.getByRole('searchbox');
  await input.click();
  await input.fill('den');
  await input.evaluate((node) => node.setSelectionRange(1, 1));
  await page.keyboard.press('ArrowRight');
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate((node) => node.selectionStart)).toBe(2);
  await expect(input).toHaveValue('den');
});

test('settings controls follow their rows vertically while keeping native horizontal choices', async ({
  page,
}) => {
  await openGuest(page);
  await browse(page);
  await page.goto(`${E2E_ORIGIN}/settings`);

  const subtitles = page.getByRole('radiogroup', { name: 'Subtitles per language' });
  const selectedSubtitleCount = subtitles.getByRole('radio', { checked: true });
  const hideWatched = page.getByRole('switch', { name: 'Hide watched' });
  await hideWatched.focus();
  await page.keyboard.press('ArrowUp');
  await expect(selectedSubtitleCount).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hideWatched).toBeFocused();

  const region = page.getByRole('combobox', { name: 'Region' });
  const minimumYear = page.getByRole('combobox', { name: 'Minimum year' });
  await minimumYear.focus();
  await page.keyboard.press('ArrowUp');
  await expect(region).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(minimumYear).toBeFocused();

  // A segmented control remains a native radio group across the row.
  await selectedSubtitleCount.focus();
  await page.keyboard.press('ArrowRight');
  await expect(subtitles.getByRole('radio', { checked: true })).toBeFocused();
});

test('keyboard focus can pass through Search without navigating away from Home', async ({
  page,
}) => {
  await openGuest(page);
  await browse(page);
  const input = page.getByRole('searchbox');
  await input.focus();
  await expect(input).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.type('d');
  await expect(page).toHaveURL(/\/search\?q=d$/);
});

test('person filmography stays in its poster grid when moving to the row above', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/tmdb/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('combined_credits'))
      return route.fulfill({
        json: {
          cast: Array.from({ length: 14 }, (_, index) => ({
            id: 100 + index,
            media_type: 'movie',
            title: `Film ${index + 1}`,
            release_date: '2020-01-01',
            poster_path: `/film-${index}.jpg`,
            vote_count: 1000,
            popularity: 100 - index,
          })),
          crew: [],
        },
      });
    if (path.includes('/person/884'))
      return route.fulfill({
        json: {
          id: 884,
          name: 'Grid Actor',
          profile_path: '/actor.jpg',
          biography: 'A long biography. '.repeat(40),
          known_for_department: 'Acting',
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#234"/></svg>',
    }),
  );
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await page.goto(`${E2E_ORIGIN}/person/884`);

  const more = page.getByRole('button', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  await expect(more).toHaveCSS('border-radius', '9px');
  await more.focus();
  await expect(more).toHaveCSS('outline-style', 'solid');

  const cards = page.locator('[data-spatial-grid] a.card');
  await expect(cards).toHaveCount(14);
  const columns = await cards.evaluateAll((nodes) => {
    const firstTop = nodes[0].getBoundingClientRect().top;
    return nodes.findIndex((node) => node.getBoundingClientRect().top > firstTop + 2);
  });
  expect(columns).toBeGreaterThan(0);
  await cards.nth(columns).focus();
  await page.keyboard.press('ArrowUp');
  await expect(cards.first()).toBeFocused();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).not.toBeFocused();
});

test('search type arrows stay in the segmented filter without scrolling its rail sideways', async ({
  page,
}) => {
  await openGuest(page);
  await browse(page);
  await page.goto(`${E2E_ORIGIN}/search`);
  const filter = page.getByRole('group', { name: 'Browse movies, series or both' });
  const all = filter.getByRole('link', { name: 'All', exact: true });
  const movies = filter.getByRole('link', { name: 'Movies', exact: true });
  const series = filter.getByRole('link', { name: 'Series', exact: true });
  await all.focus();
  await page.keyboard.press('ArrowRight');
  await expect(movies).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(series).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(series).toBeFocused();
  const rail = page.locator('.explore > .rail');
  await expect(rail).toHaveJSProperty('scrollLeft', 0);

  const genre = page.getByRole('link', { name: 'Drama', exact: true });
  await genre.focus();
  await expect(genre).toHaveCSS('outline-offset', '-3px');
  await expect(rail).toHaveJSProperty('scrollLeft', 0);
});

test('a missing optional geometry module leaves native keyboard behavior intact', async ({
  page,
  browserName,
}) => {
  let attempts = 0;
  await openGuest(page);
  await page.route('**/*spatialNavigation*', (route) => {
    attempts += 1;
    return route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'Optional module missing',
    });
  });
  const documents = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents.push(request.url());
  });
  await browse(page);
  const home = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Home', exact: true });
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => attempts).toBe(1);
  await page.keyboard.press('Tab');
  await expect(home).not.toBeFocused();
  if (browserName === 'webkit')
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Movies', exact: true })
      .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movies$/);
  expect(documents).toEqual([]);
});

for (const interrupt of ['Tab', 'pointer']) {
  test(`a delayed first arrow cannot steal focus after ${interrupt}`, async ({ page }) => {
    let releaseModule;
    const release = new Promise((resolve) => (releaseModule = resolve));
    let requested;
    const requestStarted = new Promise((resolve) => (requested = resolve));
    await openGuest(page);
    await page.route('**/*spatialNavigation*', async (route) => {
      requested();
      await release;
      await route.continue();
    });
    await browse(page);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const home = nav.getByRole('link', { name: 'Home', exact: true });
    const movies = nav.getByRole('link', { name: 'Movies', exact: true });
    await home.focus();
    await page.keyboard.press('ArrowRight');
    await requestStarted;

    let tabFocus;
    if (interrupt === 'Tab') {
      await page.keyboard.press('Tab');
      tabFocus = await page.evaluateHandle(() => document.activeElement);
    } else {
      await nav.getByRole('link', { name: 'Settings', exact: true }).click();
    }
    releaseModule();
    await page.waitForTimeout(200);
    if (interrupt === 'Tab') {
      expect(await tabFocus.evaluate((node) => node === document.activeElement)).toBe(true);
    } else {
      await expect(movies).not.toBeFocused();
      await expect(page).toHaveURL(/\/settings$/);
    }
  });
}
