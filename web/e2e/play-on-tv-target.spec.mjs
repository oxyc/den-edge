// "Play on TV" goes to the household's TVs (den-spec inbox-v1 §5), not through a pairing: every TV in the library's
// device list that publishes a play key is offered, the one a play last started on first, each sent to the queue its
// own key derives. A browser is never a TV, and a TV too old to publish a key is not offered.
import { hkdfSync } from 'node:crypto';
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const movie = {
  id: 1001,
  imdb_id: 'tt1001',
  title: 'Movie 1001',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A film, for the detail page to show.',
  genres: [{ name: 'Drama' }],
  release_date: '2026-01-01',
  vote_average: 7.5,
  vote_count: 500,
  credits: { cast: [] },
  recommendations: { results: [] },
};

/** The queue a play key derives, as a link key's (pairing-v1 §6). */
const queueOf = (playKey) =>
  Buffer.from(
    hkdfSync('sha256', Buffer.from(playKey, 'base64url'), 'den/link/v1', 'inbox', 24),
  ).toString('hex');

async function openTitle(page, query) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  const appends = [];
  await page.route('**/inbox/append', async (r) => {
    appends.push(r.request().headers()['x-den-link']);
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/inbox/pending', (r) => r.fulfill({ json: { queued: true } }));
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1001&${query}`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
  return { appends };
}

async function withPage(run) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    await run(await browser.newPage({ viewport: { width: 1280, height: 800 } }));
  } finally {
    await browser.close();
  }
}

// The fixture's film is part-watched, so its primary action reads "Resume on …".
const onTv = (page) => page.getByRole('button', { name: /^(Play|Resume) on / });

for (const host of ['browser', 'legacy-tv']) {
  test(`no TV that takes plays (${host}) offers no Play on TV and sends nothing`, () =>
    withPage(async (page) => {
      const { appends } = await openTitle(page, `link-host=${host}`);
      // The library's device list has been read by now: the same page with a TV draws the button.
      await page.waitForTimeout(500);
      await expect(onTv(page)).toHaveCount(0);
      expect(appends).toHaveLength(0);
    }));
}

test("one TV is Play on TV, sent to that TV's household queue", () =>
  withPage(async (page) => {
    const { appends } = await openTitle(page, 'link-host=tv');
    await page.getByRole('button', { name: 'Resume on TV', exact: true }).click();
    await expect(page.locator('p.library-status.toast')).toHaveText('Sent to Living Room TV…');
    expect(appends).toEqual([queueOf('A'.repeat(43))]);
  }));

test('several TVs are each named, the one played on last first', () =>
  withPage(async (page) => {
    const { appends } = await openTitle(page, 'link-host=tv&second-tv');
    await expect(page.getByRole('button', { name: 'Resume on TV', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume on Bedroom', exact: true }).click();
    await expect(page.locator('p.library-status.toast')).toHaveText('Sent to Bedroom…');

    await page.getByRole('button', { name: 'More ways to resume on bedroom' }).click();
    await page.getByRole('menuitem', { name: 'Resume on Living Room TV' }).click();
    await expect(page.locator('p.library-status.toast')).toHaveText('Sent to Living Room TV…');
    expect(appends).toEqual([queueOf(`${'B'.repeat(42)}A`), queueOf('A'.repeat(43))]);
  }));
