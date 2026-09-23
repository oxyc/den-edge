import { test, expect, chromium } from '@playwright/test';

const ID = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://127.0.0.1:5198';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** A context that answers den-edge's consent routes and records what the page sent them. */
async function consentContext(
  browser,
  {
    grants = [],
    asking = { client: 'Claude', redirectHost: 'claude.ai', verified: true, scope: 'den:search' },
  } = {},
) {
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
    if (url.pathname === `/oauth/request/${ID}`) return json(200, asking);
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
    // Where the answer goes leads, known as an assistant's; the name the client gave itself comes second.
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('A known assistant’s address');
    await expect(dialog).toContainText('It calls itself “Claude”');
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
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await dialog.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(`${CALLBACK}?error=access_denied&state=s`);
    expect(sent.map((s) => s.path)).toEqual([`/oauth/request/${ID}/deny`]);
  } finally {
    await browser.close();
  }
});

// A client may call itself anything: one named "Claude" whose answer goes to evil.example is shown as evil.example,
// with no known mark and a warning, whatever its name.
test('a client named like a known assistant is shown by where its answer goes', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context } = await consentContext(browser, {
      grants: GUEST,
      asking: {
        client: 'Claude',
        redirectHost: 'evil.example',
        verified: false,
        scope: 'den:search',
      },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect evil.example to Den?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(
      'Connect evil.example to Den?',
    );
    await expect(dialog).toContainText('Den doesn’t know this address');
    await expect(dialog).not.toContainText('A known assistant’s address');
    await expect(dialog).toContainText('It calls itself “Claude”');
  } finally {
    await browser.close();
  }
});

test('a browser with no library and no invite is offered linking, not Allow', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context, sent } = await consentContext(browser);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    // Who is asking stays in view, with why this browser can't answer yet and the way forward.
    await expect(dialog).toContainText('A known assistant’s address');
    await expect(dialog).toContainText('It calls itself “Claude”');
    await expect(dialog.getByText('This browser isn’t linked to a Den library')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Link this browser' })).toBeVisible();
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

/**
 * Two browsers on one relay: one with a library that hosts a pairing from Settings, and one on the consent page
 * that joins it. `expired` makes den-edge forget the request once the page has first read it.
 */
async function linkingContexts(browser, { expired = false } = {}) {
  const slots = new Map();
  let sid = '';
  let opened = false;
  let reads = 0;
  const sent = [];
  const relay = async (route) => {
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
    const body = request.postData() ? request.postDataJSON() : {};
    if (url.pathname === `/oauth/request/${ID}`) {
      reads += 1;
      return expired && reads > 1
        ? json(404, { error: 'request_expired' })
        : json(200, { client: 'Claude', redirectHost: 'claude.ai', verified: true });
    }
    if (url.pathname.startsWith(`/oauth/request/${ID}/`)) {
      const member = (await request.allHeaders())['x-den-library-member'] ?? null;
      sent.push({ path: url.pathname, member: member !== null });
      if (!member) return json(403, { error: 'not_a_member' });
      return json(200, { redirect: `${CALLBACK}?code=abc&state=s` });
    }
    if (url.pathname === '/pair/new') {
      sid = body.sid;
      return json(200, { nameplate: 'ABCD' });
    }
    if (url.pathname === '/pair/open') {
      if (opened) return json(409, { error: 'already_opened' });
      opened = true;
      return json(200, { sid });
    }
    const slot = url.pathname.match(/^\/pair\/([0-9a-f]{32})\/([abcd])$/);
    if (slot) {
      const key = slot[2];
      if (request.method() === 'PUT') {
        if (slots.has(key)) return json(409, { error: 'already_written' });
        slots.set(key, body.m);
        return json(200, { written: true });
      }
      return slots.has(key) ? json(200, { m: slots.get(key) }) : json(202, { status: 'pending' });
    }
    if (url.pathname === `/pair/${sid}` && request.method() === 'DELETE')
      return json(200, { deleted: true });
    if (url.pathname === '/inbox/append') return json(200, { appended: true });
    if (url.pathname === '/inbox/drain') return json(200, { messages: [] });
    if (url.pathname === '/routes' || url.pathname === '/config') return json(200, {});
    if (url.pathname === '/version') return json(200, { version: 'test' });
    if (/^\/(?:lib|tmdb|atlas|reel|scout|subs|grant)\//.test(url.pathname)) return json(404, {});
    return route.continue();
  };
  const host = await browser.newContext();
  const joiner = await browser.newContext();
  await host.route('**/*', relay);
  await joiner.route('**/*', relay);
  return { host, joiner, sent };
}

/** Link the consent page's browser to the host's library through the dialog's link screen. */
async function linkThroughDialog(hostPage, dialog) {
  await hostPage.goto(`${ORIGIN}/test/settings.html`);
  await hostPage.getByRole('button', { name: /Linked devices/ }).click();
  const devices = hostPage.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Get a code' }).click();
  const code = await devices.locator('.code').textContent();

  await dialog.getByRole('button', { name: 'Link this browser' }).click();
  await expect(dialog).toContainText('Settings › Linked devices › Get a code');
  await dialog.getByLabel('Link code, twelve characters').fill(code);
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await devices.getByRole('button', { name: 'Allow', exact: true }).click();
}

// A library linked at another address of Den is not linked here (web storage is per address), so the consent page
// links this browser itself and then answers the same request.
test('a browser links to a library from the consent page and then allows the same request', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { host, joiner, sent } = await linkingContexts(browser);
    const hostPage = await host.newPage();
    const page = await joiner.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await expect(dialog.getByRole('button', { name: 'Allow' })).toHaveCount(0);
    await linkThroughDialog(hostPage, dialog);

    await expect(dialog.getByRole('button', { name: 'Allow' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(dialog).toContainText('It calls itself “Claude”');
    await expect(page).toHaveURL(`${ORIGIN}/connect?request=${ID}`);
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${CALLBACK}?code=abc&state=s`);
    expect(sent).toEqual([{ path: `/oauth/request/${ID}/approve`, member: true }]);
  } finally {
    await browser.close();
  }
});

test('a request that expired while linking says to start again from the assistant', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { host, joiner, sent } = await linkingContexts(browser, { expired: true });
    const hostPage = await host.newPage();
    const page = await joiner.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await linkThroughDialog(hostPage, dialog);

    await expect(dialog.getByRole('alert')).toContainText(
      'This request has expired. Start connecting again from the assistant',
    );
    await expect(dialog.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(sent).toEqual([]);
  } finally {
    await browser.close();
  }
});
