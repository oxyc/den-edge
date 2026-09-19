import { test, expect, chromium } from '@playwright/test';

test('two browsers pair and join their stable identities through encrypted link records', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const slots = new Map();
  const inboxes = new Map();
  let sid = '';
  let opened = false;
  const json = (route, status, body) => route.fulfill({ status, json: body });
  const relay = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:5198') return route.abort('blockedbyclient');
    const body = request.postData() ? request.postDataJSON() : {};
    if (url.pathname === '/pair/new') {
      sid = body.sid;
      return json(route, 200, { nameplate: 'ABCD' });
    }
    if (url.pathname === '/pair/open') {
      if (opened) return json(route, 409, { error: 'already_opened' });
      opened = true;
      return json(route, 200, { sid });
    }
    const slot = url.pathname.match(/^\/pair\/([0-9a-f]{32})\/([abcd])$/);
    if (slot) {
      const key = slot[2];
      if (request.method() === 'PUT') {
        if (slots.has(key)) return json(route, 409, { error: 'already_written' });
        slots.set(key, body.m);
        return json(route, 200, { written: true });
      }
      return slots.has(key)
        ? json(route, 200, { m: slots.get(key) })
        : json(route, 202, { status: 'pending' });
    }
    if (url.pathname === `/pair/${sid}` && request.method() === 'DELETE')
      return json(route, 200, { deleted: true });
    if (url.pathname === '/inbox/append') {
      const key = request.headers()['x-den-link'];
      inboxes.set(key, [...(inboxes.get(key) ?? []), { sealed: body.sealed }]);
      return json(route, 200, { appended: true });
    }
    if (url.pathname === '/inbox/drain') {
      const key = request.headers()['x-den-link'];
      const messages = inboxes.get(key) ?? [];
      inboxes.delete(key);
      return json(route, 200, { messages });
    }
    if (url.pathname === '/routes') return json(route, 200, {});
    if (url.pathname === '/version') return json(route, 200, { version: 'test' });
    if (url.pathname === '/config') return json(route, 200, {});
    if (/^\/(?:lib|tmdb|atlas|reel)\//.test(url.pathname)) return json(route, 404, {});
    return route.continue();
  };

  const host = await browser.newContext();
  const joiner = await browser.newContext();
  try {
    await host.addInitScript(() => {
      if (!localStorage.getItem('den.deviceID'))
        localStorage.setItem('den.deviceID', 'aaaa000000000001');
      if (!localStorage.getItem('den.deviceName'))
        localStorage.setItem('den.deviceName', 'Host Browser');
    });
    await joiner.addInitScript(() => {
      if (!localStorage.getItem('den.deviceID'))
        localStorage.setItem('den.deviceID', 'bbbb000000000002');
      if (!localStorage.getItem('den.deviceName'))
        localStorage.setItem('den.deviceName', 'Joining Browser');
    });
    await host.route('**/*', relay);
    await joiner.route('**/*', relay);
    const hostPage = await host.newPage();
    const joinerPage = await joiner.newPage();
    await hostPage.goto('http://127.0.0.1:5198/test/settings.html');
    await hostPage.getByRole('button', { name: /Linked devices/ }).click();
    const devices = hostPage.getByRole('region', { name: 'Linked devices' });
    await devices.getByRole('button', { name: 'Get a code' }).click();
    const code = await devices.locator('.code').textContent();
    expect(code).toMatch(/^ABCD-/);

    await joinerPage.goto('http://127.0.0.1:5198/');
    await joinerPage.getByLabel('Link code, twelve characters').fill(code);
    await joinerPage.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(devices.getByText('Allow “Joining Browser”?')).toBeVisible();
    await devices.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(devices.getByRole('status')).toContainText(
      'Joining Browser now has your library.',
    );

    await expect
      .poll(() =>
        joinerPage.evaluate(
          () => JSON.parse(localStorage.getItem('den.links') ?? '[]')[0]?.deviceId,
        ),
      )
      .toBe('aaaa000000000001');
    await expect
      .poll(() =>
        joinerPage.evaluate(() => {
          const link = JSON.parse(localStorage.getItem('den.links') ?? '[]')[0];
          return [link?.sentIdentityName, link?.sentIdentityDeviceId];
        }),
      )
      .toEqual(['Joining Browser', 'bbbb000000000002']);
    await expect
      .poll(() =>
        hostPage.evaluate(
          () => JSON.parse(localStorage.getItem('den.shared') ?? '[]')[0]?.deviceId,
        ),
      )
      .toBe('bbbb000000000002');
    const joined = devices.getByRole('listitem').filter({ hasText: 'Mac' });
    await expect(joined).toHaveCount(1);
    await expect(joined).toContainText('given this library');
    await expect(joined.getByRole('button', { name: 'Forget Mac' })).toBeVisible();

    // Learning the first stable id must not stop authenticated updates. A browser resends after a rename and the
    // host drains that same sealed inbox again even though the Shared record already has an id.
    await joinerPage.evaluate(() => localStorage.setItem('den.deviceName', 'Renamed Joiner'));
    await joinerPage.reload();
    await expect
      .poll(() =>
        joinerPage.evaluate(
          () => JSON.parse(localStorage.getItem('den.links') ?? '[]')[0]?.sentIdentityName,
        ),
      )
      .toBe('Renamed Joiner');
    await hostPage.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(() =>
        hostPage.evaluate(() => JSON.parse(localStorage.getItem('den.shared') ?? '[]')[0]?.name),
      )
      .toBe('Renamed Joiner');
  } finally {
    await host.close();
    await joiner.close();
    await browser.close();
  }
});
