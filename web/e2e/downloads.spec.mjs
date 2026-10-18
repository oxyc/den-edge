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

    const values = shared.rows.get('set:download:tv:1399:2:4').values;
    expect(JSON.parse(values.release.value.string).identity).toBe('second.mkv');
    // The chosen release races beside the partial one (§17 `race`).
    expect(JSON.parse(values.race.value.string).entries[0].identity).toBe('first.mkv');
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
  // The fixture waits for den-core's sync policy before mounting. A module's top-level await can outlive the page
  // load event, especially on a busy CI runner, so wait for the fixture API instead of an arbitrary delay.
  await page.waitForFunction(() => window.downloadsFixture !== undefined);
  expect(seasonRequests).toBe(0);

  await page.evaluate(() => window.downloadsFixture.setActive(true));
  await expect.poll(() => seasonRequests).toBe(1);
  await expect(page.locator('.card img')).toHaveCount(0);

  // A windowed Downloading shelf destroys a card after it leaves the horizontal viewport. Recreating it within the
  // failure quiet period must retain the semantic recovery, not turn that remount into another season request.
  await page.evaluate(() => window.downloadsFixture.setMounted(false));
  await expect(page.locator('.card')).toHaveCount(0);
  await page.evaluate(() => window.downloadsFixture.setMounted(true));
  await expect(page.locator('.card')).toHaveCount(1);
  await page.waitForTimeout(100);
  expect(seasonRequests).toBe(1);

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

/** A release as den-scout lists it, by file name: an uncached, seeded 1080p unless told otherwise. */
function release(filename, { cached = false, seeders = 10, resolution = '1080p', codec } = {}) {
  const url = `/scout/p/${encodeURIComponent(filename.toLowerCase())}`;
  return {
    filename,
    url,
    label: filename,
    cached,
    seeders,
    badges: ['1080p'],
    languages: [],
    probed: true,
    identity: filename.toLowerCase(),
    attributes: { resolution, cached, seeders, ...(codec ? { codec } : {}) },
  };
}

/**
 * den-hearth's `/den/<config>/wanted`, as far as these specs need it: every list the holder sent, and each item
 * answered `searching` unless the spec has Hearth start it (`started`, by content key).
 */
async function routeHearth(page) {
  const hearth = { lists: [], started: {} };
  await page.route('**/fixture-hearth/wanted', (route) => {
    const { items } = JSON.parse(route.request().postData());
    hearth.lists.push(items);
    return route.fulfill({
      json: {
        items: items.map((item) =>
          hearth.started[item.key]
            ? { key: item.key, state: 'started', ...hearth.started[item.key] }
            : { key: item.key, state: 'searching', retries: item.retries },
        ),
      },
    });
  });
  return hearth;
}

// Rebecka Martinsson S02E01 as the owner met it: the debrid held only a ~400p AVI, and two 1080p releases were listed
// uncached. A download is kept, so it takes a 1080p (den-spec library-v4 §17); the cached AVI is only what Play takes.
test('a season download takes an uncached 1080p over a cached SD AVI', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
  await guardNetwork(page);
  const shared = store();
  await page.route('**/fixture-store/rows', shared.route);
  await routeHearth(page);
  const listed = {
    1: [
      release('Rebecka.Martinsson.S02E01.400p.WEB-DLRip.ViruseProject.avi', {
        cached: true,
        resolution: null,
      }),
      release('Rebecka.Martinsson.S02E01.1080p.WEB.H264-GRP.mkv', { seeders: 12, codec: 'h264' }),
      release('Rebecka.Martinsson.S02E01.1080p.WEB.H265-GRP.mkv', { seeders: 9, codec: 'hevc' }),
    ],
  };
  await page.route('**/fixture-sources/*', (route) =>
    route.fulfill({
      json: {
        sources: listed[Number(new URL(route.request().url()).pathname.split('/').at(-1))] ?? [],
      },
    }),
  );
  await page.route('**/scout/p/**', (route) =>
    route.fulfill({
      status: 202,
      json: { progress: 0.25, bytesPerSecond: 1_000_000, state: 'downloading', seeds: 5, peers: 9 },
    }),
  );
  await routeTmdb(page, (route) => route.fulfill({ json: { episodes: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/downloads.html?page=season`);

  await page.getByRole('button', { name: 'Download season 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'queued' })).toHaveText(
    '1 queued · 0 already ready · 3 searching for a release · 1 waiting to air',
  );
  const saved = JSON.parse(
    shared.rows.get('set:download:tv:70742:2:1').values.release.value.string,
  );
  expect(saved.identity).toBe('rebecka.martinsson.s02e01.1080p.web.h264-grp.mkv');
  await expect(page.locator('[data-download="tv:70742:2:1"]')).toContainText('Downloading 25%');
});

// Rebecka Martinsson S2 sat a week with nothing playable: the 1080p it started on never moved, and the only cached
// release was an SD AVI. The download races alternates once its release stalls, and takes the AVI only after a day
// with nothing watchable (den-spec library-v4 §17 *Racing*).
test('Rebecka S2: a stalled 1080p races the next two, and the cached AVI is taken only after a day', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
  await guardNetwork(page);
  const shared = store();
  await page.route('**/fixture-store/rows', shared.route);
  await routeHearth(page);
  const avi = 'Rebecka.Martinsson.S02E01.400p.WEB-DLRip.ViruseProject.avi';
  const h264 = 'Rebecka.Martinsson.S02E01.1080p.WEB.H264-GRP.mkv';
  const hevc = 'Rebecka.Martinsson.S02E01.1080p.WEB.H265-GRP.mkv';
  const hd = 'Rebecka.Martinsson.S02E01.720p.HDTV.H264-GRP.mkv';
  const listed = {
    1: [
      release(avi, { cached: true, resolution: null }),
      release(h264, { seeders: 12, codec: 'h264' }),
      release(hevc, { seeders: 9, codec: 'hevc' }),
      release(hd, { seeders: 4, codec: 'h264', resolution: '720p' }),
    ],
  };
  await page.route('**/fixture-sources/*', (route) =>
    route.fulfill({
      json: {
        sources: listed[Number(new URL(route.request().url()).pathname.split('/').at(-1))] ?? [],
      },
    }),
  );
  const asked = [];
  await page.route('**/scout/p/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    asked.push(`${request.method()} ${decodeURIComponent(url.pathname)}`);
    if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    // The 1080p it starts on never moves; the alternates crawl, the debrid projecting days.
    const stuck = url.pathname.includes(encodeURIComponent(h264.toLowerCase()));
    return route.fulfill({
      status: 202,
      json: stuck
        ? { progress: 0, bytesPerSecond: 0, state: 'downloading', seeds: 1, peers: 2 }
        : { progress: 0.01, bytesPerSecond: 20_000, etaSeconds: 200_000, state: 'downloading' },
    });
  });
  await routeTmdb(page, (route) => route.fulfill({ json: { episodes: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/downloads.html?page=season`);

  await page.getByRole('button', { name: 'Download season 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'queued' })).toHaveText(
    '1 queued · 0 already ready · 3 searching for a release · 1 waiting to air',
  );
  const values = () => shared.rows.get('set:download:tv:70742:2:1').values;
  const releaseNow = () => JSON.parse(values().release.value.string).identity;
  const racing = () =>
    values().race ? JSON.parse(values().race.value.string).entries.map((e) => e.identity) : [];
  expect(releaseNow()).toBe(h264.toLowerCase());

  // Twenty minutes without moving: the 1080p stalls. It keeps going, and the next two race beside it.
  await page.clock.fastForward('21:00');
  await page.evaluate(() => window.downloadsFixture.refresh());
  await page.evaluate(() => window.downloadsFixture.refresh());
  await expect.poll(racing).toEqual([hevc.toLowerCase(), hd.toLowerCase()]);
  expect(releaseNow()).toBe(h264.toLowerCase());
  expect(asked.some((ask) => ask.startsWith('DELETE'))).toBe(false);

  // A day on, nothing has finished: the cached AVI is taken rather than wait, and the race is cancelled.
  await page.clock.fastForward('24:00:00');
  await page.evaluate(() => window.downloadsFixture.refresh());
  await page.evaluate(() => window.downloadsFixture.refresh());
  await expect.poll(releaseNow).toBe(avi.toLowerCase());
  expect(racing()).toEqual([]);
  expect(asked.filter((ask) => ask.startsWith('DELETE')).length).toBeGreaterThan(0);
});

// The owner's Rebecka Martinsson season 2: a Nordic series whose episodes are sparsely seeded. One is cached, one has
// a seeded release, one has nothing listed at all, one only an unseeded release, and one hasn't aired.
async function rebeckaSeason(page) {
  await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
  await guardNetwork(page);
  const shared = store();
  await page.route('**/fixture-store/rows', shared.route);
  const listed = {
    1: [release('Rebecka.Martinsson.S02E01.400p.WEB-DLRip.ViruseProject.avi', { cached: true })],
    2: [release('Rebecka.Martinsson.S02E02.1080p.WEB-DLRip.ViruseProject.mkv', { seeders: 3 })],
    3: [],
    4: [release('Rebecka.Martinsson.S02E04.1080p.WEB-DLRip.ViruseProject.mkv', { seeders: 0 })],
  };
  await page.route('**/fixture-sources/*', (route) =>
    route.fulfill({
      json: {
        sources: listed[Number(new URL(route.request().url()).pathname.split('/').at(-1))] ?? [],
      },
    }),
  );
  const probed = [];
  await page.route('**/scout/p/**', (route) => {
    probed.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 202,
      json: { progress: 0.25, bytesPerSecond: 1_000_000, state: 'downloading', seeds: 5, peers: 9 },
    });
  });
  const hearth = await routeHearth(page);
  // The Downloads page recovers episode stills from the season listing.
  await routeTmdb(page, (route) => route.fulfill({ json: { episodes: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/downloads.html?page=season`);
  return { shared, listed, probed, hearth };
}

const seasonPack = () =>
  release('Rebecka.Martinsson.S02.1080p.AMZN.WEB-DL.DD+2.0.H.264-playWEB', { seeders: 4 });

// Each episode ends as a download that keeps trying, survives a reload, and starts by itself once a release turns up.
test('a season download keeps every episode until it can be fetched', async ({ page }) => {
  const { shared, listed, probed } = await rebeckaSeason(page);

  await page.getByRole('button', { name: 'Download season 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'already ready' })).toHaveText(
    '1 queued · 1 already ready · 2 searching for a release · 1 waiting to air',
  );
  const card = (episode) => page.locator(`[data-download="tv:70742:2:${episode}"]`);
  await expect(card(2)).toContainText('Downloading 25%');
  for (const episode of [3, 4]) {
    await expect(card(episode)).toContainText('Searching for a release');
    await expect(card(episode)).toContainText('Searching again');
  }
  await expect(card(5)).toContainText('Waiting for it to air');
  await expect(card(5)).toContainText('Airs');
  // Every episode not already there is a library row, so every device sees it and it outlives this page.
  for (const episode of [2, 3, 4, 5])
    expect(shared.rows.has(`set:download:tv:70742:2:${episode}`), `E${episode}`).toBe(true);

  await page.reload();
  await expect(card(3)).toContainText('Searching for a release');

  // The season pack gets seeded. The next search after the first wait (12–18 minutes) starts it, unasked.
  listed[3] = [seasonPack()];
  await page.clock.fastForward('20:00');
  // Twenty minutes without a pass lets the lease lapse: the first pass drops it, the next takes it again (§17).
  await page.evaluate(() => window.downloadsFixture.refresh());
  await page.evaluate(() => window.downloadsFixture.refresh());
  await expect(card(3)).toContainText('Downloading 25%');
  await expect(card(3)).toContainText('playWEB');
  // E4's release is still unseeded: still searching, with a longer wait, and nothing was added for it.
  await expect(card(4)).toContainText('Searching for a release');
  expect(probed.some((path) => path.includes('s02e04'))).toBe(false);
});

// The same season with no Den client open: an Apple TV in the background and a closed tab search for nothing. The
// holder hands Hearth what it is still looking for; Hearth starts E3's pack meanwhile, and the next client open adopts
// that start into the row as if it had picked it.
test('Hearth starts a wanted episode while no client is open, and the next one adopts it', async ({
  page,
}) => {
  const { shared, listed, probed, hearth } = await rebeckaSeason(page);
  await page.getByRole('button', { name: 'Download season 2' }).click();
  // The whole pass, not just its first episode: a holder pass sooner hands Hearth a list the pass is still adding to.
  await expect(page.getByRole('status').filter({ hasText: 'already ready' })).toHaveText(
    '1 queued · 1 already ready · 2 searching for a release · 1 waiting to air',
  );

  // The holder's pass hands Hearth the wanted rows — what Scout lists each under and its schedule, nothing more. A
  // pass the scheduler started meanwhile may have sent an earlier list, so the one asserted on is the latest.
  const keys = () => (hearth.lists.at(-1) ?? []).map((item) => item.key).sort();
  await expect
    .poll(async () => {
      await page.evaluate(() => window.downloadsFixture.refresh());
      return keys();
    })
    .toEqual(['tv:70742:2:3', 'tv:70742:2:4', 'tv:70742:2:5']);
  const sent = hearth.lists.at(-1);
  const allowed = [
    'airDate',
    'episode',
    'imdb',
    'key',
    'originalLanguage',
    'preferredLanguage',
    'queuedAt',
    'retries',
    'season',
    'since',
    'tried',
  ];
  for (const item of sent) {
    expect(
      Object.keys(item).every((key) => allowed.includes(key)),
      JSON.stringify(item),
    ).toBe(true);
    expect(item).toMatchObject({ imdb: 'tt6623682', season: 2, retries: 0, tried: [] });
  }
  expect(sent.find((item) => item.episode === 5).airDate).toBeGreaterThan(Date.now());

  // Every client closes. Meanwhile the pack is seeded, and Hearth's search starts it for E3.
  await page.goto('about:blank');
  const startedAt = Date.parse('2026-10-17T12:05:00Z');
  const pack = seasonPack();
  listed[3] = [pack];
  hearth.started['tv:70742:2:3'] = { identity: pack.identity, startedAt, retries: 1 };
  const addsBefore = probed.length;

  // Reopened: once the old window's lease has lapsed (ten minutes observed), its first holder pass adopts the start.
  await page.goto(`${E2E_ORIGIN}/test/downloads.html?page=season`);
  const card = (episode) => page.locator(`[data-download="tv:70742:2:${episode}"]`);
  await expect(card(3)).toContainText('Searching for a release');
  await page.evaluate(() => window.downloadsFixture.refresh());
  await page.clock.fastForward('11:00');
  await page.evaluate(() => window.downloadsFixture.refresh());
  await expect(card(3)).toContainText('Downloading 25%');
  await expect(card(3)).toContainText('playWEB');

  // The row names the release as the holder's pick would, queued when Hearth made the add rather than now.
  const row = shared.rows.get('set:download:tv:70742:2:3');
  expect(JSON.parse(row.values.release.value.string).identity).toBe(pack.identity);
  expect(row.values.queuedAt.value.int).toBe(startedAt);
  expect(row.values.retries.value.int).toBe(1);
  expect(row.values.exhausted.value.bool).toBe(false);
  // The add this client made is for its own ticket for that release (den-scout de-duplicates Hearth's).
  expect(probed.slice(addsBefore).some((path) => path.includes('playweb'))).toBe(true);

  // The next list it hands Hearth no longer has E3; E4 and E5 are still looked for.
  await page.evaluate(() => window.downloadsFixture.refresh());
  await expect
    .poll(() =>
      hearth.lists
        .at(-1)
        .map((item) => item.key)
        .sort(),
    )
    .toEqual(['tv:70742:2:4', 'tv:70742:2:5']);
});
