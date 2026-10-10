import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const ORIGIN = E2E_ORIGIN;
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
async function linkingContexts(browser, { expired = false, write = false } = {}) {
  const slots = new Map();
  let sid = '';
  let opened = false;
  let reads = 0;
  const sent = [];
  // The library's log, so a write consent's rows land, and the order the consent reached den-edge in.
  const rows = new Map();
  let head = 0;
  const steps = [];
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
        : json(200, { client: 'Claude', redirectHost: 'claude.ai', verified: true, write });
    }
    if (url.pathname.startsWith(`/oauth/request/${ID}/`)) {
      const member = (await request.allHeaders())['x-den-library-member'] ?? null;
      sent.push({
        path: url.pathname,
        member: member !== null,
        ...(request.postData() ? { body: request.postDataJSON() } : {}),
      });
      steps.push('approve');
      if (!member) return json(403, { error: 'not_a_member' });
      return json(200, { redirect: `${CALLBACK}?code=abc&state=s` });
    }
    if (url.pathname === '/assistant/dropbox' && request.method() === 'PUT') {
      steps.push('dropbox');
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/assistant/drain') return json(200, { messages: [] });
    if (/^\/lib\/[0-9a-f]+\/batch$/.test(url.pathname) && request.method() === 'POST') {
      const applied = [];
      for (const w of body.writes) {
        const entry = { k: w.k, seq: ++head, v: w.v };
        rows.set(w.k, entry);
        applied.push({ k: w.k, seq: entry.seq });
      }
      steps.push(`batch:${applied.length}`);
      return json(200, { applied, conflicts: [] });
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
    // The linked browser opens the handed-over library through LibraryService before it can prove membership to
    // OAuth. Stand in for that existing (empty) den-edge library, including its bounded member registration.
    if (/^\/lib\/[0-9a-f]+\/member$/.test(url.pathname) && request.method() === 'PUT')
      return json(200, { registered: true });
    if (/^\/lib\/[0-9a-f]+\/changes$/.test(url.pathname)) {
      const since = Number(url.searchParams.get('since') ?? 0);
      const entries = [...rows.values()].filter((entry) => entry.seq > since);
      return json(200, { generation: 'fixture', entries, head, more: false });
    }
    if (url.pathname === '/routes' || url.pathname === '/config') return json(200, {});
    if (url.pathname === '/version') return json(200, { version: 'test' });
    if (/^\/(?:lib|tmdb|atlas|reel|scout|subs|grant)\//.test(url.pathname)) return json(404, {});
    return route.continue();
  };
  const host = await browser.newContext();
  const joiner = await browser.newContext();
  await host.route('**/*', relay);
  await joiner.route('**/*', relay);
  return { host, joiner, sent, steps };
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

// A member may also let the assistant change the library: unticked by default, and ticked it writes the library's
// drop-box key and the grant into the library, gives den-edge the public key, and only then approves with the grant.
test('a member allows changes to the library, and the grant is in the library before den-edge hears of it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { host, joiner, sent, steps } = await linkingContexts(browser, { write: true });
    const hostPage = await host.newPage();
    const page = await joiner.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await linkThroughDialog(hostPage, dialog);

    const allow = dialog.getByRole('checkbox', { name: /Allow changes to my library/ });
    await expect(allow).toBeVisible();
    await expect(allow).not.toBeChecked();
    await allow.check();
    steps.length = 0;
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${CALLBACK}?code=abc&state=s`);
    const approval = sent.find((s) => s.path === `/oauth/request/${ID}/approve`);
    expect(approval?.member).toBe(true);
    expect(approval?.body?.write?.grant).toMatch(/^[0-9a-f]{32}$/);
    expect(approval?.body?.write?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The drop-box key's row, then den-edge's copy of its public half, then the grant's row, then the approval.
    expect(steps.filter((s) => s !== 'batch:0')).toEqual([
      'batch:1',
      'dropbox',
      'batch:1',
      'approve',
    ]);
  } finally {
    await browser.close();
  }
});

test('a guest is never offered changes to the library', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context, sent } = await consentContext(browser, {
      grants: GUEST,
      asking: { client: 'Claude', redirectHost: 'claude.ai', verified: true, write: true },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await expect(dialog).toContainText('It calls itself “Claude”');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${CALLBACK}?code=abc&state=s`);
    expect(sent).toEqual([{ path: `/oauth/request/${ID}/approve`, grant: 'a1b2c3d4:sekrit' }]);
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

// The link screen is its own chunk, fetched when Link this browser is pressed. One that can't be had is said, with
// another try, rather than a "Loading…" that never ends.
test('a link screen that could not be loaded says so, with a Try again', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { context } = await consentContext(browser);
    const page = await context.newPage();
    await page.route(/\/src\/LinkTV\.svelte/, (r) => r.abort('internetdisconnected'));
    await page.goto(`${ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await dialog.getByRole('button', { name: 'Link this browser' }).click();
    await expect(dialog.getByText('Couldn’t load this page.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
