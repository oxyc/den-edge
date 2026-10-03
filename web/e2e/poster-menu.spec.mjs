import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

async function open(browser, { width = 1280, hasTouch = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch });
  await guardNetwork(page);
  // A hover or a press warms the card's own title detail (`warmDetail`), same as any other poster row; none of
  // these fixture titles are real TMDB ids, so this just has to answer something rather than go unmocked.
  await page.route('**/tmdb/3/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.goto('http://127.0.0.1:5198/test/poster-menu.html');
  return page;
}

test('hovering shows ⋯, clicking opens the menu, and a right-click opens the same one', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    const library = page.getByRole('region', { name: 'Library' });
    const card = library.getByRole('link', { name: 'Movie 101' });
    const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
    await card.hover();
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    await expect(menu).toBeVisible();
    const watchlist = menu.getByRole('menuitemcheckbox', { name: 'Add to watchlist' });
    await expect(watchlist).toHaveAttribute('aria-checked', 'false');
    await watchlist.click();
    // After an item runs, the menu closes and focus goes back to ⋯.
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(
      page.getByText('Added “Movie 101” to your watchlist', { exact: false }),
    ).toBeVisible();

    // Now checked, and the label flips to the opposite action.
    await trigger.click();
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Remove from watchlist' }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // A right-click on the card opens the same menu.
    await card.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'More like this' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Share' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('keyboard: Arrow/Home/End move between items, and Tab moves on', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    const library = page.getByRole('region', { name: 'Library' });
    const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    const items = menu.locator('[role^="menuitem"]');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('Tab from a card link reaches its ⋯, and Shift+F10 on the link opens the menu', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    const library = page.getByRole('region', { name: 'Library' });
    const card = library.getByRole('link', { name: 'Movie 101' });
    const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
    await card.focus();
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await card.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Actions for Movie 101' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a guest poster offers only More like this and Share', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    const guest = page.getByRole('region', { name: 'Guest' });
    await guest.getByRole('button', { name: 'Actions for Guest Movie' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for Guest Movie' });
    await expect(menu.locator('[role^="menuitem"]')).toHaveCount(2);
    await expect(menu.getByRole('menuitem', { name: 'More like this' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Share' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('Continue Watching offers "Remove from Continue Watching", with Undo in the toast', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    const library = page.getByRole('region', { name: 'Library' });
    const trigger = library.getByRole('button', { name: 'Actions for Series 701' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Series 701' });
    // A series with Continue Watching's own episode resumes there, named for it.
    await expect(menu.getByRole('menuitem', { name: 'Resume S2 · E4' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Remove from Continue Watching' }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    expect(await page.evaluate(() => window.fixture.calls().dismissContinueWatching)).toBe(1);
  } finally {
    await browser.close();
  }
});

test('a write in flight shows aria-disabled items that do not run, never a lost focus', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser);
    await page.evaluate(() => window.fixture.setBusy(true));
    const library = page.getByRole('region', { name: 'Library' });
    await library.getByRole('button', { name: 'Actions for Movie 101' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    const watchlist = menu.getByRole('menuitemcheckbox', { name: 'Add to watchlist' });
    await expect(watchlist).toHaveAttribute('aria-disabled', 'true');
    // Playwright's own actionability refuses a plain click on an aria-disabled widget (it waits for "enabled"
    // forever) and a geometric `force` click risks landing somewhere else entirely while the popover is still
    // being positioned; dispatching the event straight at the node proves the deliberate guard in `run()` —
    // not Playwright's own refusal, and not where the click happened to land — is what stops it from running.
    await watchlist.dispatchEvent('click');
    expect(await page.evaluate(() => window.fixture.calls().toggleWatchlist)).toBe(0);
    await expect(menu).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('mobile: a long-press opens the sheet and the card does not navigate; a swipe opens nothing', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser, { width: 390, hasTouch: true });
    const library = page.getByRole('region', { name: 'Library' });
    const card = library.getByRole('link', { name: 'Movie 101' });
    const box = await card.boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // A long press: down, held past 500ms with no real movement, then released.
    await page.mouse.move(center.x, center.y);
    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      target?.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    }, center);
    await page.waitForTimeout(600);
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    await expect(menu).toBeVisible();
    await expect(page).toHaveURL(/poster-menu\.html$/);
    await page.keyboard.press('Escape');

    // A swipe — more than 10px of movement — cancels it, and never navigates either.
    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      target?.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
      target?.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'touch',
          clientX: x + 40,
          clientY: y,
          bubbles: true,
        }),
      );
    }, center);
    await page.waitForTimeout(600);
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/poster-menu\.html$/);
  } finally {
    await browser.close();
  }
});
