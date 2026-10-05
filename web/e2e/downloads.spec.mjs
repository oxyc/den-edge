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
          'aaaaaaaaaaaaaaaa.name': {
            value: { string: 'Chrome on Mac' },
            at: [1, 0, 'aaaaaaaaaaaaaaaa'],
          },
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

async function open(context, shared, query, tmdb = movie) {
  const page = await context.newPage();
  await guardNetwork(page);
  await page.route('**/fixture-store/rows', shared.route);
  await routeTmdb(page, (r) => r.fulfill({ json: tmdb }));
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
  await page.route('**/scout/p/**', (r) =>
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

test('an older episode download recovers and keeps its episode still', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const shared = store();
    const at = [1, 0, 'aaaaaaaaaaaaaaaa'];
    shared.rows.set('set:download:tv:1399:2:4', {
      kind: 'set',
      schema: 2,
      name: 'download:tv:1399:2:4',
      values: {
        release: {
          value: {
            string: JSON.stringify({
              identity: 'episode-four.mkv',
              label: 'Episode.Four.1080p.mkv',
              url: '/scout/p/episode-four',
            }),
          },
          at,
        },
        title: {
          value: {
            // Rows queued before episode artwork was added have the series poster but no stillPath.
            string: JSON.stringify({
              mediaType: 'tv',
              mediaId: 1399,
              season: 2,
              episode: 4,
              title: 'A Series',
              posterPath: '/series.jpg',
            }),
          },
          at,
        },
        queuedAt: { value: { int: 1 }, at },
      },
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await open(context, shared, 'page=downloads', {
      episodes: [{ episode_number: 4, name: 'Four', still_path: '/episode-four.jpg' }],
    });
    const card = page.locator('[data-download="tv:1399:2:4"]');
    await expect(card.locator('img')).toHaveAttribute('src', /\/episode-four\.jpg$/);
    await expect(card.locator('img')).not.toHaveAttribute('src', /\/series\.jpg$/);
  } finally {
    await browser.close();
  }
});

test('Try another can resume a previous release beside the current partial', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const shared = store();
    const at = [1, 0, 'aaaaaaaaaaaaaaaa'];
    shared.rows.set('set:download:tv:1399:2:4', {
      kind: 'set',
      schema: 2,
      name: 'download:tv:1399:2:4',
      values: {
        release: {
          value: {
            string: JSON.stringify({
              identity: 'second.mkv',
              label: 'Second release',
              url: '/scout/p/second',
            }),
          },
          at,
        },
        title: {
          value: {
            string: JSON.stringify({
              mediaType: 'tv',
              mediaId: 1399,
              season: 2,
              episode: 4,
              title: 'A Series',
            }),
          },
          at,
        },
        queuedAt: { value: { int: 1 }, at },
        tried: { value: { strings: ['first.mkv'] }, at },
      },
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await open(context, shared, 'page=downloads', {
      episodes: [{ episode_number: 4, name: 'Four', still_path: '/episode-four.jpg' }],
    });
    const card = page.locator('[data-download="tv:1399:2:4"]');
    await card.getByRole('button', { name: 'Try another', exact: true }).click();
    await card.getByRole('combobox', { name: 'Try another release' }).selectOption({
      label: 'First release',
    });
    await expect(
      card.getByRole('status').filter({ hasText: 'Also trying First release' }),
    ).toBeVisible();

    const saved = JSON.parse(
      shared.rows.get('set:download:tv:1399:2:4').values.release.value.string,
    );
    expect(saved.identity).toBe('second.mkv');
    expect(saved.hedge.identity).toBe('first.mkv');
  } finally {
    await browser.close();
  }
});

test('a legacy episode recovers its still only once its retained page becomes visible', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-05T12:00:00Z') });
  await guardNetwork(page);
  let seasonRequests = 0;
  await page.route('**/tmdb/3/tv/1399/season/*', (route) => {
    seasonRequests += 1;
    if (seasonRequests === 1) return route.fulfill({ status: 503, json: { retry: true } });
    const season = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({
      json: {
        episodes: [
          season === 2
            ? { episode_number: 4, name: 'Four', still_path: '/four.jpg' }
            : { episode_number: 1, name: 'One', still_path: '/one.jpg' },
        ],
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>',
    }),
  );

  await page.goto(`${E2E_ORIGIN}/test/downloads.html?page=artwork&hidden`);
  await page.waitForTimeout(200);
  expect(seasonRequests).toBe(0);

  await page.evaluate(() => window.downloadsFixture.setActive(true));
  await expect.poll(() => seasonRequests).toBe(1);
  await expect(page.locator('.card img')).toHaveCount(0);

  // Poll progress replaces the download row and nested title object. The semantic episode is unchanged, so no
  // second recovery is scheduled even though a season answer would now be hot in the cache.
  await page.evaluate(() => window.downloadsFixture.refreshIdentity());
  await page.waitForTimeout(100);
  expect(seasonRequests).toBe(1);

  // A temporary failure is not kept forever and does not busy-loop: the next visibility activation after its
  // quiet period retries the legacy artwork once.
  await page.evaluate(() => window.downloadsFixture.setActive(false));
  await page.clock.fastForward(30_001);
  await page.evaluate(() => window.downloadsFixture.setActive(true));
  await expect.poll(() => seasonRequests).toBe(2);
  await expect(page.locator('.card img')).toHaveAttribute('src', /\/four\.jpg$/);

  await page.evaluate(() => window.downloadsFixture.changeEpisode());
  await expect.poll(() => seasonRequests).toBe(3);
  await expect(page.locator('.card img')).toHaveAttribute('src', /\/one\.jpg$/);

  await page.evaluate(() => window.downloadsFixture.setActive(false));
  await page.waitForTimeout(200);
  expect(seasonRequests).toBe(3);
});
