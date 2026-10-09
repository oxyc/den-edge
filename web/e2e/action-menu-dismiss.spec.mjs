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

    // A click leaves Playwright's pointer on the trigger, which the menu deliberately treats as inside. Move
    // over the blank page below the rows so this is unambiguously a wheel gesture outside the menu. The fixture
    // has a 200vh spacer, but `mouse.wheel` does not wait for scrolling, so observe the movement too.
    await page.mouse.move(640, 850);
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
    await expect(menu).toBeHidden();
  } finally {
    await browser.close();
  }
});

// den-edge#260: closing on the bare `scroll` event closed the menu on any browser-caused scroll too — not
// only a swipe or a wheel behind it. The W3C menu's own keyboard model moves focus to an item a short popover
// has no room for (arrow keys cycling to one near an edge, or the menu simply opening low on a tall page),
// and the browser scrolls that focus into view by itself — the same `scroll` a real swipe fires, but never
// the user's own gesture. A keyboard or screen-reader user arrowing through their own open menu got it closed
// under them.
test('arrowing between items, and the browser scrolling a focus move into view, never closes the menu', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    const library = page.getByRole('region', { name: 'Library' });
    const trigger = library.getByRole('button', { name: 'Actions for Series 701' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Series 701' });
    await expect(menu).toBeVisible();

    // Series 701's ten items (continueWatching adds one to the usual eight, play/playHere among them) cycle
    // the W3C way: Home/End, and arrows wrapping at either end — real keyboard use, not a synthetic focus call.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await expect(menu).toBeVisible();

    // The event itself, however it was caused — `scrollIntoView` bringing a focused item on-screen, a
    // smooth-scroll settling after the page already moved, anything that isn't a wheel/touch/page-scroll key
    // landing outside the menu. `outsideScrollGesture` no longer answers to this one at all.
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect(menu).toBeVisible();

    // Still closeable by a real dismissal — this isn't a menu stuck open, only one no longer confused by a
    // scroll that was never anyone tapping or scrolling outside it.
    await page.keyboard.press('Escape');
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
    const triggerBox = await trigger.boundingBox();
    await page.evaluate(() => {
      window.__firstActionMenuFrame = null;
      document.addEventListener(
        'beforetoggle',
        (event) => {
          if (event.newState !== 'open' || event.target.getAttribute('role') !== 'menu') return;
          requestAnimationFrame(() => {
            const rect = event.target.getBoundingClientRect();
            window.__firstActionMenuFrame = {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            };
          });
        },
        { capture: true, once: true },
      );
    });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Movie 101' });
    await expect(menu).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__firstActionMenuFrame)).not.toBeNull();
    const firstFrame = await page.evaluate(() => window.__firstActionMenuFrame);
    expect(firstFrame.left).toBeGreaterThan(4);
    expect(firstFrame.top).toBeGreaterThan(4);
    expect(firstFrame.left).toBeLessThan(triggerBox.x + triggerBox.width);
    expect(firstFrame.right).toBeGreaterThan(triggerBox.x);
    expect(
      Math.min(
        Math.abs(firstFrame.top - (triggerBox.y + triggerBox.height)),
        Math.abs(firstFrame.bottom - triggerBox.y),
      ),
    ).toBeLessThan(80);
    await expect(trigger).toHaveCSS('opacity', '1');
    await trigger.click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu).toBeVisible();

    // Same reason as the mobile tap test: the scrim now covers it, so the click needs `force` past
    // Playwright's own "obscured" check to prove the real browser's hit-test lands on the scrim, not the card.
    await otherCard.click({ force: true });
    await expect(menu).toBeHidden();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page).toHaveURL(/poster-menu\.html$/);

    // The body/listeners released by the outside gesture leave a live trigger, not stale expanded state.
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await browser.close();
  }
});

test('a pointerdown with no click cannot swallow a later gesture, and native auto-popover releases the prior body', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    const library = page.getByRole('region', { name: 'Library' });
    const first = library.getByRole('button', { name: 'Actions for Movie 101' });
    const second = library.getByRole('button', { name: 'Actions for Series 701' });
    const otherCard = library.getByRole('link', { name: 'Series 701' });

    await first.click();
    await expect(page.getByRole('menu', { name: 'Actions for Movie 101' })).toBeVisible();
    // A drag/cancel can produce pointerdown without a click. The next complete gesture must start fresh.
    await otherCard.dispatchEvent('pointerdown', {
      pointerType: 'mouse',
      button: 0,
      bubbles: true,
    });
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await first.click();
    await expect(page.getByRole('menu', { name: 'Actions for Movie 101' })).toBeVisible();

    // Programmatic opening has no outside pointerdown. Native `popover="auto"` closes the first; its body and
    // expanded state must still be released while the second becomes the one live menu.
    await second.evaluate((button) => button.click());
    await expect(page.locator('[role="menu"]')).toHaveCount(1);
    await expect(page.getByRole('menu', { name: 'Actions for Series 701' })).toBeVisible();
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(second).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await browser.close();
  }
});
