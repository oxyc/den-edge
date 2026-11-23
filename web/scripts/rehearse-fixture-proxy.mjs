import { createServer } from 'node:http';

/**
 * A loopback-only rehearsal origin. Worker-owned same-origin requests do not cross Playwright's page routing seam,
 * so deterministic external-provider answers live here while every other request still reaches the real Edge host.
 */
export function startRehearsalFixtureProxy(upstreamOrigin, fixture) {
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
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const upstream = await fetch(`${upstreamOrigin()}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
      });
      const responseHeaders = Object.fromEntries(upstream.headers);
      // Node's fetch has already decoded the body.
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'qualification_edge_unavailable' }));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}
