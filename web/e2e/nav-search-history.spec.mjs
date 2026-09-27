import { test, expect, chromium } from '@playwright/test';
import { active, input, FIXTURE, HOME, setup, openSearch } from './nav-search-fixture.mjs';

for (const width of [390, 1280])
  test(`recent title searches stay in this browser and can be reused or cleared at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 760,
      });
      await setup(page);
      await page.addInitScript(() =>
        localStorage.setItem('den.recentSearches', JSON.stringify(['Arrival', 'Studio Ghibli'])),
      );
      await page.goto(FIXTURE);
      // Do not wait for Router's route prop: an immediate choice must work as soon as focus draws the popup.
      if (width < 760)
        await page
          .getByRole('button', { name: 'Search', exact: true })
          .click({ noWaitAfter: true });
      else await input(page).click({ noWaitAfter: true });
      const recent = page.locator('.recent');
      // Choose as soon as the popup is actionable; `route.page` may still describe Home at this point.
      await recent.getByRole('button', { name: 'Studio Ghibli', exact: true }).click();
      await expect(page).toHaveURL(/q=Studio%20Ghibli/);
      await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();

      await input(page).fill('Neon');
      await expect(page).toHaveURL(/q=Neon/);
      await active(page).getByRole('link', { name: 'Film 100 2026' }).click();
      await expect(active(page).locator('h1')).toHaveText('Film 100');
      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=Neon/);
      await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
      await expect(input(page)).toHaveValue('Neon');
      await input(page).fill('');
      await expect(input(page)).toHaveValue('');
      await expect(recent).toBeVisible();
      await expect(recent.locator('.recent-query').first()).toHaveText('Neon');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.keyboard.press('ArrowDown');
      await expect(recent.getByRole('button', { name: 'Neon', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(
        recent.getByRole('button', { name: 'Studio Ghibli', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(recent.getByRole('button', { name: 'Neon', exact: true })).toBeFocused();
      await recent.getByRole('button', { name: 'Remove Arrival from recent searches' }).click();
      await expect(recent.getByRole('button', { name: 'Arrival', exact: true })).toHaveCount(0);
      await recent.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(recent).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('den.recentSearches'))).toBeNull();
    } finally {
      await browser.close();
    }
  });

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
      await page.goto(FIXTURE);
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
      const closedBar = width < 760 ? await page.locator('.bar').boundingBox() : null;
      await openSearch(page, width);
      if (width < 760) {
        const geometry = await page.evaluate(() => {
          const bar = document.querySelector('.bar');
          const form = document.querySelector('form.search');
          const field = form.querySelector('input');
          const rect = (element) => {
            const box = element.getBoundingClientRect();
            return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
          };
          return {
            position: getComputedStyle(bar).position,
            bar: rect(bar),
            form: rect(form),
            field: rect(field),
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.position, 'focused iOS input leaves the fixed formatting context').toBe(
          'absolute',
        );
        expect(Math.abs(geometry.bar.top - closedBar.y)).toBeLessThanOrEqual(1);
        expect(geometry.field.top).toBeGreaterThanOrEqual(geometry.form.top);
        expect(geometry.field.bottom).toBeLessThanOrEqual(geometry.form.bottom);
        expect(geometry.form.left).toBeGreaterThanOrEqual(geometry.bar.left);
        expect(geometry.form.right).toBeLessThanOrEqual(geometry.bar.right);
        expect(geometry.scrollWidth).toBe(width);
      }
      await input(page).fill('Neon');
      // Explore's grid shows the same fixture films, so wait for the search itself to answer.
      await expect(page).toHaveURL(/\/search\?q=Neon$/);
      await expect(
        active(page).getByRole('heading', { name: 'Search', exact: true }),
      ).toBeVisible();
      await expect(active(page).getByRole('link', { name: 'Film 108 2026' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (width < 760) {
        const editingBar = await page.locator('.bar').boundingBox();
        expect(Math.abs(editingBar.y - closedBar.y)).toBeLessThanOrEqual(1);
        await expect(input(page)).toBeInViewport();
      }
      await page.screenshot({ path: test.info().outputPath(`search-${width}.png`) });
      const card = active(page).getByRole('link', { name: 'Film 108 2026' });
      await card.scrollIntoViewIfNeeded();
      const searchY = await page.evaluate(() => scrollY);
      const count = queries.length;
      await card.click();
      await expect(active(page).locator('h1')).toHaveText('Film 108');
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.goBack();
      await expect(input(page)).toHaveValue('Neon');
      await expect(active(page).getByRole('link', { name: 'Film 108 2026' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(searchY);
      expect(queries.length).toBe(count);
      await page.goBack();
      await expect(page).toHaveURL(HOME);
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
        await expect(page).toHaveURL(HOME);
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(homeY);
        await expect(input(page)).toBeHidden();
        await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
      }
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await openSearch(page, width);
      await input(page).fill('empty');
      await expect(active(page).getByText('No matches.', { exact: true })).toBeVisible();
      await input(page).fill('');
      await expect(
        active(page).getByRole('heading', { name: 'Explore', exact: true }),
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
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    await input(page).fill('Slow');
    await expect.poll(() => queries.includes('Slow')).toBe(true);
    await input(page).fill('Neon');
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    const response = page.waitForResponse((r) => r.url().includes('query=Slow'));
    release();
    await response;
    await expect(active(page).getByRole('link', { name: 'Slow result 2026' })).toHaveCount(0);
    await expect(active(page).getByRole('link', { name: 'Film 100 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(HOME);
  } finally {
    await browser.close();
  }
});

// Each chip and Movies/Series switch is its own history entry, so a Cancel that stepped back once walked
// through every pick, one tap each, before it ever left Search.
test('Cancel leaves Search in one tap, however many picks were made in it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'reduce',
    });
    await setup(page);
    await page.goto(FIXTURE);
    await openSearch(page, 390);
    const chip = (name) => active(page).getByRole('button', { name, exact: true });
    await chip('Action').click();
    await expect(page).toHaveURL(/\/search\?c=genre-28$/);
    await chip('Series').click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-10759$/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(HOME);
    // And Forward still leads back into Search, so nothing was thrown away.
    await page.goForward();
    await expect(page).toHaveURL(/\/search/);
  } finally {
    await browser.close();
  }
});
