import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { startRehearsalFixtureProxy } from './rehearse-fixture-proxy.mjs';

const listen = (handler) => {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
};

test('answers worker-origin fixtures locally and forwards every other request', async () => {
  let upstreamRequests = 0;
  let received;
  const upstream = await listen((request, response) => {
    upstreamRequests += 1;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = {
        method: request.method,
        url: request.url,
        token: request.headers['x-den-library-token'],
        wire: request.headers['x-den-wire'],
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(207, {
        'content-type': 'application/octet-stream',
        'x-upstream-proof': 'preserved',
      });
      response.end('committed');
    });
  });
  const proxy = await startRehearsalFixtureProxy(
    () => upstream.origin,
    (url) =>
      url.pathname.startsWith('/tmdb/3/')
        ? { body: { id: Number(url.pathname.split('/').at(-1)), title: 'Fixture' } }
        : undefined,
  );
  try {
    const fixture = await fetch(`${proxy.origin}/tmdb/3/movie/1002`).then((response) =>
      response.json(),
    );
    assert.deepEqual(fixture, { id: 1002, title: 'Fixture' });
    assert.equal(upstreamRequests, 0);

    const forwarded = await fetch(`${proxy.origin}/lib/abc/batch?mode=commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-den-library-token': 'owner-token',
        'x-den-wire': '5',
      },
      body: 'sealed-batch',
    });
    assert.equal(forwarded.status, 207);
    assert.equal(forwarded.headers.get('x-upstream-proof'), 'preserved');
    assert.equal(forwarded.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await forwarded.text(), 'committed');
    assert.equal(upstreamRequests, 1);
    assert.deepEqual(received, {
      method: 'POST',
      url: '/lib/abc/batch?mode=commit',
      token: 'owner-token',
      wire: '5',
      contentType: 'application/octet-stream',
      body: 'sealed-batch',
    });

    await proxy.close();
    await assert.rejects(fetch(`${proxy.origin}/health`));
  } finally {
    await proxy.close().catch(() => {});
    await upstream.close();
  }
});

test('rejects a listener bind error without leaving listeners or a server behind', async () => {
  const expected = new Error('injected bind failure');
  let rejectedServer;
  await assert.rejects(
    startRehearsalFixtureProxy(
      () => 'http://127.0.0.1:1',
      () => undefined,
      {
        listen: (server) => {
          rejectedServer = server;
          server.emit('error', expected);
        },
      },
    ),
    expected,
  );
  assert.equal(rejectedServer.listening, false);
  assert.equal(rejectedServer.listenerCount('error'), 0);
  assert.equal(
    rejectedServer
      .rawListeners('listening')
      .some((listener) => listener.name === 'listening' || listener.listener?.name === 'listening'),
    false,
  );
});

test('returns a bounded failure and closes its listener when Edge is unavailable', async () => {
  const upstream = await listen((_request, response) => response.end());
  await upstream.close();
  const proxy = await startRehearsalFixtureProxy(
    () => upstream.origin,
    () => undefined,
  );
  const held = proxy.holdNext({ method: 'GET', pathname: '/lib/abc/changes' });
  const responsePromise = fetch(`${proxy.origin}/lib/abc/changes?since=0`);
  await held.matched;
  held.release();
  await assert.rejects(held.completed);
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'qualification_edge_unavailable' });

  await proxy.close();
  await assert.rejects(fetch(`${proxy.origin}/health`));
});

test('drops exactly one worker-origin response after forwarding the committed request', async () => {
  let requests = 0;
  const received = [];
  const upstream = await listen(async (request, response) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      body: Buffer.concat(chunks).toString('utf8'),
      method: request.method,
      token: request.headers['x-den-library-token'],
      url: request.url,
      wire: request.headers['x-den-wire'],
    });
    response.end('committed');
  });
  const proxy = await startRehearsalFixtureProxy(
    () => upstream.origin,
    () => undefined,
  );
  try {
    const match = {
      method: 'POST',
      pathname: '/lib/owner/batch',
      token: 'owner-token',
      wire: '5',
    };
    const dropped = proxy.dropNext(match);
    for (const request of [
      ['/lib/other/batch', 'POST', 'owner-token', '5'],
      ['/lib/owner/batch', 'GET', 'owner-token', '5'],
      ['/lib/owner/batch', 'POST', 'other-token', '5'],
      ['/lib/owner/batch', 'POST', 'owner-token', '4'],
    ]) {
      assert.equal(
        await fetch(`${proxy.origin}${request[0]}`, {
          method: request[1],
          headers: { 'x-den-library-token': request[2], 'x-den-wire': request[3] },
          ...(request[1] === 'POST' ? { body: 'unrelated' } : {}),
        }).then((response) => response.text()),
        'committed',
      );
    }
    await assert.rejects(
      fetch(`${proxy.origin}/lib/owner/batch?query=1`, {
        method: 'POST',
        headers: { 'x-den-library-token': 'owner-token', 'x-den-wire': '5' },
        body: 'sealed',
      }),
    );
    await dropped.matched;
    assert.equal(requests, 5);
    assert.deepEqual(received.at(-1), {
      body: 'sealed',
      method: 'POST',
      token: 'owner-token',
      url: '/lib/owner/batch?query=1',
      wire: '5',
    });
    assert.equal(
      await fetch(`${proxy.origin}/lib/owner/batch`, { method: 'POST', body: 'next' }).then((r) =>
        r.text(),
      ),
      'committed',
    );
    assert.equal(requests, 6);
  } finally {
    await proxy.close().catch(() => {});
    await upstream.close();
  }
});

test('holds exactly one worker-origin request until release and close cannot strand a hold', async () => {
  let requests = 0;
  let allowFirstResponse;
  const firstResponseAllowed = new Promise((done) => (allowFirstResponse = done));
  let firstRequestStarted;
  const firstRequest = new Promise((done) => (firstRequestStarted = done));
  const upstream = await listen(async (_request, response) => {
    requests += 1;
    if (requests === 1) {
      firstRequestStarted();
      await firstResponseAllowed;
    }
    response.end('committed');
  });
  const proxy = await startRehearsalFixtureProxy(
    () => upstream.origin,
    () => undefined,
  );
  try {
    const match = {
      method: 'POST',
      pathname: '/lib/owner/batch',
      token: 'owner-token',
      wire: '5',
    };
    const held = proxy.holdNext(match);
    const request = fetch(`${proxy.origin}/lib/owner/batch`, {
      method: 'POST',
      headers: { 'x-den-library-token': 'owner-token', 'x-den-wire': '5' },
      body: 'sealed',
    });
    await held.matched;
    assert.equal(requests, 0);
    held.release();
    await firstRequest;
    let completedBeforeUpstream = false;
    held.completed.then(() => (completedBeforeUpstream = true));
    await Promise.resolve();
    assert.equal(completedBeforeUpstream, false);
    allowFirstResponse();
    assert.deepEqual(await held.completed, { ok: true, status: 200 });
    assert.equal(await request.then((response) => response.text()), 'committed');
    assert.equal(requests, 1);

    const closeHeld = proxy.holdNext(match);
    const closingRequest = fetch(`${proxy.origin}/lib/owner/batch`, {
      method: 'POST',
      headers: { 'x-den-library-token': 'owner-token', 'x-den-wire': '5' },
      body: 'closing',
    });
    await closeHeld.matched;
    const closing = proxy.close();
    assert.deepEqual(await closeHeld.completed, { ok: true, status: 200 });
    assert.equal(await closingRequest.then((response) => response.text()), 'committed');
    await closing;
    assert.equal(requests, 2);
  } finally {
    await proxy.close().catch(() => {});
    await upstream.close();
  }
});

test('close rejects an unmatched one-shot barrier instead of stranding its waiter', async () => {
  const upstream = await listen((_request, response) => response.end('ok'));
  const proxy = await startRehearsalFixtureProxy(
    () => upstream.origin,
    () => undefined,
  );
  const pending = proxy.holdNext({
    method: 'POST',
    pathname: '/lib/owner/batch',
    token: 'owner-token',
    wire: '5',
  });
  const rejection = assert.rejects(pending.matched, /closed before the exact request matched/);
  const completionRejection = assert.rejects(
    pending.completed,
    /closed before the exact request matched/,
  );
  await proxy.close();
  await rejection;
  await completionRejection;
  await upstream.close();
});
