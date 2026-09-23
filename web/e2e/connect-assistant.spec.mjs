import { test, expect, chromium } from '@playwright/test';

const ID = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://127.0.0.1:5198';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** A context that answers den-edge's consent routes and records what the page sent them. */
async function consentContext(browser, { grants = [] } = {}) {
  const sent = [];
  const context = await browser.newContext();
  if (grants.length)
    await context.addInitScript(
      (kept) => localStorage.setItem('den.grants', kept),
      JSON.stringify(grants),
    );
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'https://claude.ai')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Claude</title>',
      });
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    const json = (status, body) => route.fulfill({ status, json: body });
    if (url.pathname === `/oauth/request/${ID}`)
      return json(200, { client: 'Claude', redirectHost: 'claude.ai', scope: 'den:search' });
    if (url.pathname.startsWith(`/oauth/request/${ID}/`)) {
      const headers = await request.allHeaders();
      sent.push({ path: url.pathname, grant: headers['x-den-grant'] ?? null });
      const approve = url.pathname.endsWith('/approve');
      if (approve && !headers['x-den-grant'] && !headers['x-den-library-member'])
        return json(403, { error: 'not_a_member' });
      return json(200, {
        redirect: approve
          ? `${CALLBACK}?code=abc&state=s`
          : `${CALLBACK}?error=access_denied&state=s`,
      });
    }
    if (url.pathname === '/grant/addons')
      return json(200, { name: 'Oskar', addons: ['atlas'], expiresAt: null });
    if (url.pathname === '/routes' || url.pathname === '/config') return json(200, {});
    if (url.pathname === '/version') return json(200, { version: 'test' });
    if (/^\/(?:lib|tmdb|atlas|reel|scout|subs|grant)\//.test(url.pathname)) return json(404, {});
    return route.continue();
  });
  return { context, sent };
}

const GUEST = [
  {
    gid: 'a1b2c3d4',
    name: 'Oskar',
    secret: 'sekrit',
    addons: { atlas: '/atlas/~a1b2c3d4' },
    expiresAt: null,
    ended: false,
  },
];

// An assistant sends its person to /connect: they see who is asking and what it can do, and Allow sends them back
// to the assistant with the grant's proof on the approval.
test('a guest allows an assistant and is sent back to it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context, sent } = await consentContext(browser, { grants: GUEST });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect Claude to Den?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('claude.ai');
    await expect(dialog).toContainText('can’t see your library');
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${CALLBACK}?code=abc&state=s`);
    expect(sent).toEqual([{ path: `/oauth/request/${ID}/approve`, grant: 'a1b2c3d4:sekrit' }]);
  } finally {
    await browser.close();
  }
});

test('Deny sends the person back with a refusal', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context, sent } = await consentContext(browser, { grants: GUEST });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect Claude to Den?' });
    await dialog.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(`${CALLBACK}?error=access_denied&state=s`);
    expect(sent.map((s) => s.path)).toEqual([`/oauth/request/${ID}/deny`]);
  } finally {
    await browser.close();
  }
});

test('a browser with no library and no invite cannot allow one', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context, sent } = await consentContext(browser);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect Claude to Den?' });
    await expect(dialog).toContainText('Only someone with a Den library, or an invite to one');
    await expect(dialog.getByRole('button', { name: 'Allow' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    // The request leaves the address with the dialog.
    await expect(page).toHaveURL(`${ORIGIN}/`);
    expect(sent).toEqual([]);
  } finally {
    await browser.close();
  }
});
