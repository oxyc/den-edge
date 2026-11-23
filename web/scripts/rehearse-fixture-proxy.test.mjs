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
  const upstream = await listen((request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`upstream:${request.url}`);
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

    const forwarded = await fetch(`${proxy.origin}/lib/abc/changes?since=4`).then((response) =>
      response.text(),
    );
    assert.equal(forwarded, 'upstream:/lib/abc/changes?since=4');
    assert.equal(upstreamRequests, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
