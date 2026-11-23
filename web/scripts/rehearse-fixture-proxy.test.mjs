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
  const response = await fetch(`${proxy.origin}/lib/abc/changes?since=0`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'qualification_edge_unavailable' });

  await proxy.close();
  await assert.rejects(fetch(`${proxy.origin}/health`));
});
