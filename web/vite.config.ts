import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// In production den-edge serves the app and its API from one origin. The dev server proxies the API to a
// den-edge — the homelab's by default, DEN_EDGE for another.
const edge = process.env.DEN_EDGE ?? 'http://192.168.86.193:8094';
const api = ['/link', '/inbox', '/sync', '/lib', '/plugins', '/settings', '/config', '/health'];
// atlas sits beside den-edge on the tailnet origin at /atlas; tailscale serve strips the prefix, so this does too.
const atlas = process.env.DEN_ATLAS ?? 'http://192.168.86.193:8081';

export default defineConfig({
  plugins: [svelte({ compilerOptions: { experimental: { async: true } } })],
  server: {
    proxy: {
      ...Object.fromEntries(api.map((path) => [path, { target: edge, changeOrigin: true }])),
      '/atlas': { target: atlas, changeOrigin: true, rewrite: (path) => path.replace(/^\/atlas/, '') },
    },
  },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
});
