import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

const film = (id, title = `Film ${id}`) => ({
  id,
  title,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
});
const films = Array.from({ length: 30 }, (_, i) => film(100 + i));
const active = (page) => page.locator('[data-route-page][data-active="true"]');
const input = (page) => page.getByRole('searchbox', { name: 'Search movies, series and people' });
async function setup(page, { atlasGate, catalogueGate, searchGate } = {}) {
  await guardNetwork(page);
  const queries = [];
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', async (r) => {
    if (!atlasGate) return r.fulfill({ status: 404 });
    await atlasGate;
    return r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } });
  });
  await page.route('**/atlas/catalog/**', async (r) => {
    await catalogueGate;
    return r.fulfill({ json: { metas: [] } });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>',
    }),
  );
  await page.route('https://api.themoviedb.org/**', async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.includes('/search/')) {
      const q = url.searchParams.get('query');
      queries.push(q);
      await searchGate?.(q);
      return r.fulfill({
        json: {
          results: q.startsWith('empty')
            ? []
            : q.startsWith('Slow')
              ? [film(999, 'Slow result')]
              : films,
          total_pages: 1,
        },
      });
    }
    const match = /\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (match)
      return r.fulfill({
        json: {
          ...film(Number(match[2])),
          overview: 'A movie description.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: { cast: [] },
          recommendations: { results: [] },
        },
      });
    return r.fulfill({ json: { results: films, total_pages: 1 } });
  });
  return queries;
}
async function openSearch(page, width) {
  if (width < 760) await page.getByRole('button', { name: 'Search', exact: true }).click();
  else await input(page).click();
  await expect(page).toHaveURL(/#search$/);
  await expect(input(page)).toBeFocused();
}

for (const width of [320, 390, 1280])
  test(`navbar search preserves Home and result history at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 760,
        reducedMotion: 'reduce',
      });
      let documents = 0;
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents++;
      });
      const queries = await setup(page);
      await page.goto('http://127.0.0.1:5198/test/nav-search.html#library');
      await expect(active(page).locator('.billboard .slide').first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (width < 760) {
        const bar = await page.locator('.bar').boundingBox();
        const search = await page
          .getByRole('button', { name: 'Search', exact: true })
          .boundingBox();
        expect(search.x + search.width).toBeLessThanOrEqual(bar.x + bar.width - 4);
      }
      await page.screenshot({ path: test.info().outputPath(`navbar-${width}.png`) });
      await active(page).locator('.billboard .dot').nth(1).click();
      await page.evaluate(() => {
        window.homeHero = document.querySelector('.billboard');
        scrollTo(0, 700);
      });
      const homeY = await page.evaluate(() => scrollY);
      expect(homeY).toBeGreaterThan(300);
      await openSearch(page, width);
      await input(page).fill('Neon');
      await expect(active(page).getByRole('button', { name: 'Film 108 2026' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: test.info().outputPath(`search-${width}.png`) });
      const card = active(page).getByRole('button', { name: 'Film 108 2026' });
      await card.scrollIntoViewIfNeeded();
      const searchY = await page.evaluate(() => scrollY);
      const count = queries.length;
      await card.click();
      await expect(active(page).locator('h1')).toHaveText('Film 108');
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.goBack();
      await expect(input(page)).toHaveValue('Neon');
      await expect(active(page).getByRole('button', { name: 'Film 108 2026' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(searchY);
      expect(queries.length).toBe(count);
      await page.goBack();
      await expect(page).toHaveURL(/#library$/);
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(homeY);
      expect(
        await page.evaluate(
          () => document.querySelector('[data-active="true"] .billboard') === window.homeHero,
        ),
      ).toBe(true);
      await expect(active(page).locator('.billboard .dot').nth(1)).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      if (width < 760) {
        await expect(input(page)).toBeHidden();
        await openSearch(page, width);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page).toHaveURL(/#library$/);
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(homeY);
        await expect(input(page)).toBeHidden();
        await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
      }
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(/#settings$/);
      await openSearch(page, width);
      await input(page).fill('empty');
      await expect(active(page).getByText('No matches.', { exact: true })).toBeVisible();
      await input(page).fill('');
      await expect(
        active(page).getByText('Search movies, series and people.', { exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
      expect(documents).toBe(1);
    } finally {
      await browser.close();
    }
  });

test('a late search cannot replace a newer query', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    let release;
    const slow = new Promise((r) => (release = r));
    const queries = await setup(page, {
      searchGate: (q) => (q.startsWith('Slow') ? slow : Promise.resolve()),
    });
    await page.goto('http://127.0.0.1:5198/test/nav-search.html#search');
    await input(page).fill('Slow');
    await expect.poll(() => queries.includes('Slow')).toBe(true);
    await input(page).fill('Neon');
    await expect(active(page).getByRole('button', { name: 'Film 100 2026' })).toBeVisible();
    const response = page.waitForResponse((r) => r.url().includes('query=Slow'));
    release();
    await response;
    await expect(active(page).getByRole('button', { name: 'Slow result 2026' })).toHaveCount(0);
    await expect(active(page).getByRole('button', { name: 'Film 100 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(/#library$/);
  } finally {
    await browser.close();
  }
});

test('late discovery keeps the already visible billboard and selected slide', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    let releaseAtlas, releaseCatalogue;
    const atlasGate = new Promise((r) => (releaseAtlas = r)),
      catalogueGate = new Promise((r) => (releaseCatalogue = r));
    await setup(page, { atlasGate, catalogueGate });
    await page.goto('http://127.0.0.1:5198/test/nav-search.html#library');
    const hero = active(page).locator('.billboard');
    await expect(hero.locator('.slide').first()).toBeVisible();
    await hero.locator('.dot').nth(1).click();
    await expect(hero.locator('.backdrop.lit')).toHaveCount(1);
    await page.evaluate(() => {
      window.heroBlanked = false;
      new MutationObserver(() => {
        if (
          !document.querySelector('.billboard .slide') ||
          !document.querySelector('.billboard .backdrop.lit')
        )
          window.heroBlanked = true;
      }).observe(document.querySelector('.billboard'), {
        subtree: true,
        childList: true,
        attributes: true,
      });
    });
    const fetching = page.waitForRequest('**/atlas/catalog/movie/jw-trending.json');
    releaseAtlas();
    await fetching;
    await expect(hero.locator('.slide').first()).toBeAttached();
    const response = page.waitForResponse('**/atlas/catalog/movie/jw-trending.json');
    releaseCatalogue();
    await response;
    await page.waitForTimeout(150);
    await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
    expect(await page.evaluate(() => window.heroBlanked)).toBe(false);
  } finally {
    await browser.close();
  }
});

test('immediate search cancellation returns Home during its opening animation', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 800 }, hasTouch: true });
    await setup(page);
    await page.goto('http://127.0.0.1:5198/test/nav-search.html#library');
    await expect(active(page).locator('.billboard')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.search-toggle').click();
      document.querySelector('.cancel').click();
    });
    await expect(page).toHaveURL(/#library$/);
    await expect(active(page).locator('.billboard')).toBeVisible();
    await expect(input(page)).toBeHidden();
  } finally {
    await browser.close();
  }
});

for (const width of [320, 393, 1280])
  test(`billboard opens by mobile slide tap and keeps desktop actions at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 760,
        reducedMotion: 'reduce',
      });
      await setup(page);
      await page.goto('http://127.0.0.1:5198/test/nav-search.html#library');
      const hero = active(page).locator('.billboard');
      await expect(hero.locator('.slide').first()).toBeVisible();
      if (width >= 760) {
        await expect(
          hero.locator('.slide').first().getByRole('link', { name: 'More', exact: true }),
        ).toBeVisible();
        await expect(hero.locator('.slide-link').first()).toBeHidden();
        return;
      }
      await expect(hero.getByRole('link', { name: 'More', exact: true })).toHaveCount(0);
      await expect(hero.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
      await expect(hero.locator('.actions').first()).toBeHidden();
      const cdp = await page.context().newCDPSession(page);
      const start = width - 50;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: start, y: 220 }],
      });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start - (i * (start - 50)) / 6, y: 220 }],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(hero.locator('.dot').first()).not.toHaveAttribute('aria-current', 'true');
      await expect(page).toHaveURL(/#library$/);
      // Dots remain independent of the full-slide link and select a predictable destination.
      await hero.locator('.dot').nth(1).click();
      await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
      const slide = hero.locator('.slide-link[tabindex="0"]');
      const href = await slide.getAttribute('href');
      await page.screenshot({ path: test.info().outputPath(`mobile-slide-${width}.png`) });
      await slide.tap({ position: { x: width / 2, y: 180 } });
      await expect(page).toHaveURL(new RegExp(href + '$'));
      await expect(active(page).locator('h1')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/#library$/);
      await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
    } finally {
      await browser.close();
    }
  });
