import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import browser from './vite.config.ts';

const platform = process.env.DEN_TV_PLATFORM ?? 'webos';
if (platform !== 'webos' && platform !== 'tizen') throw new Error('Unknown DEN_TV_PLATFORM');
const compat = fileURLToPath(new URL('./src/tv/compat.ts', import.meta.url));
const e2e = process.env.DEN_TV_E2E === '1';
const outDir = process.env.DEN_TV_OUT_DIR ?? `dist-tv-${platform}`;
if (!/^dist-tv-(?:webos|tizen)(?:-e2e-\d+)?$/.test(outDir))
  throw new Error('DEN_TV_OUT_DIR must name an isolated dist-tv platform directory');
const hostname = process.env.DEN_TV_HOST;
if (hostname && !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(hostname))
  throw new Error('DEN_TV_HOST must be a hostname only (no scheme, port or wildcard)');
const allowedHosts = ['localhost', '.ts.net', ...(hostname ? [hostname] : [])];

// Workers have their own globals: installing page polyfills does not fix a Worker. Prepend to every owned
// Worker entry, before any application module evaluates, without changing browser source or browser output.
function workerCompatibility(): Plugin {
  return {
    name: 'den-tv-worker-compatibility',
    enforce: 'pre',
    transform(code, id) {
      if (/\/src\/lib\/(?:libraryServiceWorker|libraryWorker|recoveryWorker)\.ts$/.test(id))
        return { code: `import ${JSON.stringify(compat)};\n${code}`, map: null };
    },
  };
}

const tvEntry: Plugin = {
  name: 'den-tv-entry',
  transformIndexHtml: {
    order: 'pre',
    handler(html, context) {
      // Dev history fallbacks keep the requested path (/movies, /settings), but resolve to index.html.
      if (context.filename !== fileURLToPath(new URL('./index.html', import.meta.url))) {
        if (e2e && context.filename.endsWith('/test/player.html'))
          return html.replace('/test/player.ts', '/src/tv/test-entry.ts');
        return html;
      }
      return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1920, initial-scale=1"><meta name="theme-color" content="#0b0b0f">
<title>Den TV</title></head><body><div id="app"><p>Starting Den…</p></div>
<script type="module" src="/src/tv/main.ts"></script></body></html>`;
    },
  },
};

const https =
  process.env.DEN_TLS_CERT && process.env.DEN_TLS_KEY
    ? { cert: readFileSync(process.env.DEN_TLS_CERT), key: readFileSync(process.env.DEN_TLS_KEY) }
    : undefined;
const tvProxy = {
  ...browser.server?.proxy,
  ...Object.fromEntries(
    [
      '/grant',
      '/oauth',
      '/capabilities',
      '/playback',
      '/den',
      '/ratings',
      '/warnings',
      '/skipdb',
      '/subs',
      '/subtitles',
      '/sync',
      '/mcp',
      '/link',
      '/version',
    ].map((path) => [
      path,
      { target: process.env.DEN_EDGE ?? 'http://192.168.86.193:8094', changeOrigin: true },
    ]),
  ),
};

export default mergeConfig(
  browser,
  defineConfig({
    define: { __DEN_TV__: 'true', __DEN_TV_PLATFORM__: JSON.stringify(platform) },
    plugins: [tvEntry, workerCompatibility()],
    worker: { plugins: () => [workerCompatibility(), svelte()] },
    build: {
      target: 'chrome85',
      cssTarget: 'chrome85',
      outDir,
      manifest: true,
      ...(e2e ? { rolldownOptions: { input: ['index.html', 'test/player.html'] } } : {}),
    },
    server: { https, proxy: tvProxy, allowedHosts },
    preview: {
      https,
      allowedHosts,
      // Same-origin API access on the local production preview, including pairing and Worker requests.
      proxy: tvProxy,
    },
  }),
);
