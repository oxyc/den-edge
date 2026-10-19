import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

const film = (id) => ({
  id,
  title: `Movie ${id}`,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: `/poster-${id}.jpg`,
  backdrop_path: '/backdrop.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1_000,
});

async function remoteTo(page, locator, keys, rounds = 16) {
  const trail = [];
  await expect(locator).toBeVisible({ timeout: 30_000 });
  for (let round = 0; round < rounds; round++) {
    if (
      await locator.evaluateAll((nodes) =>
        nodes.some((node) => node.contains(document.activeElement)),
      )
    )
      return;
    for (const key of keys) {
      await page.keyboard.press(key);
      trail.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute('aria-label') ??
            document.activeElement?.textContent?.trim(),
        ),
      );
      if (
        await locator.evaluateAll((nodes) =>
          nodes.some(
            (node) => node === document.activeElement || node.contains(document.activeElement),
          ),
        )
      )
        return;
    }
  }
  throw new Error(
    `remote did not reach ${await locator.getAttribute('aria-label')}; trail ${JSON.stringify(trail)}`,
  );
}

async function setup(page) {
  await page.addInitScript(() => {
    for (const method of ['showPopover', 'hidePopover', 'togglePopover'])
      delete HTMLElement.prototype[method];
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (selector) {
      if (selector.includes(':popover-open'))
        throw new DOMException(`Unsupported selector: ${selector}`, 'SyntaxError');
      return matches.call(this, selector);
    };
  });
  await routeGuestEdge(page, newEdge());
  await page.route('**/tmdb/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/search/'))
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: Array.from({ length: 12 }, (_, i) => film(i + 1)),
        },
      });
    if (path.includes('/movie/1'))
      return route.fulfill({
        json: {
          ...film(1),
          overview: 'A movie found with the TV search.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: { cast: [], crew: [] },
          recommendations: { results: [] },
          external_ids: {},
          videos: { results: [] },
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#234"/></svg>',
    }),
  );
  await page.goto(E2E_ORIGIN);

  const recovery = page.getByText('Open with a recovery code', { exact: true });
  await remoteTo(page, recovery, ['ArrowDown']);
  const browse = page.getByRole('button', { name: 'Look around instead' });
  await remoteTo(page, browse, ['ArrowDown']);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

test('TV search opens a poster without action menus and Back restores it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);

  const search = page.getByRole('button', { name: 'Search', exact: true });
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).locator(':scope > *').first(),
  ).toHaveAttribute('aria-label', 'Search');
  await remoteTo(page, search, ['ArrowUp', 'ArrowRight', 'ArrowLeft']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search/);
  const editor = page.locator('section.search').getByRole('searchbox');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Movie');

  const card = page.getByRole('link', { name: /Movie 1/ }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ArrowDown');
  await remoteTo(page, card, ['ArrowDown'], 20);
  await expect(card).toBeFocused();
  await expect(page.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
  await card.press('Shift+F10');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await card.dispatchEvent('contextmenu', { button: 2 });
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movie\/1(?:-|$)/);
  await expect(page.getByRole('heading', { name: 'Movie 1', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.hero .head a')).toHaveCount(0);
  await expect(page.locator('.hero .head').getByText('2026', { exact: true })).toBeVisible();
  await expect(page.locator('.hero .head').getByText('Drama', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/search/);
  await expect(editor).toHaveValue('Movie');
  await expect(card).toBeFocused({ timeout: 5_000 });
  expect(errors).toEqual([]);
});
