import { test, expect, chromium, webkit } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// The native popover's own light-dismiss closes on an outside pointerdown but never stops the click that
// follows it, which on a phone also activates whatever the tap landed on (den-edge's own `ActionMenu` now
// grows a transparent scrim to catch that tap, and a drag-down handler on the sheet itself for a swipe that
// starts there instead). These exercise both fixes, and that Escape and desktop light-dismiss still work.

async function openFixture(page) {
  await guardNetwork(page);
  await page.route('**/tmdb/3/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.goto(`${E2E_ORIGIN}/test/poster-menu.html`);
}

for (const [name, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  test(`mobile (${name}): tapping a poster outside the open sheet closes it and does not navigate`, async () => {
    let browser;
    try {
      browser = await engine.launch(
        name === 'chromium'
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      );
    } catch (error) {
      test.skip(true, `${name} is not installed here: ${String(error).split('\n')[0]}`);
      return;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
      await openFixture(page);
      const library = page.getByRole('region', { name: 'Library' });
      const card = library.getByRole('link', { name: 'Movie 101' });
      const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
      await trigger.tap();
      const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
      await expect(menu).toBeVisible();

      // The card sits at the top of the page; the open sheet is pinned to the bottom, so this tap lands
      // squarely outside it — exactly the "poster behind the sheet" the bug let through. `force` is needed
      // because the fix is precisely that the scrim now covers it — Playwright's own actionability check
      // would otherwise refuse the tap as "obscured" and time out.
      await card.tap({ force: true });
      await expect(menu).toBeHidden();
      await expect(page).toHaveURL(/poster-menu\.html$/);
    } finally {
      await browser.close();
    }
  });

  test(`mobile (${name}): a downward drag on the sheet closes it`, async () => {
    let browser;
    try {
      browser = await engine.launch(
        name === 'chromium'
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      );
    } catch (error) {
      test.skip(true, `${name} is not installed here: ${String(error).split('\n')[0]}`);
      return;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
      await openFixture(page);
      const library = page.getByRole('region', { name: 'Library' });
      const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
      await trigger.tap();
      const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
      await expect(menu).toBeVisible();

      const box = await menu.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + 10 };
      // A finger down on the sheet, dragged well past the close threshold — the bottom-sheet "drag down to
      // dismiss" gesture, never a light-dismiss case since it starts inside the popover itself.
      await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        target?.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerType: 'touch',
            pointerId: 7,
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        );
        target?.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerType: 'touch',
            pointerId: 7,
            clientX: x,
            clientY: y + 60,
            bubbles: true,
          }),
        );
      }, point);
      await expect(menu).toBeHidden();
    } finally {
      await browser.close();
    }
  });
}

test('a page scroll while the menu is open closes it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    const library = page.getByRole('region', { name: 'Library' });
    const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    await expect(menu).toBeVisible();

    // The fixture page is tall (a 200vh spacer below both rows) precisely so a wheel scroll moves it.
    await page.mouse.wheel(0, 400);
    await expect(menu).toBeHidden();
  } finally {
    await browser.close();
  }
});

test('desktop: clicking outside the menu closes it without activating the poster underneath, and Escape still closes it and returns focus', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    const library = page.getByRole('region', { name: 'Library' });
    const trigger = library.getByRole('button', { name: 'Actions for Movie 101' });
    const otherCard = library.getByRole('link', { name: 'Series 701' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    await expect(menu).toBeVisible();

    // Same reason as the mobile tap test: the scrim now covers it, so the click needs `force` past
    // Playwright's own "obscured" check to prove the real browser's hit-test lands on the scrim, not the card.
    await otherCard.click({ force: true });
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/poster-menu\.html$/);

    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await browser.close();
  }
});
