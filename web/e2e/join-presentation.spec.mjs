import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

function pairingRelay() {
  const sessions = new Map();
  const nameplates = ['ABCD', 'EFGH', 'JKLM', 'NPQR'];
  const counts = { new: 0, open: 0, puts: 0, deletes: 0 };
  const json = (route, status, body) => route.fulfill({ status, json: body });
  const route = async (requestRoute) => {
    const request = requestRoute.request();
    const url = new URL(request.url());
    if (url.origin !== E2E_ORIGIN) return requestRoute.abort('blockedbyclient');
    const body = request.postData() ? request.postDataJSON() : {};
    if (url.pathname === '/pair/new') {
      const nameplate = nameplates[counts.new++] ?? 'STUV';
      sessions.set(body.sid, { nameplate, opened: false, slots: new Map() });
      return json(requestRoute, 200, { nameplate });
    }
    if (url.pathname === '/pair/open') {
      counts.open++;
      const found = [...sessions].find(([, session]) => session.nameplate === body.nameplate);
      if (!found || found[1].opened) return json(requestRoute, 409, { error: 'claimed' });
      found[1].opened = true;
      return json(requestRoute, 200, { sid: found[0] });
    }
    const slot = url.pathname.match(/^\/pair\/([0-9a-f]{32})\/([abcd])$/);
    if (slot) {
      const session = sessions.get(slot[1]);
      if (!session) return json(requestRoute, 410, { error: 'expired' });
      if (request.method() === 'PUT') {
        counts.puts++;
        session.slots.set(slot[2], body.m);
        return requestRoute.fulfill({ status: 204 });
      }
      return session.slots.has(slot[2])
        ? json(requestRoute, 200, { m: session.slots.get(slot[2]) })
        : requestRoute.fulfill({ status: 202 });
    }
    const ending = url.pathname.match(/^\/pair\/([0-9a-f]{32})$/);
    if (ending && request.method() === 'DELETE') {
      counts.deletes++;
      return requestRoute.fulfill({ status: 204 });
    }
    if (url.pathname === '/inbox/append') return json(requestRoute, 200, { appended: true });
    if (url.pathname === '/inbox/drain')
      return json(
        requestRoute,
        200,
        request.method() === 'POST' ? { queues: body.keys.map(() => []) } : { messages: [] },
      );
    if (url.pathname === '/routes') return json(requestRoute, 200, {});
    if (url.pathname === '/version') return json(requestRoute, 200, { version: 'test' });
    if (url.pathname === '/config') return json(requestRoute, 200, {});
    if (url.pathname === '/recovery') return json(requestRoute, 200, { entries: [] });
    if (url.pathname === '/recovery/timing') return requestRoute.fulfill({ status: 204 });
    if (url.pathname === '/capabilities/profiles')
      return json(requestRoute, 404, { error: 'not_found' });
    if (/^\/lib\/[^/]+\/grants$/.test(url.pathname)) return json(requestRoute, 200, { grants: [] });
    if (/^\/(?:lib|tmdb|atlas|reel|den)\//.test(url.pathname)) return json(requestRoute, 404, {});
    return requestRoute.continue();
  };
  return { route, counts };
}

async function pages(browser) {
  const relay = pairingRelay();
  const hostContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  await hostContext.addInitScript(() => {
    localStorage.setItem('den.deviceID', 'aaaa000000000001');
    localStorage.setItem('den.deviceName', 'Host Browser');
  });
  await joinerContext.addInitScript(() => {
    localStorage.setItem('den.deviceID', 'bbbb000000000002');
    localStorage.setItem('den.deviceName', 'Joining Browser');
  });
  await hostContext.route('**/*', relay.route);
  await joinerContext.route('**/*', relay.route);
  const host = await hostContext.newPage();
  const joiner = await joinerContext.newPage();
  await host.goto(`${E2E_ORIGIN}/test/settings.html`);
  await joiner.goto(`${E2E_ORIGIN}/test/settings.html?join-presentation`);
  return {
    host,
    joiner,
    relay,
    close: async () => {
      await Promise.all([hostContext.close(), joinerContext.close()]);
    },
  };
}

async function pair(host, joiner) {
  const hostDevices = host.getByRole('region', { name: 'Linked devices' });
  const joinerDevices = joiner.getByRole('region', { name: 'Linked devices' });
  if (!(await hostDevices.isVisible()))
    await host.getByRole('button', { name: /Linked devices/ }).click();
  if (!(await joinerDevices.isVisible()))
    await joiner.getByRole('button', { name: /Linked devices/ }).click();
  await hostDevices.getByRole('button', { name: 'Get a code' }).click();
  const code = (await hostDevices.locator('.code').textContent()).trim();
  await joinerDevices.locator('#join-library-code').fill(code);
  await joinerDevices.getByRole('button', { name: 'Link', exact: true }).click();
  await joinerDevices
    .getByRole('group', { name: 'Link this browser to that TV?' })
    .getByRole('button', { name: 'Link', exact: true })
    .click();
  await expect(hostDevices.getByText('Allow “Joining Browser”?')).toBeVisible();
  await hostDevices.getByRole('button', { name: 'Allow', exact: true }).click();
}

for (const invalidation of ['replacement', 'unmount']) {
  test(`${invalidation} before the durable household merge abandons pairing without publication`, async ({
    browser,
  }) => {
    const fixture = await pages(browser);
    try {
      await pair(fixture.host, fixture.joiner);
      await expect
        .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
        .toMatchObject([{ stage: 'before' }]);
      await fixture.joiner.evaluate((kind) => {
        if (kind === 'replacement') globalThis.fixtureJoinPresentation.replace();
        else globalThis.fixtureJoinPresentation.unmount();
        globalThis.fixtureJoinPresentation.release(0, 'before');
      }, invalidation);
      await expect
        .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
        .toMatchObject([{ stage: 'abandoned' }]);
      expect(
        await fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.links()),
      ).toEqual([]);
      await expect(fixture.joiner).toHaveURL(/\/test\/settings\.html\?join-presentation$/);
      expect(fixture.relay.counts).toEqual({ new: 1, open: 1, puts: 4, deletes: 0 });
    } finally {
      await fixture.close();
    }
  });
}

test('post-commit reversed completions reconcile exact links without replacing selection or navigating', async ({
  browser,
}) => {
  const fixture = await pages(browser);
  try {
    await pair(fixture.host, fixture.joiner);
    await expect
      .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
      .toMatchObject([{ stage: 'before' }]);
    await fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.release(0, 'before'));
    await expect
      .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
      .toMatchObject([{ stage: 'after' }]);

    await fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.replace());
    await pair(fixture.host, fixture.joiner);
    await expect
      .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
      .toMatchObject([{ stage: 'after' }, { stage: 'before' }]);
    await fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.release(1, 'before'));
    await expect
      .poll(() => fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()))
      .toMatchObject([{ stage: 'after' }, { stage: 'after' }]);

    const replacementInbox = await fixture.joiner.evaluate(
      () => globalThis.fixtureJoinPresentation.calls()[1].link.inboxKey,
    );
    await fixture.joiner.evaluate((inbox) => {
      globalThis.fixtureJoinPresentation.installReplacement(inbox);
      // New is still the current presentation, but its captured address now names different credentials. It finishes
      // before old: neither completion may select, overwrite, announce, or navigate into this replacement.
      globalThis.fixtureJoinPresentation.release(1, 'after');
    }, replacementInbox);
    await expect
      .poll(() =>
        fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()[1].stage),
      )
      .toBe('done');
    await fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.release(0, 'after'));
    await expect
      .poll(() =>
        fixture.joiner.evaluate(() => globalThis.fixtureJoinPresentation.calls()[0].stage),
      )
      .toBe('done');

    const state = await fixture.joiner.evaluate(() => ({
      links: globalThis.fixtureJoinPresentation.links(),
      current: globalThis.fixtureJoinPresentation.current(),
    }));
    expect(state.current).toBe(replacementInbox);
    expect(state.links.find((link) => link.inboxKey === replacementInbox)).toMatchObject({
      name: 'Replacement',
      libraryKey: 'replacement-library',
      linkKey: 'replacement-key',
    });
    expect(state.links).toHaveLength(2);
    await expect(fixture.joiner.getByRole('alert')).toHaveText(
      'Host Browser was linked by another Settings presentation. Reload and try again.',
    );
    await expect(fixture.joiner).toHaveURL(/\/test\/settings\.html\?join-presentation$/);
    expect(fixture.relay.counts).toEqual({ new: 2, open: 2, puts: 8, deletes: 0 });
  } finally {
    await fixture.close();
  }
});
