import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test('remote shelf focus keeps the entire white poster ring inside clipping boundaries', async ({
  page,
}, info) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/tmdb/**', (route) =>
    route.fulfill({
      json: {
        page: 1,
        total_pages: 1,
        results: Array.from({ length: 20 }, (_, i) => ({
          id: 1002 + i,
          title: `Shelf Movie ${i + 1}`,
          media_type: 'movie',
          release_date: '2026-01-01',
          poster_path: `/shelf-${i}.jpg`,
          genre_ids: [18],
          vote_average: 8,
          vote_count: 1000,
        })),
      },
    }),
  );
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#253958"/></svg>',
    }),
  );
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const search = nav.getByRole('button', { name: 'Search', exact: true });
  await expect(search).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(nav.getByRole('link', { name: 'Movies', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movies$/);

  const track = page.locator('[data-route-page][data-active="true"] .row .track').first();
  const first = track.locator('a.card').first();
  await expect(first).toBeVisible();
  const shelfGeometry = await track.evaluate((node) => {
    const card = node.querySelector('.card');
    if (!card) return null;
    const trackBox = node.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(node).columnGap);
    return {
      cardWidth: cardBox.width,
      cardsAcross: (trackBox.right - cardBox.left + gap) / (cardBox.width + gap),
    };
  });
  expect(shelfGeometry).not.toBeNull();
  // At 1920px the ten-foot token is 13vw: roughly six and a half posters remain visible, rather than the web
  // shelf's 190px maximum fitting about eight and a half. This exercises the rendered inheritance boundary that
  // a token/class assertion would miss.
  expect(shelfGeometry.cardWidth).toBeCloseTo(249.6, 0);
  expect(shelfGeometry.cardsAcross).toBeGreaterThan(6.5);
  expect(shelfGeometry.cardsAcross).toBeLessThan(7);
  for (let i = 0; i < 30 && !(await track.locator('a.card:focus').count()); i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
  }
  await expect(track.locator('a.card:focus')).toHaveCount(1);
  for (let i = 0; i < 20 && !(await first.evaluate((node) => node === document.activeElement)); i++)
    await page.keyboard.press('ArrowLeft');
  await expect(first).toBeFocused();
  await expect(first.locator('.art')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(first).toHaveCSS('outline-style', 'none');
  await expect(first).toHaveCSS('box-shadow', 'none');
  await expect(first.locator('.art')).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
  await expect(first.locator('.art')).toHaveCSS('outline-offset', '-4px');
  const clippedBy = await first.locator('.art').evaluate((art) => {
    const rect = art.getBoundingClientRect();
    const clipped = [];
    for (let node = art.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const paint = /paint|strict|content/.test(style.contain);
      const x = paint || /hidden|clip|auto|scroll/.test(style.overflowX);
      const y = paint || /hidden|clip|auto|scroll/.test(style.overflowY);
      if (
        (x && (rect.left < box.left - 1 || rect.right > box.right + 1)) ||
        (y && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1))
      )
        clipped.push(node.className || node.tagName);
    }
    return clipped;
  });
  expect(clippedBy).toEqual([]);
  await expect(page.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('tv-shelf-focus.png') });
  await page.keyboard.press('ArrowRight');
  const second = track.locator('a.card').nth(1);
  await expect(second).toBeFocused();
  await expect(first.locator('.art')).toHaveCSS('transform', 'matrix(0.97, 0, 0, 0.97, 0, 0)');
});

test('service focus draws one white artwork ring without an outer anchor ring', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/tmdb/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/(?:tmdb\/)?3\//, '/');
    if (path === '/watch/providers/movie' || path === '/watch/providers/tv')
      return route.fulfill({
        json: {
          results: [
            {
              provider_id: 8,
              provider_name: 'Netflix',
              logo_path: '/netflix.jpg',
              display_priority: 1,
            },
          ],
        },
      });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const service = page.locator('a.tile').first();
  await expect(service).toBeVisible({ timeout: 30_000 });
  await service.focus();
  await expect(service).toHaveCSS('outline-style', 'none');
  await expect(service).toHaveCSS('box-shadow', 'none');
  await expect(service.locator('.art')).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
  await expect(service.locator('.art')).toHaveCSS('outline-width', '4px');
  await expect(service.locator('.art')).toHaveCSS('outline-offset', '-4px');
});
