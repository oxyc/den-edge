import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// In production den-edge serves the app and its API from one origin. The dev server proxies the API to a
// den-edge — the homelab's by default, DEN_EDGE for another.
const edge = process.env.DEN_EDGE ?? 'http://192.168.86.193:8094';
const api = ['/pair', '/inbox', '/lib', '/config', '/health', '/routes', '/scout'];
// atlas sits beside den-edge on the tailnet origin at /atlas; tailscale serve strips the prefix, so this does too.
const atlas = process.env.DEN_ATLAS ?? 'http://192.168.86.193:8081';
// reel the same way, for the billboard's trailers: its JSON is asked under this origin, its MP4s straight from it.
const reel = process.env.DEN_REEL ?? 'http://192.168.86.193:8092';

export default defineConfig({
  plugins: [svelte({ compilerOptions: { experimental: { async: true } } })],
  server: {
    // Pairing and the library's keys need WebCrypto, which a browser gives only to a secure context: a plain
    // http LAN address has no `crypto.subtle` at all. `tailscale serve --bg --https=8443 http://127.0.0.1:5173`
    // puts this server behind the tailnet's own certificate, and the dev server has to answer to that name.
    allowedHosts: ['.ts.net', 'localhost'],
    proxy: {
      ...Object.fromEntries(api.map((path) => [path, { target: edge, changeOrigin: true }])),
      '/atlas': { target: atlas, changeOrigin: true, rewrite: (path) => path.replace(/^\/atlas/, '') },
      '/reel': { target: reel, changeOrigin: true, rewrite: (path) => path.replace(/^\/reel/, '') },
    },
  },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
});
