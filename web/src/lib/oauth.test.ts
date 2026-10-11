import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  answer,
  consentRequest,
  consentRequestId,
  fetchMcpUrl,
  listConnections,
  revokeConnection,
  safeRedirect,
} from './oauth';
import {
  forgetGrant,
  forgetLibraryCredential,
  relayFetch,
  rememberGrant,
  useLibraryCredential,
} from './relayFetch';

const ID = '0123456789abcdef0123456789abcdef';
const HERE = 'https://den.example/connect?request=' + ID;

beforeEach(() => vi.stubGlobal('location', { href: HERE, origin: new URL(HERE).origin }));

afterEach(() => {
  forgetLibraryCredential();
  forgetGrant('a1b2c3d4');
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
  vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status }));

test('the consent page reads its request id from /connect only', () => {
  expect(consentRequestId(HERE)).toBe(ID);
  expect(consentRequestId(`https://den.example/connect?request=${ID.toUpperCase()}`)).toBeNull();
  expect(consentRequestId(`https://den.example/search?request=${ID}`)).toBeNull();
  expect(consentRequestId('https://den.example/connect?request=nope')).toBeNull();
  expect(consentRequestId('not a url')).toBeNull();
});

test('only an https redirect, or http to this machine, is followed', () => {
  expect(safeRedirect('https://claude.ai/api/mcp/auth_callback?code=x')).toBe(true);
  expect(safeRedirect('http://127.0.0.1:33418/callback')).toBe(true);
  expect(safeRedirect('http://localhost/cb')).toBe(true);
  expect(safeRedirect('http://assistant.example/cb')).toBe(false);
  expect(safeRedirect('javascript:alert(1)')).toBe(false);
  expect(safeRedirect('/relative')).toBe(false);
});

test('a request is shown by the client and the host it answers to', async () => {
  const fetchImpl = reply(200, {
    client: 'Claude',
    redirectHost: 'claude.ai',
    verified: true,
    scope: 'den:search',
  });
  expect(await consentRequest(ID, fetchImpl)).toEqual({
    ok: true,
    value: {
      client: 'Claude',
      redirectHost: 'claude.ai',
      verified: true,
      write: false,
      read: false,
    },
  });
  // Only den-edge's own word marks a host known, or a request one that may change or read the library.
  const unsure = await consentRequest(
    ID,
    reply(200, {
      client: 'Claude',
      redirectHost: 'evil.example',
      verified: 'yes',
      write: 'yes',
      read: 1,
    }),
  );
  expect(unsure).toEqual({
    ok: true,
    value: {
      client: 'Claude',
      redirectHost: 'evil.example',
      verified: false,
      write: false,
      read: false,
    },
  });
  const writable = await consentRequest(
    ID,
    reply(200, { client: 'Claude', write: true, read: true }),
  );
  expect(writable.ok && [writable.value.write, writable.value.read]).toEqual([true, true]);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/oauth/request/${ID}`);
  expect(await consentRequest(ID, reply(404, { error: 'request_expired' }))).toEqual({
    ok: false,
    status: 404,
    error: 'request_expired',
  });
});

test('an answer follows den-edge back to the assistant, and nowhere unsafe', async () => {
  const back = 'https://claude.ai/api/mcp/auth_callback?code=abc&state=s';
  const fetchImpl = reply(200, { redirect: back });
  expect(await answer(ID, true, fetchImpl)).toEqual({ ok: true, value: back });
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/oauth/request/${ID}/approve`);
  expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  const denied = reply(200, { redirect: 'https://claude.ai/cb?error=access_denied' });
  await answer(ID, false, denied);
  expect(denied.mock.calls[0]?.[0]).toBe(`/oauth/request/${ID}/deny`);
  expect(await answer(ID, true, reply(200, { redirect: 'javascript:alert(1)' }))).toMatchObject({
    ok: false,
  });
  expect(await answer(ID, true, reply(403, { error: 'not_a_member' }))).toEqual({
    ok: false,
    status: 403,
    error: 'not_a_member',
  });
  // Without a grant the approval has no body: den-search alone, as before.
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
});

test('allowing changes approves with the grant, and denying never sends one', async () => {
  const write = { grant: 'd7047d7faa4c6f77e1919c132bb6bd9f', key: 'a-seed' };
  const back = 'https://claude.ai/api/mcp/auth_callback?code=abc';
  const approved = reply(200, { redirect: back });
  expect(await answer(ID, true, approved, { write })).toEqual({ ok: true, value: back });
  const init = approved.mock.calls[0]?.[1];
  expect(JSON.parse(init?.body as string)).toEqual({ write });
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  const denied = reply(200, { redirect: 'https://claude.ai/cb?error=access_denied' });
  await answer(ID, false, denied, { write });
  expect(denied.mock.calls[0]?.[1]?.body).toBeUndefined();
  // Reading, alone or beside writing, with the read key.
  const read = { ...write, readKey: 'a-read-key' };
  const reading = reply(200, { redirect: back });
  await answer(ID, true, reading, { write, read });
  expect(JSON.parse(reading.mock.calls[0]?.[1]?.body as string)).toEqual({ write, read });
  // An approval that allows nothing more sends no body: searching alone.
  const plain = reply(200, { redirect: back });
  await answer(ID, true, plain, {});
  expect(plain.mock.calls[0]?.[1]?.body).toBeUndefined();
});

test('approving carries the member’s proof, or a guest’s, and nothing for a stranger', async () => {
  const spy = reply(200, {});
  vi.stubGlobal('fetch', spy);
  const sent = () => Object.fromEntries(new Headers(spy.mock.calls.at(-1)?.[1]?.headers).entries());

  await relayFetch(`/oauth/request/${ID}/approve`, { method: 'POST' });
  expect(sent()['x-den-library-member']).toBeUndefined();
  expect(sent()['x-den-grant']).toBeUndefined();

  rememberGrant('a1b2c3d4', 'sekrit');
  await relayFetch(`/oauth/request/${ID}/approve`, { method: 'POST' });
  expect(sent()['x-den-grant']).toBe('a1b2c3d4:sekrit');

  useLibraryCredential({ id: 'abc123', member: 'def456' });
  for (const path of [
    `/oauth/request/${ID}/approve`,
    '/oauth/connections',
    `/oauth/connections/${ID}`,
  ]) {
    await relayFetch(path);
    expect(sent()['x-den-library-member'], path).toBe('abc123:def456');
    expect(sent()['x-den-grant'], path).toBeUndefined();
  }
  // Nothing else under /oauth is given a proof: the token endpoint is the assistant's, not this browser's.
  await relayFetch('/oauth/token', { method: 'POST' });
  expect(sent()['x-den-library-member']).toBeUndefined();
  // The assistant queue's member routes carry it; the routes den-mcp calls with its token do not.
  for (const path of ['/assistant/dropbox', '/assistant/drain', '/assistant/ack']) {
    await relayFetch(path, { method: 'POST' });
    expect(sent()['x-den-library-member'], path).toBe('abc123:def456');
  }
  await relayFetch('/assistant/append', { method: 'POST' });
  expect(sent()['x-den-library-member']).toBeUndefined();
});

test('a guest’s grant is never sent to the assistant queue', async () => {
  const spy = reply(403, { error: 'not_a_member' });
  vi.stubGlobal('fetch', spy);
  rememberGrant('a1b2c3d4', 'sekrit');
  await relayFetch('/assistant/drain', { method: 'POST' });
  const sent = new Headers(spy.mock.calls.at(-1)?.[1]?.headers);
  expect(sent.get('x-den-grant')).toBeNull();
  expect(sent.get('x-den-library-member')).toBeNull();
});

test('connections are listed as den-edge describes them, and revoked', async () => {
  const listed = await listConnections(
    reply(200, {
      connections: [
        {
          sid: 's1',
          client: 'Claude',
          redirectHost: 'claude.ai',
          kind: 'member',
          guest: null,
          createdAt: 1,
          usedAt: 2,
          grant: 'd7047d7faa4c6f77e1919c132bb6bd9f',
        },
        {
          sid: 's2',
          client: 'ChatGPT',
          kind: 'guest',
          guest: 'Sam',
          createdAt: 3,
          usedAt: 4,
          grant: 'not-a-grant-id',
        },
        {
          sid: 's3',
          client: 'Claude',
          kind: 'member',
          createdAt: 5,
          usedAt: 6,
          grant: 'e7047d7faa4c6f77e1919c132bb6bd9f',
          write: false,
          read: true,
        },
        { nope: true },
      ],
    }),
  );
  expect(listed).toEqual({
    ok: true,
    value: [
      {
        sid: 's1',
        client: 'Claude',
        redirectHost: 'claude.ai',
        kind: 'member',
        guest: null,
        createdAt: 1,
        usedAt: 2,
        grant: 'd7047d7faa4c6f77e1919c132bb6bd9f',
        // As a den-edge from before reads lists it: a grant that writes.
        write: true,
        read: false,
      },
      {
        sid: 's2',
        client: 'ChatGPT',
        redirectHost: null,
        kind: 'guest',
        guest: 'Sam',
        createdAt: 3,
        usedAt: 4,
        grant: null,
        write: false,
        read: false,
      },
      {
        sid: 's3',
        client: 'Claude',
        redirectHost: null,
        kind: 'member',
        guest: null,
        createdAt: 5,
        usedAt: 6,
        grant: 'e7047d7faa4c6f77e1919c132bb6bd9f',
        write: false,
        read: true,
      },
    ],
  });
  const gone = vi.fn(async () => new Response(null, { status: 204 }));
  expect(await revokeConnection('s1', gone)).toEqual({ ok: true, value: null });
  expect(gone.mock.calls[0]).toEqual(['/oauth/connections/s1', { method: 'DELETE' }]);
});

test('the connector address comes from /config, and only an https one', async () => {
  expect(await fetchMcpUrl(reply(200, { mcpUrl: 'https://den.example/mcp' }))).toBe(
    'https://den.example/mcp',
  );
  expect(await fetchMcpUrl(reply(200, {}))).toBeNull();
  expect(await fetchMcpUrl(reply(200, { mcpUrl: 'http://den.example/mcp' }))).toBeNull();
  // Off is null; a Den that couldn't be asked is undefined, so the page doesn't call it off.
  expect(await fetchMcpUrl(reply(503, {}))).toBeUndefined();
});
