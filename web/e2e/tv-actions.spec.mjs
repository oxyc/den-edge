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
    if (new URL(route.request().url()).pathname.includes('/search/'))
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: Array.from({ length: 12 }, (_, i) => film(i + 1)),
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

async function numericBack(page, keyCode) {
  await page.evaluate((code) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { get: () => code });
    (document.activeElement ?? window).dispatchEvent(event);
  }, keyCode);
}

test('TV poster actions work without the native popover API', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);

  const search = page.getByRole('searchbox', {
    name: 'Search titles, people, moods, languages…',
  });
  await remoteTo(page, search, ['ArrowUp', 'ArrowRight', 'ArrowLeft']);
  await page.keyboard.press('Enter');
  const editor = page.locator('section.search').getByRole('searchbox');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Movie');

  const card = page.getByRole('link', { name: /Movie 1/ }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ArrowDown');
  await remoteTo(page, card, ['ArrowDown'], 20);
  const trigger = page.getByRole('button', { name: 'Actions for Movie 1', exact: true });
  await expect(trigger).toHaveCSS('opacity', '0.8');
  await page.keyboard.press('ArrowUp');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');

  const menu = page.getByRole('menu', { name: 'Actions for Movie 1' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role^="menuitem"]').first()).toBeFocused();
  const presentation = await menu.evaluate((element) => {
    const item = element.querySelector('[role^="menuitem"]');
    const menuBox = element.getBoundingClientRect();
    const itemBox = item?.getBoundingClientRect();
    return {
      menu: { left: menuBox.left, top: menuBox.top, width: menuBox.width, height: menuBox.height },
      item: itemBox
        ? { left: itemBox.left, top: itemBox.top, width: itemBox.width, height: itemBox.height }
        : null,
      fontSize: item ? getComputedStyle(item).fontSize : null,
    };
  });
  expect(presentation.menu.left).toBeGreaterThanOrEqual(0);
  expect(presentation.menu.top).toBeGreaterThanOrEqual(0);
  expect(presentation.menu.left + presentation.menu.width).toBeLessThanOrEqual(1920);
  expect(presentation.menu.top + presentation.menu.height).toBeLessThanOrEqual(1080);
  expect(presentation.item?.width).toBeGreaterThan(200);
  await testInfo.attach('tv-action-menu-layout.json', {
    body: Buffer.from(JSON.stringify(presentation, null, 2)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('tv-action-menu.png') });
  await numericBack(page, 461);
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.evaluate(() => {
    window.__actionNavigations = 0;
    document.addEventListener('den:navigate', () => window.__actionNavigations++);
  });
  const moreLikeThis = menu.getByRole('menuitem', { name: 'More like this' });
  await remoteTo(page, moreLikeThis, ['ArrowDown']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?c=like-movie-1$/);
  await expect(menu).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__actionNavigations)).toBe(1);
  expect(errors).toEqual([]);
});
