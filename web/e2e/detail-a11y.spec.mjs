import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const movie = {
  id: 42,
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A feature film.',
  genres: [{ name: 'Drama' }],
  videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'yt1', official: true }] },
  credits: { cast: [] },
};

async function mock(page) {
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  await page
    .context()
    .route(/^https:\/\/www\.youtube(-nocookie)?\.com\//, (r) =>
      r.fulfill({ contentType: 'text/html', body: '<title>YouTube fixture</title>' }),
    );
}

test('Trailer opens as a button, moves focus to Close, and Escape returns it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html`);
    const trailer = page.getByRole('button', { name: 'Trailer', exact: true });
    await expect(trailer).toBeVisible();
    await trailer.focus();
    await trailer.press('Enter');
    const close = page.getByRole('button', { name: 'Close' });
    await expect(close).toBeFocused();
    // The dialog's own escape from a refused embed: a new-tab link to the real thing.
    await expect(page.getByRole('link', { name: 'YouTube, in a new tab' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=yt1',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trailer).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('Watchlist keeps keyboard focus, and does not run again, while a save is in flight', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html`);
    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.focus();
    await page.evaluate(() => window.fixture.setBusy(true));
    await expect(watchlist).toHaveAttribute('aria-disabled', 'true');
    // A keyboard press on a NATIVE `disabled` button drops focus to <body> the instant it disables itself
    // (Chrome, Safari) — this is `aria-disabled` instead, so the press is simply refused and focus stays.
    await watchlist.press('Enter');
    await expect(watchlist).toBeFocused();
    expect(await page.evaluate(() => window.fixture.watchlistCalls())).toBe(0);
    await page.evaluate(() => window.fixture.setBusy(false));
    await watchlist.press('Enter');
    expect(await page.evaluate(() => window.fixture.watchlistCalls())).toBe(1);
  } finally {
    await browser.close();
  }
});

test('the opinion group is named, and its phone select has no stray text-selection callout', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html`);
    // The owner kept the select on phones: `DetailReactions`'s own `role="group"` exists (it is still what the
    // page uses ≥ 760px) but is hidden here, so it carries no accessible role at this width — the select is
    // the one actually offered, and it needs its own name since nothing wraps it in a group here.
    await expect(page.getByRole('group', { name: 'Your opinion' })).toHaveCount(0);
    const pick = page.locator('.hero .pick');
    await expect(pick.locator('select')).toHaveAccessibleName('Your opinion');
    // `-webkit-touch-callout` is iOS Safari's own property (unrecognised here, under Chromium); `user-select`
    // is the cross-engine half of the same fix, and this checks what this engine can actually tell us about it.
    expect(await pick.evaluate((node) => getComputedStyle(node).userSelect)).toBe('none');
  } finally {
    await browser.close();
  }
});

test('phone Detail keeps one primary playback surface and quiet personal actions', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await mock(page);
      await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions`);

      const actions = page.locator('.hero-actions .actions');
      const split = actions.locator('.split-button');
      const play = page.getByRole('button', { name: 'Play', exact: true });
      const disclosure = page.getByRole('button', { name: 'More ways to play' });
      const trailer = page.getByRole('button', { name: 'Trailer', exact: true });
      const utilities = [
        page.getByRole('button', { name: 'Watchlist', exact: true }),
        page.getByRole('button', { name: 'Seen', exact: true }),
        page.getByRole('button', { name: 'Share', exact: true }),
        page.getByRole('combobox', { name: 'Your opinion' }),
      ];

      const [actionBox, splitBox, playBox, disclosureBox, trailerBox, ...utilityBoxes] =
        await Promise.all([
          actions.boundingBox(),
          split.boundingBox(),
          play.boundingBox(),
          disclosure.boundingBox(),
          trailer.boundingBox(),
          ...utilities.map((control) => control.boundingBox()),
        ]);
      expect(actionBox).not.toBeNull();
      expect(playBox).not.toBeNull();
      expect(trailerBox).not.toBeNull();
      expect(Math.abs(splitBox.width - actionBox.width)).toBeLessThanOrEqual(1);
      expect(disclosureBox.width).toBeGreaterThanOrEqual(44);
      expect(disclosureBox.height).toBeGreaterThanOrEqual(44);
      expect(await trailer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(utilityBoxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
      expect(Math.max(...utilityBoxes.map((box) => box.y))).toBeLessThanOrEqual(
        Math.min(...utilityBoxes.map((box) => box.y)) + 1,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toHaveCount(0);
      await disclosure.click();
      const playOnTV = page.getByRole('menuitem', { name: 'Play on TV' });
      await expect(playOnTV).toBeFocused();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(playOnTV).toHaveCount(0);
      await expect(disclosure).toBeFocused();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

      for (const control of utilities.slice(0, 3)) {
        expect(await control.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe(
          'rgba(0, 0, 0, 0)',
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
