import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';
const art =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>';
const credits = {
  cast: [
    { id: 7, name: 'A Person', profile_path: '/person.jpg', roles: [{ character: 'Detective' }] },
  ],
};
const series = {
  name: 'The Series',
  original_language: 'sv',
  first_air_date: '2020-01-01',
  last_air_date: '2024-02-01',
  status: 'Ended',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A mystery unfolds in a remote village. Every clue connects to the past.',
  external_ids: { imdb_id: 'tt9' },
  vote_average: 7.6,
  vote_count: 1250,
  genres: [
    { id: 18, name: 'Drama' },
    { id: 9648, name: 'Mystery' },
  ],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 2 },
    { season_number: 0, name: 'Specials', episode_count: 1 },
  ],
  last_episode_to_air: { season_number: 2, episode_number: 1 },
  aggregate_credits: credits,
  spoken_languages: [{ iso_639_1: 'sv', english_name: 'Swedish' }],
  production_countries: [{ iso_3166_1: 'SE', name: 'Sweden' }],
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
    // Due two days out: a streaming service may already have released it, so it plays like an aired one.
    ...(n === 2
      ? [
          {
            episode_number: 3,
            name: 'Out early',
            still_path: '/still.jpg',
            runtime: 50,
            air_date: daysFromToday(2),
            overview: 'Released before its broadcast slot.',
          },
        ]
      : []),
  ],
});
/** A local calendar date `days` from today, as TMDB writes it (`YYYY-MM-DD`). */
function daysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
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
  await page.route('**/atlas/index/studios/*/*.json', (r) =>
    r.fulfill({
      json: {
        studios: r.request().url().endsWith('/series/9.json')
          ? [{ id: 'Q174811', name: 'Studio Ghibli' }]
          : [],
      },
    }),
  );
  await page.route('**/atlas/index/similar/**', (r) => r.fulfill({ json: { ids: [], mixed: [] } }));
  await page.route('**/atlas/index/suggest.json', (r) => {
    const { seeds } = r.request().postDataJSON();
    return r.fulfill({
      json: {
        perSeed: seeds.map((seed) => ({ seed, ids: [], mixed: [] })),
        pooled: [],
        pooledMixed: [],
      },
    });
  });
  await page.route('**/atlas/index/franchise/*/*.json', (r) => r.fulfill({ json: {} }));
  await page.route('**/metadata/title/query', (r) => r.fulfill({ json: { entries: [] } }));
  await page.route('**/atlas/index/filter/all/titles.json?*', (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('sel') === 'country:SE,language:sv')
      return r.fulfill({
        json: {
          order: 'votes',
          titles: [
            {
              type: 'series',
              id: 10,
              title: 'Another Swedish Series',
              year: 2022,
              posterPath: '/swedish.jpg',
              originalLanguage: 'sv',
            },
          ],
        },
      });
    if (url.searchParams.get('sel') !== 'studio:Q174811') return r.fallback();
    return r.fulfill({
      json: {
        order: 'votes',
        titles:
          url.searchParams.get('skip') === '24'
            ? []
            : [
                {
                  type: 'movie',
                  id: 129,
                  title: 'Spirited Away',
                  year: 2001,
                  posterPath: '/spirited.jpg',
                  rating: 8.5,
                  votes: 19000,
                },
              ],
      },
    });
  });
  await page.route('**/atlas/index/filter/series/titles.json?*', (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('sel') !== 'language:sv') return r.fallback();
    return r.fulfill({
      json: {
        order: 'votes',
        titles: [
          {
            type: 'series',
            id: 10,
            title: 'Another Swedish Series',
            year: 2022,
            posterPath: '/swedish.jpg',
            originalLanguage: 'sv',
          },
        ],
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: art }),
  );
  await page.route('**/ratings/imdb/**', async (r) => {
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
  await routeTmdb(page, async (r) => {
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
          cast: [
            film(20, 'Latest acting', 2025),
            film(21, 'Earlier acting', 2010),
            {
              id: 22,
              media_type: 'tv',
              name: 'Guest Series',
              first_air_date: '2024-01-01',
              poster_path: '/poster.jpg',
            },
          ],
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
      // The fixture is a file on the dev server, so the title's path is taken before the app mounts: one
      // document, and the title is the first history entry, exactly as opening its link would give.
      await page.addInitScript(() => history.replaceState(null, '', '/tv/9'));
      await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
      const active = page.locator('[data-active="true"]');
      await expect(active.locator('h1')).toHaveText('The Series');
      const before = await active.locator('.hero').boundingBox();
      releaseRatings();
      await expect(active.getByText('IMDb', { exact: true })).toBeVisible();
      expect((await active.locator('.hero').boundingBox()).height).toBe(before.height);
      await expect(active.getByText('2020–2024', { exact: true })).toBeVisible();
      await expect(active.getByText('16', { exact: true })).toBeVisible();
      await expect(active.getByRole('link', { name: '2020–2024' })).toHaveAttribute(
        'href',
        '/search?c=decade-2020',
      );
      await expect(active.getByRole('link', { name: 'Series', exact: true })).toHaveAttribute(
        'href',
        '/search?type=tv',
      );
      await expect(active.getByRole('link', { name: 'Drama' })).toHaveAttribute(
        'href',
        '/search?type=tv&c=genre-18',
      );
      await expect(active.getByRole('link', { name: 'Swedish', exact: true })).toHaveAttribute(
        'href',
        '/search?c=lang-sv',
      );
      await expect(
        active.getByRole('link', { name: 'Sweden', exact: true }).first(),
      ).toHaveAttribute('href', '/search?c=country-SE');
      await expect(
        active.getByRole('link', { name: 'Studio Ghibli', exact: true }).first(),
      ).toHaveAttribute('href', '/search?c=studio-Q174811');
      for (const separator of [
        active.locator('.genres .separator').first(),
        active.locator('.production .separator').first(),
      ]) {
        await expect(separator).toHaveCount(1);
        expect(
          await separator.evaluate((node) => parseFloat(getComputedStyle(node).marginInlineStart)),
        ).toBeGreaterThan(0);
      }
      await expect(active.getByRole('link', { name: 'Browse Netflix' })).toHaveAttribute(
        'href',
        '/service/8-fi-netflix',
      );
      await expect(active.getByRole('link', { name: 'JustWatch' })).toHaveAttribute(
        'href',
        'https://www.themoviedb.org/tv/9/watch',
      );
      const watchedMenu = active.getByRole('button', { name: 'Mark watched', exact: true });
      await expect(watchedMenu).toBeVisible();
      await watchedMenu.click();
      await expect(active.getByRole('menuitemcheckbox', { name: 'Whole series' })).toBeFocused();
      await expect(active.getByRole('menuitemcheckbox', { name: 'Season 1' })).toBeVisible();
      await page.keyboard.press('Escape');

      const promotedSources = active
        .locator('header.hero')
        .getByRole('button', { name: 'Sources', exact: true });
      if (width < 760) await expect(promotedSources).toBeHidden();
      else await expect(promotedSources).toBeVisible();

      const playbackHref = '/tv/9-the-series?season=1&episode=1&play=1';
      await expect(active.locator('header.hero .split-main')).toHaveAttribute('href', playbackHref);
      await expect(active.locator('header.hero .continue')).toHaveAttribute('href', playbackHref);

      if (width === 1280) {
        const watchlist = active.getByRole('button', { name: 'Watchlist', exact: true });
        const [continueBox, heroBox, watchlistBox, watchedMenuBox] = await Promise.all([
          active.locator('header.hero .continue').boundingBox(),
          active.locator('header.hero').boundingBox(),
          watchlist.boundingBox(),
          watchedMenu.boundingBox(),
        ]);
        expect(continueBox).not.toBeNull();
        expect(heroBox).not.toBeNull();
        expect(watchlistBox).not.toBeNull();
        expect(watchedMenuBox).not.toBeNull();
        expect(continueBox.width).toBeLessThan(heroBox.width / 2);
        expect(watchlistBox.height).toBe(48);
        expect(watchlistBox.height).toBe(watchedMenuBox.height);
        // Continue Watching is its own semantic row above the title actions. Down enters the next section at its
        // primary Resume control rather than choosing a later reaction merely because it is closer horizontally.
        await active.locator('header.hero .continue').focus();
        await page.keyboard.press('ArrowDown');
        await expect(active.locator('header.hero .split-main')).toBeFocused();

        // Metadata stays natively focusable. Directional navigation treats those links as supporting context and
        // crosses directly to the primary action instead of making the title facts into an obstacle course.
        const imdb = active.getByRole('link', { name: /IMDb rating/ });
        const tmdb = active.getByRole('link', { name: /TMDB rating/ });
        await tmdb.focus();
        await expect(tmdb).toBeFocused();
        await page.keyboard.press('Tab');
        await imdb.focus();
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement?.closest('.hero-actions') !== null),
          )
          .toBe(true);
        expect(
          await page.evaluate(() => document.activeElement?.hasAttribute('data-spatial-skip')),
        ).toBe(false);
      }
      const row = active.locator('.episode').first();
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('.still img')).toBeVisible();
      const still = await row.locator('.still').boundingBox();
      expect(still.width).toBeGreaterThan(95);
      expect(Math.abs(still.width / still.height - 16 / 9)).toBeLessThan(0.02);
      await expect(row.getByText(/51 min/)).toBeVisible();
      await expect(row.locator('.progress')).toBeVisible();
      // The row is a link to the episode player, and a plain click uses the already-mounted player.
      const play = row.getByRole('link', { name: /Play episode 1/ });
      await expect(play).toHaveAttribute('href', '/tv/9-the-series?season=1&episode=1&play=1');
      const opened = page.url();
      await play.click();
      expect(page.url()).toBe(opened);
      expect(await page.evaluate(() => window.plays.at(-1))).toMatchObject({
        season: 1,
        episode: 1,
      });
      await row.getByRole('button', { name: 'Options for episode 1', exact: true }).click();
      await row.getByRole('menuitem', { name: 'Mark watched', exact: true }).click();
      await expect(row.locator('.watched')).toBeVisible();
      await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
      const upcoming = active.locator('.episode').filter({ hasText: 'Coming soon' });
      await expect(upcoming.locator('.air-date')).toContainText('2099');
      await expect(upcoming.locator('.episode-play')).toBeDisabled();
      await expect(upcoming.locator('.overview')).toHaveCount(0);
      const upcomingMenu = upcoming.getByRole('button', {
        name: 'Options for episode 2',
        exact: true,
      });
      await upcomingMenu.click();
      await expect(upcoming.getByRole('menuitem', { name: 'Mark watched' })).toBeVisible();
      await expect(upcoming.getByRole('menuitem', { name: 'Sources', exact: true })).toHaveCount(0);
      await upcomingMenu.click();
      // Within a week of its air date the episode still says when it airs, but Sources and Play work.
      const near = active.locator('.episode').filter({ hasText: 'Out early' });
      await expect(near.locator('.air-date')).toBeVisible();
      const nearMenu = near.getByRole('button', { name: 'Options for episode 3', exact: true });
      await nearMenu.click();
      await expect(near.getByRole('menuitem', { name: 'Sources', exact: true })).toBeVisible();
      await nearMenu.click();
      const nearPlay = near.getByRole('link', { name: /Play episode 3/ });
      await expect(nearPlay).not.toHaveAttribute('aria-disabled', 'true');
      await nearPlay.click();
      expect(await page.evaluate(() => window.plays.at(-1))).toMatchObject({
        season: 2,
        episode: 3,
      });
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const studioRow = active.getByRole('region', { name: 'More from Studio Ghibli' });
      await expect(
        studioRow.getByRole('heading').getByRole('link', { name: 'Studio Ghibli' }),
      ).toHaveAttribute('href', '/search?c=studio-Q174811');
      await expect(studioRow.getByRole('link', { name: /^Spirited Away/ })).toHaveAttribute(
        'href',
        '/movie/129-spirited-away',
      );
      // A Swedish title from Sweden gets its country's row, which says more than its language's would.
      await expect(active.getByRole('region', { name: 'More in Swedish' })).toHaveCount(0);
      const countryRow = active.getByRole('region', { name: 'More from Sweden' });
      await expect(
        countryRow.getByRole('heading').getByRole('link', { name: 'Sweden' }),
      ).toHaveAttribute('href', '/search?c=country-SE,lang-sv');
      await expect(
        countryRow.getByRole('link', { name: /^Another Swedish Series/ }),
      ).toHaveAttribute('href', '/tv/10-another-swedish-series');
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

test('season tabs own Left and Right but Up returns to the title actions', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await setup(page);
  await page.addInitScript(() => history.replaceState(null, '', '/tv/9?season=1'));
  await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
  const active = page.locator('[data-active="true"]');
  const season1 = active.getByRole('tab', { name: 'Season 1', exact: true });
  const season2 = active.getByRole('tab', { name: 'Season 2', exact: true });
  await expect(season1).toBeVisible();

  await season1.focus();
  await page.keyboard.press('ArrowRight');
  await expect(season2).toBeFocused();

  await season2.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.hero-actions'))))
    .toBe(true);
});

test('phone promotes Sources only when it replaces unavailable playback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.addInitScript(() => history.replaceState(null, '', '/tv/9?no-play'));
  await page.goto(`${E2E_ORIGIN}/test/detail-parity.html?no-play`);
  const active = page.locator('[data-active="true"]');
  await expect(active.locator('h1')).toHaveText('The Series');
  await expect(
    active.locator('header.hero').getByRole('button', { name: 'Sources', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('season requests cannot overwrite a newer selection and retained detail and person filters survive history', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    let releaseSeason;
    const seasonGate = new Promise((r) => (releaseSeason = r));
    const requests = await setup(page, { seasonGate });
    await page.addInitScript(() => history.replaceState(null, '', '/tv/9'));
    await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
    const active = () => page.locator('[data-active="true"]');
    await expect(active().getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await active().getByRole('tab', { name: 'Season 2', exact: true }).click();
    await active().getByRole('tab', { name: 'Season 1', exact: true }).click();
    releaseSeason();
    await expect(active().getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await active().getByRole('tab', { name: 'Season 2', exact: true }).click();
    await expect(active().getByText('Season 2 premiere', { exact: true })).toBeVisible();
    expect(requests.filter((p) => p.endsWith('/season/2'))).toHaveLength(1);
    await expect(
      active().getByRole('heading', { name: 'More like this', exact: true }).getByRole('link'),
    ).toHaveCount(0);
    const personHeading = active().getByRole('link', {
      name: 'A Person',
      exact: true,
    });
    await expect(personHeading).toHaveAttribute('href', '/person/7-a-person');
    await active().getByRole('link', { name: 'A Person Detective', exact: true }).click();
    await expect(active().getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await active().getByRole('button', { name: 'Series' }).click();
    await expect(active().getByRole('link', { name: 'Guest Series 2024' })).toBeVisible();
    await expect(active().getByRole('link', { name: 'Latest acting 2025' })).toHaveCount(0);
    await active().getByRole('button', { name: 'Movies' }).click();
    await expect(active().getByRole('heading', { name: 'Director', exact: true })).toBeVisible();
    const portrait = await active().locator('.portrait').boundingBox();
    expect(portrait.height / portrait.width).toBeCloseTo(1.5, 3);
    await active().getByRole('button', { name: 'More', exact: true }).click();
    await expect(active().getByRole('heading', { name: 'Producer', exact: true })).toBeVisible();
    const card = active().getByRole('link', { name: 'Production 8 2018' });
    await card.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    expect(scroll).toBeGreaterThan(300);
    await card.click();
    await expect(active().locator('h1')).toHaveText('A Film');
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await expect(active().locator('h1')).toHaveText('A Person');
    await expect(active().getByRole('button', { name: 'Movies' })).toHaveAttribute(
      'aria-pressed',
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
    await page.addInitScript(() => history.replaceState(null, '', '/tv/9'));
    await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
    const active = page.locator('[data-active="true"]');
    await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
    const row = active.locator('.episode').first();
    await expect(row).toContainText('Season 2 premiere');
    await row.getByRole('button', { name: 'Options for episode 1', exact: true }).click();
    await row.getByRole('menuitem', { name: 'Sources', exact: true }).click();
    await expect(active.getByText('Sources for S2 · E1')).toBeVisible();
    const source = active.locator('.source-panel li').first();
    const sourcePlay = source.getByRole('link', { name: 'Play', exact: true });
    await expect(sourcePlay).toHaveAttribute(
      'href',
      '/tv/9-the-series?season=2&episode=1&play=1&source=Episode.1080p.WEB.mkv',
    );
    await sourcePlay.click();
    expect(await page.evaluate(() => window.plays.at(-1))).toMatchObject({
      season: 2,
      episode: 1,
      filename: 'Episode.1080p.WEB.mkv',
    });
    // The direct menu action resolves afresh and chooses the release that needs fetching.
    await page.route('**/scout/config/stream/**', (r) =>
      r.fulfill({
        json: {
          streams: [
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
    await row.getByRole('button', { name: 'Options for episode 1', exact: true }).click();
    await row.getByRole('menuitem', { name: 'Download', exact: true }).click();
    await expect(active.getByText('Downloading 30%', { exact: true })).toBeVisible();
    await expect.poll(() => downloadRequests.length, { timeout: 8000 }).toBeGreaterThan(1);
    // The one add is a prefetch: nobody is waiting on a download, so it can't spend the adds kept for Play.
    expect(downloadRequests.filter((q) => q === '?prefetch=1')).toHaveLength(1);
    expect(downloadRequests.slice(1).every((q) => q === '?probe=1')).toBe(true);
  } finally {
    await browser.close();
  }
});

test('Check for sources again asks scout afresh, past the cached list, and says what it found', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    // Nothing listed yet: scout's ordinary answer for the episode is empty until a fresh rebuild finds it.
    const asked = [];
    await page.route('**/scout/config/stream/**', (r) => {
      const url = new URL(r.request().url());
      asked.push(url.search);
      const fresh = url.searchParams.get('fresh') === '1';
      return r.fulfill({
        headers: { 'cache-control': 'private, max-age=300' },
        json: {
          streams: fresh
            ? [
                {
                  title: 'Episode.1080p.WEB.mkv',
                  url: 'http://scout.internal/p/ready',
                  behaviorHints: { filename: 'Episode.1080p.WEB.mkv' },
                  attributes: { cached: true, resolution: '1080p' },
                },
              ]
            : [],
          den: { v: 1, answerKind: fresh ? 'live' : 'empty', coverage: { sources: [] } },
        },
      });
    });
    await page.addInitScript(() => history.replaceState(null, '', '/tv/9'));
    await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
    const active = page.locator('[data-active="true"]');
    await active.getByRole('tab', { name: 'Season 2', exact: true }).click();
    const row = active.locator('.episode').first();
    await expect(row).toContainText('Season 2 premiere');
    const menu = row.getByRole('button', { name: 'Options for episode 1', exact: true });
    await menu.click();
    await row.getByRole('menuitem', { name: 'Check for sources again', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Found' })).toHaveText(
      'Found 1 source.',
    );
    expect(asked).toContain('?fresh=1');
    // The browser's copy of the plain address is replaced too, so a later ordinary look sees the new list.
    await expect.poll(() => asked.filter((q) => q === '').length).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test('a direct episode player URL starts its exact episode and selected release', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await setup(page);
    await page.addInitScript(() =>
      history.replaceState(
        null,
        '',
        '/tv/9-the-series?season=2&episode=1&play=1&source=Episode.1080p.WEB.mkv',
      ),
    );
    await page.goto(`${E2E_ORIGIN}/test/detail-parity.html`);
    await expect
      .poll(() => page.evaluate(() => window.plays.at(-1)))
      .toMatchObject({
        id: 9,
        season: 2,
        episode: 1,
        filename: 'Episode.1080p.WEB.mkv',
      });
  } finally {
    await browser.close();
  }
});
