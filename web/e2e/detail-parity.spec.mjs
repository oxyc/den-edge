import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';
const art =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>';
const credits = {
  cast: [
    { id: 7, name: 'A Person', profile_path: '/person.jpg', roles: [{ character: 'Detective' }] },
  ],
};
const series = {
  name: 'The Series',
  first_air_date: '2020-01-01',
  last_air_date: '2024-02-01',
  status: 'Ended',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A mystery unfolds in a remote village. Every clue connects to the past.',
  external_ids: { imdb_id: 'tt9' },
  vote_average: 7.6,
  vote_count: 1250,
  genres: [{ name: 'Drama' }, { name: 'Mystery' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 2 },
    { season_number: 0, name: 'Specials', episode_count: 1 },
  ],
  last_episode_to_air: { season_number: 2, episode_number: 1 },
  aggregate_credits: credits,
  spoken_languages: [{ english_name: 'Swedish' }],
  production_countries: [{ name: 'Sweden' }],
  networks: [{ name: 'Netflix' }],
  content_ratings: { results: [{ iso_3166_1: 'FI', rating: '16' }] },
  'watch/providers': {
    results: {
      FI: {
        link: 'https://www.themoviedb.org/tv/9/watch',
        flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }],
      },
    },
  },
};
const episodes = (n) => ({
  episodes: [
    {
      episode_number: 1,
      name: `Season ${n} premiere`,
      still_path: `/s${n}.jpg`,
      runtime: 51,
      air_date: '2024-01-01',
      overview: 'Episode 1: The investigation begins.',
    },
    {
      episode_number: 2,
      name: n === 2 ? 'Coming soon' : 'Second episode',
      still_path: '/still.jpg',
      runtime: 48,
      air_date: n === 2 ? '2099-06-30' : '2024-01-08',
      overview: 'This must stay hidden until the episode airs.',
    },
  ],
});
const film = (id, name, year) => ({
  id,
  media_type: 'movie',
  title: name,
  release_date: `${year}-01-01`,
  poster_path: '/poster.jpg',
});
async function setup(
  page,
  { seasonGate = Promise.resolve(), ratingsGate = Promise.resolve() } = {},
) {
  await guardNetwork(page);
  const requests = [];
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: art }),
  );
  await page.route('https://www.omdbapi.com/**', async (r) => {
    await ratingsGate;
    await r.fulfill({
      json: {
        Response: 'True',
        imdbRating: '8.2',
        imdbVotes: '35,000',
        Awards: 'Won 2 awards.',
        Ratings: [
          { Source: 'Rotten Tomatoes', Value: '90%' },
          { Source: 'Metacritic', Value: '78/100' },
        ],
      },
    });
  });
  await page.route('https://api.themoviedb.org/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    requests.push(path);
    if (path.includes('/season/')) {
      const n = Number(path.split('/').at(-1));
      if (n === 2) await seasonGate;
      return r.fulfill({ json: episodes(n) });
    }
    if (path.includes('combined_credits'))
      return r.fulfill({
        json: {
          cast: [film(20, 'Latest acting', 2025), film(21, 'Earlier acting', 2010)],
          crew: [
            { ...film(30, 'New Director Film', 2026), department: 'Directing', job: 'Director' },
            { ...film(31, 'Old Director Film', 2001), department: 'Directing', job: 'Director' },
            ...Array.from({ length: 24 }, (_, i) => ({
              ...film(500 + i, 'Production ' + i, 2026 - i),
              department: 'Production',
              job: 'Producer',
            })),
          ],
        },
      });
    if (path.includes('/person/'))
      return r.fulfill({
        json: {
          name: 'A Person',
          profile_path: '/person.jpg',
          known_for_department: 'Directing',
          biography: 'A career in film and television. '.repeat(50),
        },
      });
    if (path.includes('/tv/')) return r.fulfill({ json: series });
    return r.fulfill({
      json: {
        title: 'A Film',
        poster_path: '/poster.jpg',
        overview: 'A feature film.',
        credits: { cast: [{ id: 7, name: 'A Person', profile_path: '/person.jpg' }] },
      },
    });
  });
  await page.route('**/scout/config/stream/**', (r) =>
    r.fulfill({
      json: {
        streams: [
          {
            title: 'Episode.1080p.WEB.mkv',
            url: 'http://scout.internal/p/ready',
            behaviorHints: { filename: 'Episode.1080p.WEB.mkv' },
            attributes: { cached: true, resolution: '1080p', audio: 'AAC', sizeBytes: 1024 ** 3 },
          },
          {
            title: 'Episode.4K.mkv',
            url: 'http://scout.internal/p/download',
            behaviorHints: { filename: 'Episode.4K.mkv' },
            attributes: { cached: false, resolution: '2160p', seeders: 10 },
          },
        ],
      },
    }),
  );
  await page.addInitScript(() => {
    window.plays = [];
    document.addEventListener('fixture:play', (e) => window.plays.push(e.detail));
  });
  return requests;
}

for (const width of [390, 834, 1280])
  test(`detail parity: artwork, air dates, actions and ratings at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: width < 1000,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let releaseRatings;
      const ratingsGate = new Promise((r) => (releaseRatings = r));
      await setup(page, { ratingsGate });
      await page.goto('http://127.0.0.1:5198/test/detail-parity.html#title/tv/9');
      const active = page.locator('[data-active="true"]');
      await expect(active.locator('h1')).toHaveText('The Series');
      const before = await active.locator('.hero').boundingBox();
      releaseRatings();
      await expect(active.getByText('IMDb', { exact: true })).toBeVisible();
      expect((await active.locator('.hero').boundingBox()).height).toBe(before.height);
      await expect(active.getByText('2020–2024', { exact: true })).toBeVisible();
      await expect(active.getByText('16', { exact: true })).toBeVisible();
      await expect(active.getByRole('link', { name: /Streaming on Netflix/ })).toBeVisible();
      const row = active.locator('.episode').first();
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('.still img')).toBeVisible();
      const still = await row.locator('.still').boundingBox();
      expect(still.width).toBeGreaterThan(95);
      expect(Math.abs(still.width / still.height - 16 / 9)).toBeLessThan(0.02);
      await expect(row.getByText(/51 min/)).toBeVisible();
      await expect(row.locator('.progress')).toBeVisible();
      await row.getByRole('button', { name: /Play episode 1/ }).click();
      expect(await page.evaluate(() => window.plays.at(-1))).toMatchObject({
        season: 1,
        episode: 1,
      });
      await row.getByLabel('Options for episode 1').click();
      await row.getByRole('button', { name: 'Mark watched', exact: true }).click();
      await expect(row.locator('.watched')).toBeVisible();
      await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
      const upcoming = active.locator('.episode').filter({ hasText: 'Coming soon' });
      await expect(upcoming.locator('.air-date')).toContainText('2099');
      await expect(upcoming.locator('.episode-play')).toBeDisabled();
      await expect(upcoming.locator('.overview')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: test.info().outputPath(`episodes-${width}.png`) });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: test.info().outputPath(`hero-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

test('season requests cannot overwrite a newer selection and retained detail and actor tabs survive history', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    let releaseSeason;
    const seasonGate = new Promise((r) => (releaseSeason = r));
    const requests = await setup(page, { seasonGate });
    await page.goto('http://127.0.0.1:5198/test/detail-parity.html#title/tv/9');
    const active = () => page.locator('[data-active="true"]');
    await expect(active().getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await active().getByRole('tab', { name: 'Season 2', exact: true }).click();
    await active().getByRole('tab', { name: 'Season 1', exact: true }).click();
    releaseSeason();
    await expect(active().getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await active().getByRole('tab', { name: 'Season 2', exact: true }).click();
    await expect(active().getByText('Season 2 premiere', { exact: true })).toBeVisible();
    expect(requests.filter((p) => p.endsWith('/season/2'))).toHaveLength(1);
    await active()
      .getByRole('link', { name: /A Person/ })
      .click();
    await expect(active().getByRole('tab', { name: 'Directing' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const portrait = await active().locator('.portrait').boundingBox();
    expect(portrait.height / portrait.width).toBeCloseTo(1.5, 3);
    await active().getByRole('button', { name: 'More', exact: true }).click();
    await active().getByRole('tab', { name: 'Production', exact: true }).click();
    const card = active().getByRole('button', { name: 'Production 8 2018' });
    await card.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    expect(scroll).toBeGreaterThan(300);
    await card.click();
    await expect(active().locator('h1')).toHaveText('A Film');
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await expect(active().locator('h1')).toHaveText('A Person');
    await expect(active().getByRole('tab', { name: 'Production', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(active().getByRole('button', { name: 'Less', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
    await page.goBack();
    await expect(active().getByRole('tab', { name: 'Season 2', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    await browser.close();
  }
});

test('episode Sources target the selected episode and downloads never requeue while polling', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await setup(page);
    const downloadRequests = [];
    await page.route('**/scout/p/download*', (r) => {
      downloadRequests.push(new URL(r.request().url()).search);
      return r.fulfill({ status: 202, json: { progress: 0.3 } });
    });
    await page.goto('http://127.0.0.1:5198/test/detail-parity.html#title/tv/9');
    const active = page.locator('[data-active="true"]');
    await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
    const row = active.locator('.episode').first();
    await expect(row).toContainText('Season 2 premiere');
    await row.getByLabel('Options for episode 1').click();
    await row.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(active.getByText('Sources for S2 · E1')).toBeVisible();
    const source = active.locator('.source-panel li').first();
    await source.getByRole('button', { name: 'Play', exact: true }).click();
    expect(await page.evaluate(() => window.plays.at(-1))).toMatchObject({
      season: 2,
      episode: 1,
      filename: 'Episode.1080p.WEB.mkv',
    });
    await active
      .locator('.source-panel li')
      .last()
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    await expect(active.getByText('Downloading · 30%', { exact: true })).toBeVisible();
    await expect.poll(() => downloadRequests.length, { timeout: 8000 }).toBeGreaterThan(1);
    expect(downloadRequests.filter((q) => q === '')).toHaveLength(1);
    expect(downloadRequests.slice(1).every((q) => q === '?probe=1')).toBe(true);
  } finally {
    await browser.close();
  }
});
