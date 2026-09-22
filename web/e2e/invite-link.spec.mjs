import { test, expect, chromium } from '@playwright/test';

const CODE = 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA';

// A first-time guest opening an invite link is asked, on the page it opened, whether to accept — not sent to
// Settings, where the first thing on screen was the invitation to link an Apple TV.
test('an invite link asks to accept where it lands, and a guest who accepts holds the grant', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const redeemed = [];
  try {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:5198') return route.abort('blockedbyclient');
      const json = (status, body) => route.fulfill({ status, json: body });
      if (url.pathname === '/grant/redeem') {
        redeemed.push(request.postDataJSON().code);
        return json(200, { gid: 'a1b2c3d4', name: 'Oskar', addons: ['scout'], expiresAt: null });
      }
      if (url.pathname === '/grant/addons')
        return json(200, { name: 'Oskar', addons: ['scout'], expiresAt: null });
      if (url.pathname === '/routes' || url.pathname === '/config') return json(200, {});
      if (url.pathname === '/version') return json(200, { version: 'test' });
      if (/^\/(?:lib|tmdb|atlas|reel|scout|subs)\//.test(url.pathname)) return json(404, {});
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5198/#invite=${CODE}`);

    const dialog = page.getByRole('dialog', { name: 'Accept this invite?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Link code, twelve characters')).toHaveCount(0);
    expect(new URL(page.url()).hash, 'the code leaves the address').toBe('');
    expect(new URL(page.url()).pathname).toBe('/');

    await dialog.getByRole('button', { name: 'Accept' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      'You can now use Oskar’s addons in this browser.',
    );
    expect(redeemed).toEqual([CODE]);
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.grants') ?? '[]')[0]?.gid),
      )
      .toBe('a1b2c3d4');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await browser.close();
  }
});

test('Not now leaves the invite unredeemed', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  let redeems = 0;
  try {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:5198') return route.abort('blockedbyclient');
      if (url.pathname === '/grant/redeem') redeems++;
      if (url.pathname === '/routes' || url.pathname === '/config')
        return route.fulfill({ status: 200, json: {} });
      if (/^\/(?:lib|tmdb|atlas|reel|scout|subs|grant)\//.test(url.pathname))
        return route.fulfill({ status: 404, json: {} });
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5198/#invite=${CODE}`);
    const dialog = page.getByRole('dialog', { name: 'Accept this invite?' });
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
    expect(redeems).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('den.grants'))).toBeNull();
  } finally {
    await browser.close();
  }
});
