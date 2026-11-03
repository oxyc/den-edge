// A SharedWorker's requests escape Playwright's routes in Chromium and WebKit alike: Playwright attaches to a page and
// its dedicated Workers, never to a SharedWorker, so they reach the server the page came from. A build that keeps the
// SharedWorker (`DEN_E2E_SHARED_WORKER=1`) is previewed with den-edge, atlas, reel and remux proxied to this bridge
// (`bridgeUpstreams`, loopback as `scripts/upstream.ts` requires), and the bridge asks a plain page of the same origin to
// make the same request. That page's routes answer it as the fixture answers the app's own requests, so a spec routes
// a SharedWorker's den-edge exactly as it routes a dedicated Worker's.
//
//   const bridge = await sharedWorkerBridge();               // once per file
//   const page = await context.newPage();
//   await routeBigHousehold(page, edge);                     // the routes it should answer with
//   await bridge.answerFrom(page);                           // until another page takes over

import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { E2E_ORIGIN } from './base-url.mjs';

// Picked once, in the runner (where the config imports this first), and inherited by its workers: see base-url.mjs.
if (!process.env.DEN_E2E_BRIDGE_PORT) {
  process.env.DEN_E2E_BRIDGE_PORT = String(
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    }),
  );
}
const BRIDGE = `http://127.0.0.1:${process.env.DEN_E2E_BRIDGE_PORT}`;

/**
 * The preview server's upstreams, pointed at the bridge. atlas and reel lose their prefix on the way (vite.config.ts),
 * so their targets carry it back.
 */
export const bridgeUpstreams = {
  DEN_EDGE: BRIDGE,
  DEN_ATLAS: `${BRIDGE}/atlas`,
  DEN_REEL: `${BRIDGE}/reel`,
  DEN_REMUX: BRIDGE,
};

/** The request headers a page would send itself: the app's own, and what says what its body is. */
const forwarded = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.startsWith('x-den-') || name === 'content-type' || name === 'accept',
    ),
  );

/**
 * Start the bridge. `served`: every path it answered, so a spec can show the SharedWorker's requests reached it.
 * `log`: each request with its time and status, or why it failed, for a spec to keep beside a failure.
 */
export async function sharedWorkerBridge() {
  let page = null;
  const served = [];
  const log = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const via = page;
    if (!via) {
      response.writeHead(503).end();
      return;
    }
    try {
      const answer = await via.evaluate(
        async ({ url, method, headers, body }) => {
          const sent = await fetch(url, {
            method,
            headers,
            ...(body ? { body: Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) } : {}),
          });
          const bytes = new Uint8Array(await sent.arrayBuffer());
          let binary = '';
          for (let at = 0; at < bytes.length; at += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
          return { status: sent.status, headers: [...sent.headers], body: btoa(binary) };
        },
        {
          url: `${E2E_ORIGIN}${request.url}`,
          method: request.method,
          headers: forwarded(request.headers),
          body: body.length ? body.toString('base64') : null,
        },
      );
      served.push(request.url);
      log.push(`${Date.now()} ${request.method} ${request.url} ${answer.status}`);
      const headers = Object.fromEntries(
        answer.headers.filter(([name]) => name !== 'content-encoding' && name !== 'content-length'),
      );
      response.writeHead(answer.status, headers).end(Buffer.from(answer.body, 'base64'));
    } catch (error) {
      // The page's routes refused it (an unexpected request), or the page has gone.
      log.push(`${Date.now()} ${request.method} ${request.url} failed: ${error?.message}`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  await new Promise((resolve) =>
    server.listen(Number(process.env.DEN_E2E_BRIDGE_PORT), '127.0.0.1', resolve),
  );
  return {
    served,
    log,
    /** Answer through `routed`, a page already given the routes to answer with. */
    async answerFrom(routed) {
      await routed.route(`${E2E_ORIGIN}/__shared-worker-bridge`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>bridge</title>' }),
      );
      await routed.goto(`${E2E_ORIGIN}/__shared-worker-bridge`);
      page = routed;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
