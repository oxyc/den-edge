import { createServer } from 'node:http';

/**
 * A loopback-only rehearsal origin. Worker-owned same-origin requests do not cross Playwright's page routing seam,
 * so deterministic external-provider answers live here while every other request still reaches the real Edge host.
 */
export function startRehearsalFixtureProxy(
  upstreamOrigin,
  fixture,
  { listen = (server) => server.listen(0, '127.0.0.1') } = {},
) {
  const barriers = [];
  const activeHolds = new Set();
  const barrier = (mode, { method, pathname, token, wire }) => {
    let matched;
    let rejected;
    let release;
    const matchedPromise = new Promise((done, reject) => {
      matched = done;
      rejected = reject;
    });
    const releasePromise = new Promise((done) => (release = done));
    const entry = {
      method,
      pathname,
      token,
      wire,
      mode,
      matched,
      rejected,
      release,
      releasePromise,
    };
    entry.timer = setTimeout(() => {
      const index = barriers.indexOf(entry);
      if (index !== -1) barriers.splice(index, 1);
      rejected(new Error(`fixture proxy ${mode} barrier timed out before an exact request`));
    }, 45_000);
    entry.timer.unref();
    barriers.push(entry);
    return {
      matched: matchedPromise,
      ...(mode === 'hold' ? { release } : {}),
    };
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const answer = fixture(url);
    if (answer) {
      response.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
        ...answer.headers,
      });
      response.end(JSON.stringify(answer.body));
      return;
    }
    try {
      const barrierIndex = barriers.findIndex(
        (candidate) =>
          candidate.method === request.method &&
          candidate.pathname === url.pathname &&
          candidate.token === request.headers['x-den-library-token'] &&
          candidate.wire === request.headers['x-den-wire'],
      );
      const activeBarrier = barrierIndex === -1 ? undefined : barriers.splice(barrierIndex, 1)[0];
      if (activeBarrier) clearTimeout(activeBarrier.timer);
      activeBarrier?.matched();
      if (activeBarrier?.mode === 'hold') {
        activeHolds.add(activeBarrier);
        await activeBarrier.releasePromise;
        activeHolds.delete(activeBarrier);
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const upstream = await fetch(`${upstreamOrigin()}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (activeBarrier?.mode === 'drop') {
        response.destroy();
        return;
      }
      const responseHeaders = Object.fromEntries(upstream.headers);
      // Node's fetch has already decoded the body.
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      response.writeHead(upstream.status, responseHeaders);
      response.end(body);
    } catch {
      if (response.destroyed) return;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'qualification_edge_unavailable' }));
    }
  });
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', listening);
      server.off('error', failed);
      if (server.listening) server.close(() => {});
      reject(error);
    };
    const listening = () => {
      server.off('error', failed);
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        dropNext: (match) => barrier('drop', match),
        holdNext: (match) => barrier('hold', match),
        close: () => {
          for (const pending of barriers.splice(0)) {
            clearTimeout(pending.timer);
            pending.rejected(new Error('fixture proxy closed before the exact request matched'));
            pending.release();
          }
          for (const active of activeHolds) active.release();
          return new Promise((done) => server.close(done));
        },
      });
    };
    server.once('error', failed);
    server.once('listening', listening);
    try {
      listen(server);
    } catch (error) {
      failed(error);
    }
  });
}
