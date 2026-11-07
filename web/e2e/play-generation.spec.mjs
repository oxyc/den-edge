// A mounted Library owns each Play attempt. RoutedLibrary keys that production tree by ProfileSession, so a profile
// switch or same-profile reopen must cancel an eligibility answer admitted by the old mount before it can reach the
// global player router. This fixture retains Library, ProfileSession, ContentService and the navigation event path;
// its only seam is the deterministic provider reply barrier.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const movie = {
  id: 1001,
  title: 'Movie 1001',
  release_date: '2026-01-01',
  overview: 'A film held at the profile eligibility boundary.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  vote_average: 7.5,
  vote_count: 500,
  genres: [{ id: 18, name: 'Drama' }],
  credits: { cast: [], crew: [] },
  recommendations: { results: [] },
};

async function open(page) {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?play-boundary&address&populated&page=title&type=movie&id=1001`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
}

const stats = (page) => page.evaluate(() => window.denTestPlayBoundary.stats());
const hold = (page) => page.evaluate(() => window.denTestPlayBoundary.hold());
const replace = (page, profile) =>
  page.evaluate((next) => window.denTestPlayBoundary.replace(next), profile);
const release = (page) => page.evaluate(() => window.denTestPlayBoundary.release());
const play = (page) => page.locator('header.hero').getByRole('link', { name: /^(Play|Resume)$/ });

for (const replacement of ['same', 'other']) {
  test(`a held browser Play cannot cross a ${replacement}-profile Library replacement`, async ({
    page,
  }) => {
    await open(page);
    const address = page.url();
    await hold(page);

    await play(page).click();
    await expect.poll(() => stats(page)).toMatchObject({ asked: 1, waiting: 1, cancelled: 0 });

    await replace(page, replacement);
    await expect.poll(() => stats(page)).toMatchObject({ waiting: 0, cancelled: 1 });
    await release(page);
    await expect(page).toHaveURL(address);
    await expect(page.getByText('Blocked by parental controls')).toHaveCount(0);

    // The replacement's own attempt still uses the same production route and succeeds; cancellation did not poison
    // the shared content authority or playback capability.
    await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
    await play(page).click();
    await expect(page).toHaveURL(/\/movie\/1001[^?]*\?play=1$/);
    await expect.poll(() => stats(page)).toMatchObject({ waiting: 0, cancelled: 1 });
    expect((await stats(page)).asked).toBeGreaterThan(1);
  });
}
