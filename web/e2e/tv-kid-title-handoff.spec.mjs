import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const movie = {
  id: 42,
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A feature film.',
  vote_average: 7.8,
  vote_count: 1234,
  genres: [{ name: 'Drama' }],
  videos: { results: [] },
  credits: { cast: [] },
};

test('the exact-title Kid handoff uses the configured household Web origin', async ({ page }) => {
  await guardNetwork(page);
  // This spec runs the production TV package, whose same-origin modules live under `/assets/` rather than the
  // browser fixture server's `/src/`. Keep the network guard for every API/external request while admitting the
  // package's own hashed modules.
  await page.route(`${E2E_ORIGIN}/assets/**`, (route) => route.continue());
  await routeTmdb(page, (route) => route.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (route) => route.abort());
  await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions&kid-handoff`);

  const handoff = page.getByRole('button', { name: 'Manage Kid access on Den Web' });
  await handoff.focus();
  await handoff.press('Enter');
  await expect(page.getByRole('status')).toContainText('https://household.example/movie/42');
});
