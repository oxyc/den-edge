import { test, expect } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// atlas names a query's titles in one answer; TMDB then draws the ones atlas has no poster for, one lookup each. The
// grid shows atlas's answer at once — a title still waiting shows its name — and each poster as its lookup lands,
// through the content service's progress messages, rather than waiting for the slowest lookup.

const FIXTURE = `${E2E_ORIGIN}/test/nav-search.html`;
const active = (page) => page.locator('[data-route-page][data-active="true"]');
const input = (page) =>
  page.getByRole('searchbox', { name: 'Search titles, people, moods, languages…' });

test('search shows atlas’s titles before a slow poster lookup answers', async ({ page }) => {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/metadata/title/query', (r) => r.fulfill({ status: 404, json: {} }));
  await page.route('**/atlas/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.startsWith('/atlas/index/filter/'))
      return r.fulfill({ status: 404, body: '' });
    if (url.pathname === '/atlas/manifest.json')
      return r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } });
    if (url.pathname === '/atlas/index/query.json')
      return r.fulfill({
        json: {
          people: [],
          hits: [
            { type: 'movie', id: 501, title: 'Slow Poster', year: 2020, f: { t: 1 } },
            {
              type: 'movie',
              id: 502,
              title: 'Quick Poster',
              year: 2021,
              posterPath: '/quick.jpg',
              f: { t: 1 },
            },
          ],
        },
      });
    return r.fulfill({ json: { labels: [] } });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="500" height="750" fill="#264c68"/></svg>',
    }),
  );
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  const asked = [];
  await routeTmdb(page, async (r) => {
    const url = new URL(r.request().url());
    asked.push(url.pathname);
    if (/\/movie\/501$/.test(url.pathname)) {
      await held;
      return r.fulfill({
        json: {
          id: 501,
          title: 'Slow Poster',
          release_date: '2020-01-01',
          poster_path: '/slow.jpg',
          genres: [],
          credits: { cast: [] },
        },
      });
    }
    return r.fulfill({ json: { results: [], total_pages: 1 } });
  });

  await page.goto(FIXTURE);
  await input(page).click();
  await input(page).fill('poster');
  const slow = active(page).getByRole('link', { name: /Slow Poster/ });
  const quick = active(page).getByRole('link', { name: /Quick Poster/ });
  // Both are on screen while TMDB still holds the slow title's lookup.
  await expect(quick).toBeVisible();
  await expect(slow).toBeVisible();
  await expect.poll(() => asked.some((path) => /\/movie\/501$/.test(path))).toBe(true);
  await expect(slow.locator('img[src*="slow.jpg"]')).toHaveCount(0);
  release();
  await expect(slow.locator('img[src*="slow.jpg"]')).toHaveCount(1);
});
