// A press on a title's Watchlist, Seen or opinion shows at once and is saved after: the button is already in its new
// state while the write is held, pulses (after a short delay) while it runs, and goes back, with a toast, when the
// write fails. The first group holds and fails the writes of a fixture library; the second runs the production
// Worker against an in-memory den-edge, to see the wait for den-edge is no longer the page's.
import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE, openPairedTitle, routeLibraryEdge } from './library-edge.mjs';

const movie = {
  id: 1002,
  title: 'Movie 1002',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A movie, for the detail page to show.',
  genres: [{ name: 'Drama' }],
  vote_average: 7.5,
  vote_count: 500,
  credits: { cast: [] },
  recommendations: { results: [] },
};

async function withPage(run, { reducedMotion } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      ...(reducedMotion ? { reducedMotion } : {}),
    });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function openFixtureTitle(page, query = '') {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
    }),
  );
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1002${query}`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1002', level: 1 })).toBeVisible();
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const release = (page) => page.evaluate(() => window.denTestReleaseWrites());
const toast = (page) => page.locator('p.library-status.toast');
/** The button's pulse: its delay, and how far into it the button is (`undefined` when there is none). */
const pulse = (control) =>
  control.evaluate((el) => {
    const animation = el.getAnimations().find((a) => a.animationName === 'den-saving');
    return animation
      ? { delay: animation.effect.getComputedTiming().delay, at: Number(animation.currentTime) }
      : undefined;
  });

test('a press shows its new state while the write is still held, and keeps it when the write lands', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes');
    const love = button(page, 'Love');
    const like = button(page, 'Like');
    await expect(love).toHaveAttribute('aria-pressed', 'false');

    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    // Only the button pressed is busy; the others wait for it.
    await expect(love).toHaveAttribute('aria-busy', 'true');
    await expect(like).not.toHaveAttribute('aria-busy', 'true');
    await expect(like).toHaveAttribute('aria-disabled', 'true');

    await release(page);
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await expect(like).not.toHaveAttribute('aria-disabled', 'true');
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test('the watchlist toggles at once too, both ways', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes');
    const watchlist = button(page, 'Watchlist');
    // Movie 1002 is on the watchlist in this library.
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
    await release(page);
    await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
    await expect(watchlist).toHaveAttribute('aria-pressed', 'false');

    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  });
});

test('a slow write pulses its button, but only after a delay, and stops when it is saved', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes');
    const love = button(page, 'Love');
    await love.click();
    await expect(love).toHaveAttribute('aria-busy', 'true');

    // Pressed a moment ago: the pulse is there, waiting out its delay, and the button has not changed.
    expect((await pulse(love)).delay).toBe(150);
    expect(await love.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    // Then it shows.
    await expect.poll(async () => (await pulse(love)).at, { timeout: 3000 }).toBeGreaterThan(400);
    await expect
      .poll(() => love.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 3000 })
      .toBeLessThan(1);

    await release(page);
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    expect(await pulse(love)).toBeUndefined();
    expect(await love.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  });
});

test('a save that is over before the delay never shows the pulse', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page);
    const love = button(page, 'Love');
    await love.evaluate((el) => {
      window.__pulseShown = false;
      const watch = () => {
        // Past its delay: the point where the pulse would start to show.
        if (
          el
            .getAnimations()
            .some((a) => a.animationName === 'den-saving' && Number(a.currentTime) >= 150)
        )
          window.__pulseShown = true;
        requestAnimationFrame(watch);
      };
      watch();
    });
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__pulseShown)).toBe(false);
  });
});

test('with reduced motion the wait is a dimmer button, not an animation', async () => {
  await withPage(
    async (page) => {
      await openFixtureTitle(page, '&hold-writes');
      const love = button(page, 'Love');
      await love.click();
      expect(await love.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe('1');
      expect(await love.evaluate((el) => getComputedStyle(el).animationFillMode)).toBe('forwards');
      await expect
        .poll(() => love.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 3000 })
        .toBeLessThan(1);
      await release(page);
    },
    { reducedMotion: 'reduce' },
  );
});

test('a write that fails puts the button back and says so on the toast', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes&failing');
    const love = button(page, 'Love');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');

    await release(page);
    await expect(love).toHaveAttribute('aria-pressed', 'false');
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await expect(toast(page)).toHaveText(
      'Couldn’t save that. Check that this device is on your network.',
    );
    // The library never took it, so the row agrees with the button.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Movie 1002', level: 1 })).toBeVisible();
    await expect(button(page, 'Love')).toHaveAttribute('aria-pressed', 'false');
  });
});

test('a second press while the first is being saved is refused, and neither moves the other back', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes');
    const love = button(page, 'Love');
    const like = button(page, 'Like');
    await love.click();
    await like.dispatchEvent('click');
    await love.dispatchEvent('click');
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveAttribute('aria-pressed', 'false');

    // The row refreshing under the held press, as a pull from another device does, leaves it shown.
    await page.evaluate(() => window.denTestLivePosition({ type: 'movie', id: 1002 }, 120));
    await expect(love).toHaveAttribute('aria-pressed', 'true');

    await release(page);
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveAttribute('aria-pressed', 'false');

    // Pressing the one that is on turns it off, on the state the person is looking at.
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'false');
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await expect(love).toHaveAttribute('aria-pressed', 'false');
  });
});

test('Seen replaces the watchlist at once, as the saved title will', async () => {
  await withPage(async (page) => {
    await openFixtureTitle(page, '&hold-writes');
    const watchlist = button(page, 'Watchlist');
    const seen = button(page, 'Seen');
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await seen.click();
    await expect(seen).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
    await release(page);
    await expect(seen).not.toHaveAttribute('aria-busy', 'true');
    await expect(seen).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('the production Worker', () => {
  test('the page is not kept waiting on den-edge: the press is saved on this device and sent after', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let release;
    const edge = {};
    await routeLibraryEdge(page, edge);
    await openPairedTitle(page, 1500);

    edge.hold = new Promise((resolve) => (release = resolve));
    const love = button(page, 'Love');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    // The batch is on its way and den-edge has not answered, yet the page's own wait is over.
    await expect.poll(() => edge.batches).toBe(1);
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);

    release();
    await page.waitForTimeout(300);
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // It reached den-edge: a fresh visit reads it from there.
    await page.goto(`${FIXTURE}?online&title=movie:1500`);
    await expect(button(page, 'Love')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a write that cannot reach den-edge stays shown, and the page says it is waiting to sync', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const edge = {};
    await routeLibraryEdge(page, edge);
    await openPairedTitle(page, 1500);

    edge.drop = true;
    const love = button(page, 'Love');
    await love.click();
    await expect(page.getByRole('alert')).toHaveText(
      'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.',
    );
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
  });

  test('a write den-edge refuses for good is taken back, and the page says it was not kept', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const edge = {};
    await routeLibraryEdge(page, edge);
    await openPairedTitle(page, 1500);

    let answer;
    edge.hold = new Promise((resolve) => (answer = resolve));
    edge.refuse = true;
    const love = button(page, 'Love');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(love).not.toHaveAttribute('aria-busy', 'true');
    // Still shown, and kept on this device, until den-edge answers.
    await page.waitForTimeout(200);
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);

    answer();
    await expect(page.getByRole('alert')).toHaveText(
      'Couldn’t save your last change. It was not kept.',
    );
    await expect(love).toHaveAttribute('aria-pressed', 'false');
  });
});
