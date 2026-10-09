import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#456"/></svg>';

test('phone poster starts with the title and loaded actions hand directly to the overview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await guardNetwork(page);
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: svg }),
  );
  let showDetail;
  const detailReady = new Promise((resolve) => (showDetail = resolve));
  await routeTmdb(page, async (route) => {
    await detailReady;
    return route.fulfill({
      json: {
        id: 42,
        title: 'The Movie With a Longer Name',
        release_date: '2024-01-01',
        poster_path: '/poster.jpg',
        overview: 'A feature film with enough copy to make the mobile hierarchy visible.',
        genres: [{ id: 18, name: 'Drama' }],
        videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'yt1', official: true }] },
        credits: { cast: [], crew: [] },
        release_dates: { results: [] },
        recommendations: { results: [] },
      },
    });
  });

  await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions`);
  const heroActions = page.locator('.hero-actions');
  await expect(page.locator('.hero-content[aria-hidden="true"]')).toBeVisible();
  const loadingActionHeight = (await heroActions.boundingBox()).height;
  showDetail();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect((await heroActions.boundingBox()).height).toBeCloseTo(loadingActionHeight, 0);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const [poster, title, actions, overview] = await Promise.all(
      ['.hero .poster', '.hero h1', '.hero-actions .actions', '.mobile-overview .overview'].map(
        (selector) => page.locator(selector).boundingBox(),
      ),
    );
    expect(Math.abs(poster.y - title.y)).toBeLessThanOrEqual(1);
    const overviewGap = overview.y - actions.y - actions.height;
    expect(overviewGap).toBeGreaterThanOrEqual(8);
    expect(overviewGap).toBeLessThanOrEqual(20);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const [actions, sources] = await Promise.all([
    page.locator('.hero-actions').boundingBox(),
    page.getByRole('button', { name: /^Sources/ }).boundingBox(),
  ]);
  expect(actions.y).toBeLessThan(900);
  expect(actions.y + actions.height).toBeGreaterThan(900);
  expect(sources.y).toBeGreaterThan(actions.y + actions.height);
});

for (const width of [393, 700, 759, 760, 844, 1280])
  test(`a large season keeps its geometry while episode cards yield between batches at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await guardNetwork(page);
    await page.addInitScript(() => {
      const waiting = [];
      Object.defineProperty(globalThis, 'scheduler', {
        configurable: true,
        value: { yield: () => new Promise((resolve) => waiting.push(resolve)) },
      });
      window.fixtureYieldCount = () => waiting.length;
      window.fixtureYield = () => waiting.shift()?.();
    });
    const stills = [];
    await page.route('https://image.tmdb.org/**', (route) => {
      if (/still-\d+\.jpg$/.test(route.request().url())) stills.push(route.request().url());
      return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    });
    await page.route('**/atlas/**', (route) => route.fulfill({ status: 404, json: {} }));
    let releaseSeason;
    const season = new Promise((resolve) => (releaseSeason = resolve));
    await routeTmdb(page, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/season/1')) {
        await season;
        return route.fulfill({
          json: {
            episodes: Array.from({ length: 50 }, (_, index) => ({
              episode_number: index + 1,
              name:
                index % 4 === 0
                  ? `Episode ${index + 1} with a deliberately long title that wraps`
                  : `Episode ${index + 1}`,
              overview:
                index % 4 === 0
                  ? 'An unusually long episode synopsis that occupies several lines and proves the reserved card follows real content instead of assuming one fixed height across a season.'
                  : index % 4 === 1
                    ? ''
                    : 'A short synopsis.',
              air_date: index % 4 === 3 ? '2099-01-01' : '2025-01-01',
              runtime: index % 3 === 0 ? null : 55,
              still_path: `/still-${index + 1}.jpg`,
            })),
          },
        });
      }
      return route.fulfill({
        json: {
          id: 42,
          name: 'Large Series',
          first_air_date: '2020-01-01',
          imdb_id: 'tt0000042',
          backdrop_path: '/backdrop.jpg',
          overview: 'A series.',
          genres: [{ id: 18, name: 'Drama' }],
          seasons: [{ season_number: 1, name: 'Season 1', episode_count: 50 }],
          last_episode_to_air: { season_number: 1, episode_number: 50 },
          credits: { cast: [], crew: [] },
          aggregate_credits: { cast: [], crew: [] },
          videos: { results: [] },
          content_ratings: { results: [] },
          recommendations: { results: [] },
        },
      });
    });

    await page.goto(`${E2E_ORIGIN}/test/detail.html?series`);
    await expect(page.getByRole('heading', { level: 1, name: 'Large Series' })).toBeVisible();
    await expect(page.locator('img.backdrop')).toHaveAttribute('fetchpriority', 'high');
    releaseSeason();
    await expect(page.locator('.episode:not(.deferred)')).toHaveCount(4);
    await expect(page.locator('.episode.deferred')).toHaveCount(46);
    await expect(page.locator('.episodes > li')).toHaveCount(50);
    const firstStill = page.locator('.episode:not(.deferred) img').first();
    await expect(firstStill).toHaveAttribute('srcset', /w300.*300w,.*w500.*500w/);
    await expect(firstStill).toHaveAttribute(
      'sizes',
      '(max-width: 759px) clamp(96px, 29vw, 180px), clamp(190px, 24vw, 280px)',
    );
    await expect
      .poll(() => firstStill.evaluate((node) => new URL(node.currentSrc).pathname))
      .toBe('/t/p/w300/still-1.jpg');
    expect(stills.every((url) => new URL(url).pathname.includes('/t/p/w300/'))).toBe(true);
    const reservedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(stills.length).toBeLessThanOrEqual(4);

    // A retained hidden page neither fills its deep tree nor consumes another task slice.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('fixture:active', { detail: false })),
    );
    await expect(page.locator('img.backdrop')).toHaveAttribute('fetchpriority', 'auto');
    await expect.poll(() => page.evaluate(() => window.fixtureYieldCount())).toBeGreaterThan(0);
    await page.evaluate(() => window.fixtureYield());
    await page.waitForTimeout(0);
    await expect(page.locator('.episode:not(.deferred)')).toHaveCount(4);
    await expect(page.locator('.episode.deferred')).toHaveCount(46);

    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('fixture:active', { detail: true })),
    );
    let deferred = 46;
    let continuations = 0;
    while (deferred > 0 && continuations++ < 100) {
      await expect.poll(() => page.evaluate(() => window.fixtureYieldCount())).toBeGreaterThan(0);
      await page.evaluate(() => window.fixtureYield());
      await page.waitForTimeout(0);
      const next = await page.locator('.episode.deferred').count();
      // Cast/related staging shares the cooperative task queue; its continuation may be the one released here.
      expect(
        [0, Math.min(4, deferred)],
        `deferred episodes changed ${deferred} → ${next}`,
      ).toContain(deferred - next);
      if (next !== deferred) {
        const batchHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(Math.abs(batchHeight - reservedHeight)).toBeLessThanOrEqual(2);
      }
      deferred = next;
    }
    expect(deferred).toBe(0);
    await expect(page.getByRole('button', { name: 'Play episode 50: Episode 50' })).toBeVisible();
    const completeHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(Math.abs(completeHeight - reservedHeight)).toBeLessThanOrEqual(2);
  });

test('cast and related DOM promote in geometry-preserving cancellable batches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await guardNetwork(page);
  await page.addInitScript(() => {
    const waiting = [];
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: { yield: () => new Promise((resolve) => waiting.push(resolve)) },
    });
    window.fixtureYieldCount = () => waiting.length;
    window.fixtureYield = () => waiting.shift()?.();
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: svg }),
  );
  const film = (id) => ({
    id,
    media_type: 'movie',
    title: `Related ${id}`,
    release_date: '2020-01-01',
    poster_path: '/poster.jpg',
    vote_count: 1000,
  });
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/3/movie/42'))
      return route.fulfill({
        json: {
          id: 42,
          title: 'Staged Movie',
          release_date: '2020-01-01',
          imdb_id: 'tt0000042',
          backdrop_path: '/backdrop.jpg',
          overview: 'A movie whose below-fold sections are deliberately substantial.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: {
            cast: Array.from({ length: 12 }, (_, index) => ({
              id: index + 1,
              name: `Actor ${index + 1}`,
              profile_path: '/person.jpg',
              character: 'Someone',
            })),
            crew: [],
          },
          videos: { results: [] },
          release_dates: { results: [] },
          recommendations: {
            page: 1,
            total_pages: 1,
            results: Array.from({ length: 12 }, (_, index) => film(index + 100)),
          },
        },
      });
    if (path.includes('/person/'))
      return route.fulfill({ json: { cast: Array.from({ length: 12 }, (_, i) => film(i + 200)) } });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });

  await page.goto(`${E2E_ORIGIN}/test/detail.html?inactive`);
  await expect(page.getByRole('heading', { level: 1, name: 'Staged Movie' })).toBeVisible();
  await expect(page.locator('a.person')).toHaveCount(0);
  await expect(page.locator('[data-cast-placeholder]')).toHaveCount(1);
  await expect.poll(() => page.locator('[data-related-placeholder]').count()).toBeGreaterThan(0);
  expect(
    await page
      .locator('[data-related-placeholder]')
      .evaluateAll((nodes) => nodes.every((node) => node.getAttribute('aria-hidden') === 'true')),
  ).toBe(true);
  const reservedHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  // A scroll is an immediate promotion signal: the first small cast batch does not wait for idle.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: true })),
  );
  await page.waitForTimeout(0);
  await page.evaluate(() => scrollTo(0, 1));
  await expect(page.locator('a.person')).toHaveCount(4);

  // Leaving while a continuation is pending cancels it; returning resumes at the next batch.
  await expect.poll(() => page.evaluate(() => window.fixtureYieldCount())).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: false }));
    window.fixtureYield();
  });
  await page.waitForTimeout(0);
  await expect(page.locator('a.person')).toHaveCount(4);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: true })),
  );
  await expect(page.locator('a.person')).toHaveCount(8);
  await expect.poll(() => page.evaluate(() => window.fixtureYieldCount())).toBeGreaterThan(0);
  await page.evaluate(() => window.fixtureYield());
  await expect(page.locator('a.person')).toHaveCount(12);

  const relatedCount = await page.locator('[data-related-placeholder]').count();
  const releaseRelatedBatch = async (before) => {
    for (let stale = 0; stale < 10; stale += 1) {
      await expect.poll(() => page.evaluate(() => window.fixtureYieldCount())).toBeGreaterThan(0);
      await page.evaluate(() => window.fixtureYield());
      await page.waitForTimeout(0);
      const after = await page.locator('[data-related-placeholder]').count();
      // A canceled cast/old-row continuation can precede the live row continuation in the synthetic global queue.
      // It is intentionally a no-op; the live continuation still mounts at most one substantial subtree.
      expect(before - after).toBeLessThanOrEqual(1);
      if (after < before) return after;
    }
    throw new Error('a live related-row continuation never reached the scheduler');
  };
  let remaining = await releaseRelatedBatch(relatedCount);
  await expect(page.getByRole('region', { name: 'More like this' })).toBeAttached();

  let continuations = 0;
  while (remaining > 0 && continuations++ < 50) {
    remaining = await releaseRelatedBatch(remaining);
  }
  expect(remaining).toBe(0);
  const completeHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(Math.abs(completeHeight - reservedHeight)).toBeLessThanOrEqual(2);

  // Retaining and restoring the route does not discard already-mounted accessible links.
  const firstActor = page.locator('a.person').first();
  const actorNode = await firstActor.elementHandle();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: false }));
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: true }));
  });
  expect(await actorNode.evaluate((node) => node.isConnected)).toBe(true);
  await expect(firstActor).toBeVisible();
  await expect(firstActor).toHaveAccessibleName(/Actor 1/);
});
