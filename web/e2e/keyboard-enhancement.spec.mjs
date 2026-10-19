import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

const spatialModule = /\/(?:src\/lib\/spatialNavigation\.ts|assets\/spatialNavigation-[^/]+\.js)$/;

async function openGuest(page) {
  await routeGuestEdge(page, newEdge());
  await page.goto(E2E_ORIGIN);
}

async function browse(page) {
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

test('pointer-only browsing does not fetch directional geometry', async ({ page }) => {
  const geometryRequests = [];
  page.on('request', (request) => {
    if (spatialModule.test(new URL(request.url()).pathname)) geometryRequests.push(request.url());
  });
  await openGuest(page);
  await page.getByLabel('This device’s name').click();
  await page.getByLabel('This device’s name').fill('Keyboard fixture');
  await browse(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(geometryRequests).toEqual([]);
});

test('Tab and Enter remain native while arrows progressively add directional focus', async ({
  page,
  browserName,
}) => {
  const geometryRequests = [];
  page.on('request', (request) => {
    if (spatialModule.test(new URL(request.url()).pathname)) geometryRequests.push(request.url());
  });
  await openGuest(page);

  const browseButton = page.getByRole('button', { name: 'Look around instead' });
  if (browserName === 'webkit') {
    // macOS WebKit follows the system's default keyboard-access policy: Tab visits form fields but
    // skips links and buttons unless Full Keyboard Access is enabled.
    await page.getByLabel('Link code, twelve characters').click();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('This device’s name')).toBeFocused();
    await browseButton.focus();
  } else {
    for (
      let tabs = 0;
      tabs < 32 && !(await browseButton.evaluate((node) => node === document.activeElement));
      tabs++
    )
      await page.keyboard.press('Tab');
    await expect(browseButton).toBeFocused();
  }
  await page.keyboard.press('Enter');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();

  const home = nav.getByRole('link', { name: 'Home', exact: true });
  const movies = nav.getByRole('link', { name: 'Movies', exact: true });
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect(movies).toBeFocused();
  expect(geometryRequests.length).toBeGreaterThan(0);
});

test('editable controls keep arrow keys for their native caret', async ({ page }) => {
  await openGuest(page);
  await browse(page);
  const input = page.getByRole('searchbox');
  await input.click();
  await input.fill('den');
  await input.evaluate((node) => node.setSelectionRange(1, 1));
  await page.keyboard.press('ArrowRight');
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate((node) => node.selectionStart)).toBe(2);
  await expect(input).toHaveValue('den');
});

test('a missing optional geometry module leaves native keyboard behavior intact', async ({
  page,
  browserName,
}) => {
  let attempts = 0;
  await openGuest(page);
  await page.route('**/*spatialNavigation*', (route) => {
    attempts += 1;
    return route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'Optional module missing',
    });
  });
  const documents = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents.push(request.url());
  });
  await browse(page);
  const home = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Home', exact: true });
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => attempts).toBe(1);
  await page.keyboard.press('Tab');
  await expect(home).not.toBeFocused();
  if (browserName === 'webkit')
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Movies', exact: true })
      .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movies$/);
  expect(documents).toEqual([]);
});

for (const interrupt of ['Tab', 'pointer']) {
  test(`a delayed first arrow cannot steal focus after ${interrupt}`, async ({ page }) => {
    let releaseModule;
    const release = new Promise((resolve) => (releaseModule = resolve));
    let requested;
    const requestStarted = new Promise((resolve) => (requested = resolve));
    await openGuest(page);
    await page.route('**/*spatialNavigation*', async (route) => {
      requested();
      await release;
      await route.continue();
    });
    await browse(page);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const home = nav.getByRole('link', { name: 'Home', exact: true });
    const movies = nav.getByRole('link', { name: 'Movies', exact: true });
    await home.focus();
    await page.keyboard.press('ArrowRight');
    await requestStarted;

    let tabFocus;
    if (interrupt === 'Tab') {
      await page.keyboard.press('Tab');
      tabFocus = await page.evaluateHandle(() => document.activeElement);
    } else {
      await nav.getByRole('link', { name: 'Settings', exact: true }).click();
    }
    releaseModule();
    await page.waitForTimeout(200);
    if (interrupt === 'Tab') {
      expect(await tabFocus.evaluate((node) => node === document.activeElement)).toBe(true);
    } else {
      await expect(movies).not.toBeFocused();
      await expect(page).toHaveURL(/\/settings$/);
    }
  });
}
