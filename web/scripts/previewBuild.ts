// A production-bundle audit on the existing secure preview origin, sharing its pairing and API proxies.
// Dev-only: / stays Vite with HMR, /__build/ serves the last npm run build output. No credential copying.
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

export function previewBuild(): Plugin {
  return {
    name: 'den-build-preview',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        // Bundled image URLs can be rooted at /assets/; Vite's source assets use /src/ instead.
        if (!path.startsWith('/__build/') && !path.startsWith('/assets/')) return next();
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end();
          return;
        }
        const relative =
          (path.startsWith('/assets/') ? path.slice(1) : path.slice('/__build/'.length)) ||
          'index.html';
        if (!/^(?:index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(relative)) {
          response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
          return;
        }
        void (async () => {
          try {
            const file = new URL(`../dist/${relative}`, import.meta.url);
            let bytes = await readFile(file);
            const html = relative === 'index.html';
            const headers: Record<string, string> = {
              'Cache-Control': html ? 'no-cache' : 'public, max-age=31536000, immutable',
              Vary: 'Accept-Encoding',
              'X-Content-Type-Options': 'nosniff',
            };
            if (html)
              bytes = Buffer.from(
                bytes.toString('utf8').replaceAll('/assets/', '/__build/assets/'),
              );
            else if (/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers['accept-encoding'] ?? '')) {
              try {
                bytes = await readFile(new URL(file.href + '.gz'));
                headers['Content-Encoding'] = 'gzip';
              } catch {
                /* Identity when no sidecar exists. */
              }
            }
            const mime: Record<string, string> = {
              html: 'text/html; charset=utf-8',
              js: 'text/javascript; charset=utf-8',
              css: 'text/css; charset=utf-8',
              wasm: 'application/wasm',
              png: 'image/png',
              svg: 'image/svg+xml',
            };
            headers['Content-Type'] =
              mime[relative.split('.').pop() ?? ''] ?? 'application/octet-stream';
            headers['Content-Length'] = String(bytes.length);
            response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : bytes);
          } catch {
            response
              .writeHead(404, { 'Cache-Control': 'no-store' })
              .end('Run npm run build to refresh this preview.');
          }
        })();
      });
    },
  };
}
