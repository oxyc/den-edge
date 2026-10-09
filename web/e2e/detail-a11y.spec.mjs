import { test, expect, chromium, webkit } from '@playwright/test';
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
    const close = page.getByRole('button', { name: 'Close trailer' });
    await expect(close).toBeFocused();
    // The dialog's own escape from a refused embed: a new-tab link to the real thing.
    await expect(
      page.getByRole('link', { name: 'Open trailer on YouTube in a new tab' }),
    ).toHaveAttribute('href', 'https://www.youtube.com/watch?v=yt1');
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

test('Sources is a keyboard disclosure', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html`);
    const disclosure = page.getByRole('button', { name: /^Sources/ });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.focus();
    await disclosure.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const panelId = await disclosure.getAttribute('aria-controls');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toBeVisible();
    await disclosure.press('Space');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
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
    // The owner kept the select on phones: the segmented desktop group is hidden here, so it carries no
    // accessible role at this width. The select is the one actually offered and needs its own name.
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

test('library mutations serialize without flashing, then Seen and opinion remain independent', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?hold-save`);
    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    const seen = page.getByRole('button', { name: 'Seen', exact: true });
    const like = page.getByRole('button', { name: 'Like', exact: true });
    const love = page.getByRole('button', { name: 'Love', exact: true });
    const stableOpacity = await Promise.all(
      [seen, like].map((control) => control.evaluate((node) => getComputedStyle(node).opacity)),
    );

    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-busy', 'true');
    await expect(seen).toHaveAttribute('aria-disabled', 'true');
    await expect(like).toHaveAttribute('aria-disabled', 'true');
    await watchlist.dispatchEvent('click');
    await seen.dispatchEvent('click');
    await like.dispatchEvent('click');
    expect(await page.evaluate(() => window.fixture.watchlistCalls())).toBe(1);
    expect(await page.evaluate(() => window.fixture.seenCalls())).toBe(0);
    expect(await page.evaluate(() => window.fixture.reactionCalls())).toBe(0);
    expect(
      await Promise.all(
        [seen, like].map((control) => control.evaluate((node) => getComputedStyle(node).opacity)),
      ),
    ).toEqual(stableOpacity);

    await page.evaluate(() => window.fixture.finishWatchlist());
    await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
    await expect(seen).not.toHaveAttribute('aria-disabled', 'true');
    await expect(like).not.toHaveAttribute('aria-disabled', 'true');
    await seen.click();
    await like.click();
    await expect(seen).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await love.click();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(love).toHaveAttribute('aria-pressed', 'true');
    await love.click();
    await expect(love).toHaveAttribute('aria-pressed', 'false');
    await expect(seen).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await browser.close();
  }
});

test('phone Detail keeps playback and personal actions usable at narrow widths', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await mock(page);
      await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions`);

      const actions = page.locator('.hero-actions .actions');
      const disclosure = page.getByRole('button', { name: 'More ways to play' });
      const controls = [
        page.getByRole('button', { name: 'Play', exact: true }),
        disclosure,
        page.getByRole('button', { name: 'Trailer', exact: true }),
        page.getByRole('button', { name: 'Watchlist', exact: true }),
        page.getByRole('button', { name: 'Seen', exact: true }),
        page.getByRole('button', { name: 'Share', exact: true }),
        page.getByRole('combobox', { name: 'Your opinion' }),
      ];

      await expect(actions).toBeVisible();
      const boxes = await Promise.all(
        controls.map(async (control) => {
          await expect(control).toBeVisible();
          return control.boundingBox();
        }),
      );
      expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toHaveCount(0);
      await disclosure.click();
      const playOnTV = page.getByRole('menuitem', { name: 'Play on TV' });
      await expect(playOnTV).toBeVisible();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(playOnTV).toHaveCount(0);
      await expect(disclosure).toBeFocused();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('a second touch closes the split Play menu in WebKit', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions`);
    const disclosure = page.getByRole('button', { name: 'More ways to play' });
    await disclosure.tap();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toBeVisible();
    await disclosure.tap();
    await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toHaveCount(0);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure).not.toBeFocused();

    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    const restingBackground = await watchlist.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    await watchlist.tap();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await expect(watchlist).not.toHaveAttribute('aria-busy', 'true');
    await watchlist.tap();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
    await expect(watchlist.locator('svg')).not.toHaveClass(/filled/);
    await expect
      .poll(() => watchlist.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe(restingBackground);
  } finally {
    await browser.close();
  }
});

test('desktop split destination preserves pointer-to-keyboard focus and menu behavior', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await mock(page);
    await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html?actions`);
    const play = page.getByRole('button', { name: 'Play', exact: true });
    const disclosure = page.getByRole('button', { name: 'More ways to play' });
    const surface = page.locator('.split-surface');

    await disclosure.click();
    await page.keyboard.press('Shift+Tab');
    await expect(play).toBeFocused();
    expect(await surface.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Escape');
    await expect(disclosure).toBeFocused();

    await disclosure.press('ArrowDown');
    const destination = page.getByRole('menuitem', { name: 'Play on TV' });
    await expect(destination).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(disclosure).toBeFocused();
    await disclosure.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toBeFocused();
    await page.evaluate(() => window.fixture.setBusy(true));
    await expect(page.getByRole('menuitem', { name: 'Play on TV' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  } finally {
    await browser.close();
  }
});

test('phone Detail without playback keeps the remaining action group intact', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await mock(page);
      await page.goto(`${E2E_ORIGIN}/test/detail-a11y.html`);

      const actions = page.locator('.hero-actions .actions');
      const trailer = page.getByRole('button', { name: 'Trailer', exact: true });
      const utilitiesGroup = actions.locator('.utilities');
      const utilities = [
        page.getByRole('button', { name: 'Watchlist', exact: true }),
        page.getByRole('button', { name: 'Seen', exact: true }),
        page.getByRole('button', { name: 'Share', exact: true }),
        page.getByRole('combobox', { name: 'Your opinion' }),
      ];
      await expect(trailer).toBeVisible();
      await expect(utilitiesGroup).toBeVisible();
      const [trailerBox, groupBox, ...boxes] = await Promise.all([
        trailer.boundingBox(),
        utilitiesGroup.boundingBox(),
        ...utilities.map(async (control) => {
          await expect(control).toBeVisible();
          return control.boundingBox();
        }),
      ]);

      expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
      expect(trailerBox.y).toBeLessThan(groupBox.y + groupBox.height);
      expect(groupBox.y).toBeLessThan(trailerBox.y + trailerBox.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
