// The e2e fixtures' den-edge (`guest-edge.mjs`, `big-library.mjs`) served over real HTTPS on another origin, for a
// packaged TV page that must pay the browser's own CORS preflights. Playwright answers every preflight itself as soon
// as a page or its context has a route, so a page measured here has none: this server answers it instead, the
// preflights den-edge answers (`handler.rs` `preflight`) included, each request `latencyMs` late.
//
//   const edge = await serveCrossOrigin({ latencyMs: 100 });
//   await routeBigHousehold(edge.page, household);       // the same fixture routes, registered on this server
//   ... launch Chromium with `edge.args` and load the package
//
// `edge.log` keeps every request: method, path, whether it was a preflight, and its member header's presence.

import { createSecureServer } from 'node:http2';
import { X509Certificate, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_ORIGIN } from './base-url.mjs';

export const API_HOST = 'den-tv-api.example.invalid';
const HOSTS = [API_HOST, 'image.tmdb.org'];

/** What den-edge's preflight answer says (`handler.rs` `preflight`). */
const PREFLIGHT = {
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'content-type, x-den-link, x-den-library-token, x-den-library-member, x-den-exclusive-attempt, ' +
    'x-den-successor-token, x-den-grant, x-den-wire, x-den-wire-min, x-den-generation, idempotency-key',
  'access-control-max-age': '86400',
};

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'den-cross-origin-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    `/CN=${API_HOST}`,
    '-addext',
    `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(',')}`,
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  const pem = readFileSync(cert);
  // Chromium trusts a certificate whose key is named here as it would a real one, so its answers are cached as a
  // real origin's are; `--ignore-certificate-errors` would leave them uncacheable.
  const spki = createHash('sha256')
    .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  return { key: readFileSync(key), cert: pem, spki };
}

/** Playwright's URL glob: `**` crosses `/`, `*` does not. */
function globRegex(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '.';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export async function serveCrossOrigin({ latencyMs = 0 } = {}) {
  const tls = certificate();
  const pageRoutes = [];
  const contextRoutes = [];
  const log = [];
  const reports = [];
  const add = (list) => async (pattern, handler) => {
    list.unshift({ match: typeof pattern === 'string' ? globRegex(pattern) : pattern, handler });
  };
  const context = { route: add(contextRoutes) };
  // What the fixtures are given in place of a Playwright page.
  const page = { route: add(pageRoutes), context: () => context };

  const server = createSecureServer({ allowHTTP1: true, key: tls.key, cert: tls.cert });
  server.on('tlsClientError', (error) => console.warn(`cross-origin edge: ${error.message}`));
  server.on('request', (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => void answer(req, res, Buffer.concat(chunks)));
  });

  async function answer(req, res, body) {
    const host = String(req.headers[':authority'] ?? req.headers.host ?? '').replace(/:\d+$/, '');
    const origin = req.headers.origin;
    const preflight = req.method === 'OPTIONS' && !!req.headers['access-control-request-method'];
    const entry = {
      at: Date.now(),
      host,
      method: req.method,
      path: req.url,
      preflight,
      member: 'x-den-library-member' in req.headers,
      requested: req.headers['access-control-request-headers'] ?? null,
    };
    log.push(entry);
    if (latencyMs) await new Promise((done) => setTimeout(done, latencyMs));
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    if (preflight) {
      res.writeHead(204, { ...cors, ...PREFLIGHT });
      return res.end();
    }
    if (req.url === '/playback/load' && req.method === 'POST') {
      try {
        reports.push(JSON.parse(body.toString()));
      } catch {
        // Not a report.
      }
      res.writeHead(204, cors);
      return res.end();
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !name.startsWith(':')),
    );
    const answered = await ask(host, req.method, req.url, headers, body);
    entry.status = answered?.status ?? 'aborted';
    if (!answered) return res.stream?.close?.() ?? res.destroy();
    res.writeHead(answered.status, {
      'cache-control': 'no-store',
      ...cors,
      'access-control-expose-headers': 'x-den-wire-min, x-den-generation',
      ...answered.headers,
    });
    res.end(answered.body);
  }

  /** What the fixtures answer `method path` on `host`: `{ status, headers, body }`, or null when they abort it. */
  async function ask(host, method, path, headers, body = Buffer.alloc(0)) {
    // The fixtures answer den-edge on the dev server's origin, so the API's requests are given to them as that.
    const urls =
      host === API_HOST
        ? [`${E2E_ORIGIN}${path}`, `https://${host}${path}`]
        : [`https://${host}${path}`];
    const request = {
      url: () => urls[0],
      method: () => method,
      headers: () => headers,
      postData: () => (body.length ? body.toString() : null),
      postDataBuffer: () => (body.length ? body : null),
      postDataJSON: () => (body.length ? JSON.parse(body.toString()) : null),
    };
    const handlers = [...pageRoutes, ...contextRoutes].filter(({ match }) =>
      urls.some((url) => match.test(url)),
    );
    let answered;
    const notFound = { status: 404, headers: { 'content-type': 'application/json' }, body: '{}' };
    for (const { handler } of handlers) {
      let next = false;
      const route = {
        request: () => request,
        fulfill: async ({
          status = 200,
          json,
          body: text,
          headers: extra = {},
          contentType,
        } = {}) => {
          const lower = Object.fromEntries(
            Object.entries(extra).map(([name, value]) => [name.toLowerCase(), String(value)]),
          );
          if (json !== undefined) lower['content-type'] ??= 'application/json';
          if (contentType) lower['content-type'] = contentType;
          answered = {
            status,
            headers: lower,
            body: json !== undefined ? JSON.stringify(json) : (text ?? ''),
          };
        },
        continue: async () => {
          answered = notFound;
        },
        fallback: async () => {
          next = true;
        },
        abort: async () => {
          answered = null;
        },
      };
      await handler(route);
      if (answered !== undefined || !next) break;
    }
    return answered === undefined ? notFound : answered;
  }

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address();
  return {
    page,
    log,
    reports,
    origin: `https://${API_HOST}`,
    /** Chromium's arguments for reaching this server by the package's API name, and nothing else outside. */
    args: [
      `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${tls.spki}`,
    ],
    close: () => new Promise((done) => server.close(done)),
  };
}
