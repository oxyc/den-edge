// The shared download queue (oxyc/den#202): a download queued from a title page is a library row, so a reload still
// shows it on /downloads, and another device reads it on its next library read and says who queued it.
import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const movie = {
  id: 42,
  imdb_id: 'tt42',
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  release_date: '2026-01-01',
  overview: 'A movie that needs a download.',
  genres: [{ name: 'Drama' }],
};

/** den-edge's library, as far as this fixture needs it: rows by name, the same for every context. */
function store() {
  const rows = new Map([
    [
      'set:devices',
      {
        kind: 'set',
        schema: 2,
        name: 'devices',
        values: {
          'aaaaaaaaaaaaaaaa.name': { value: { string: 'Chrome on Mac' }, at: [1, 0, 'aaaaaaaaaaaaaaaa'] },
        },
      },
    ],
  ]);
  return {
    rows,
    route: async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const row = JSON.parse(request.postData());
        rows.set(`set:${row.name}`, row);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: [...rows.values()] });
    },
  };
}

async function open(context, shared, query) {
  const page = await context.newPage();
  await guardNetwork(page);
  await page.route('**/fixture-store/rows', shared.route);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="blue"/></svg>',
    }),
  );
  await page.route('**/scout/cfg/stream/movie/tt42.json', (r) =>
    r.fulfill({
      json: {
        streams: [
          {
            title: 'The.Movie.2160p.WEB-DL.mkv',
            url: 'http://scout.invalid/p/ticket42',
            behaviorHints: { filename: 'The.Movie.2160p.WEB-DL.mkv' },
            attributes: { resolution: '2160p', cached: false, seeders: 12, sizeBytes: 8e9 },
          },
        ],
      },
    }),
  );
  await page.route('**/scout/p/ticket42**', (r) =>
    r.fulfill({
      status: 202,
      json: { progress: 0.25, bytesPerSecond: 1_000_000, state: 'downloading', seeds: 5, peers: 9 },
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/downloads.html?${query}`);
  return page;
}

test('a download queued on a title page is a row every device reads', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const shared = store();
    const here = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const title = await open(here, shared, 'page=title');
    await title.getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(() => shared.rows.has('set:download:movie:42:-1:-1')).toBe(true);

    // A reload reads the queue back from the library, not from this tab.
    await title.goto(`${E2E_ORIGIN}/test/downloads.html?page=downloads`);
    const card = title.locator('[data-download="movie:42:-1:-1"]');
    await expect(card).toContainText('The Movie');
    await expect(card).toContainText('Downloading 25%');
    await expect(card.getByRole('button', { name: 'Cancel download' })).toBeVisible();
    // This browser queued it, so it says nothing about who did.
    await expect(card).not.toContainText('Queued from');

    // Another device, on its next read of the library.
    const there = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const other = await open(there, shared, 'page=downloads&device=bbbbbbbbbbbbbbbb');
    const theirs = other.locator('[data-download="movie:42:-1:-1"]');
    await expect(theirs).toContainText('The Movie', { timeout: 2000 });
    await expect(theirs).toContainText('Queued from Chrome on Mac');
    expect(await other.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await browser.close();
  }
});
