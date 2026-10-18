// Test a bundled app below a physical directory, with no SPA rewrite or API proxy.
// Success here cannot hide missing relative assets behind Vite's history fallback.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { TV_CSP } from './tv-csp.mjs';

const directory = process.env.DEN_TV_OUT_DIR;
if (!/^dist-tv-tizen-package(?:-e2e-\d+)?$/.test(directory ?? ''))
  throw new Error('Expected an isolated Tizen package output directory');
const root = resolve(import.meta.dirname, '..', directory);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith('/package/')) throw new Error('Not an asset');
    const file = resolve(root, pathname.slice('/package/'.length));
    if (!file.startsWith(root + sep)) throw new Error('Outside package');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy': TV_CSP,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('No package asset at this path');
  }
});
server.listen(Number(process.env.E2E_PORT), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
