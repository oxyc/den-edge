// den-edge#258: pressing "Mark watched" in an episode row's own ⋯ menu had no feedback of its own when the
// write failed — `failure` only renders inside `TitleActions`, in the hero, far above an episode list the
// viewer has usually scrolled past. From there the press looked exactly like it had done nothing at all.
// `Library.svelte`'s `markEpisodeSeen` now puts the same word on the page toast (`LibraryStatus`), which is
// what every other library write already does on a refusal.
import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const series = {
  id: 5001,
  name: 'A Series',
  first_air_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A series, for the detail page to show.',
  genres: [{ name: 'Drama' }],
  vote_average: 7.5,
  vote_count: 500,
  credits: { cast: [] },
  recommendations: { results: [] },
  seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }],
  last_episode_to_air: { season_number: 1, episode_number: 1 },
};
const season = {
  episodes: [{ episode_number: 1, name: 'Episode One', air_date: '2026-01-01', runtime: 42 }],
};

async function openTitle(page, query = '') {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => {
    const path = new URL(r.request().url()).pathname;
    return r.fulfill({ json: path.includes('/season/') ? season : series });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/library.html?populated&page=title&type=tv&id=5001${query}`);
  await expect(page.getByRole('heading', { name: 'A Series', level: 1 })).toBeVisible();
}

const episodeMenu = (page) => page.getByRole('button', { name: 'Options for episode 1' });
const markWatched = (page) => page.getByRole('menuitem', { name: 'Mark watched', exact: true });
const episodeRow = (page) => page.locator('.episode').first();
const toast = (page) => page.locator('p.library-status.toast');

test('marking an episode watched succeeds silently, with no stray alert', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage();
    await openTitle(page);
    await episodeMenu(page).click();
    await markWatched(page).click();
    await expect(episodeRow(page).locator('.watched')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a refused episode mark says so on the page toast, not only in the far-off hero', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage();
    await openTitle(page, '&failing');
    await episodeMenu(page).click();
    await markWatched(page).click();
    await expect(toast(page)).toHaveText('Couldn’t save that. Check that this device is on your network.');
    // Nothing was actually written: the row stays unwatched, and the item still offers to mark it.
    await expect(episodeRow(page).locator('.watched')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
