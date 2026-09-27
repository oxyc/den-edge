import { test, expect, chromium } from '@playwright/test';
import { active, input, FIXTURE, HOME, setup } from './nav-search-fixture.mjs';

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
    await page.goto(FIXTURE);
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
    const fetching = page.waitForRequest('**/atlas/recommend');
    releaseAtlas();
    await fetching;
    await expect(hero.locator('.slide').first()).toBeAttached();
    const response = page.waitForResponse('**/atlas/recommend');
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
    await page.goto(FIXTURE);
    await expect(active(page).locator('.billboard')).toBeVisible();
    await page.evaluate(() => {
      document.querySelector('.search-toggle').click();
      document.querySelector('.cancel').click();
    });
    await expect(page).toHaveURL(HOME);
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
      await page.goto(FIXTURE);
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
      await expect(page).toHaveURL(HOME);
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
      await expect(page).toHaveURL(HOME);
      await expect(hero.locator('.dot').nth(1)).toHaveAttribute('aria-current', 'true');
    } finally {
      await browser.close();
    }
  });
