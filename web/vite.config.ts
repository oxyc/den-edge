import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { previewBuild } from './scripts/previewBuild.ts';
import { probe } from './scripts/probe.ts';

// In production den-edge serves the app and its API from one origin. The dev server proxies the API to a
// den-edge — the homelab's by default, DEN_EDGE for another.
const edge = process.env.DEN_EDGE ?? 'http://192.168.86.193:8094';
// `/tmdb` is den-edge lending its TMDB key to a browser that has none, so it has to be proxied too — without
// it this server answers the app's own index.html to a request for a title and nothing is ever named here.
// `/metadata` names the titles atlas lists without a poster; without it every atlas row is empty here.
const api = [
  '/pair',
  '/inbox',
  '/lib',
  '/recovery',
  '/config',
  '/health',
  '/routes',
  '/scout',
  '/tmdb',
  '/metadata',
];
// atlas sits beside den-edge on the tailnet origin at /atlas; tailscale serve strips the prefix, so this does too.
const atlas = process.env.DEN_ATLAS ?? 'http://192.168.86.193:8081';
// reel the same way, for the billboard's trailers: its JSON is asked under this origin, its MP4s straight from it.
const reel = process.env.DEN_REEL ?? 'http://192.168.86.193:8092';
// den-remux, for the player and for test/remux.html. Unlike atlas and reel this keeps the prefix: den-remux's own
// routes are under /remux, which is why tailscale serve sends /remux to :8095/remux rather than stripping it. A
// rewrite here would ask it for /session, which it does not serve.
const remux = process.env.DEN_REMUX ?? 'http://192.168.86.193:8095';
// The probe is an instrument, not part of the app: it injects a beacon into every page this server hands
// out. Left on unconditionally it reaches the e2e suite too, where `POST /__probe` reads as an unmocked
// request and fails every spec that guards the network. On for a session someone is watching from a
// phone — `env DEN_PROBE=1 npm run dev -- --host` — and off the rest of the time.
const watching = process.env.DEN_PROBE === '1';

/**
 * Keep the full application graph on the wire beside the tiny entry without evaluating it. The entry can then
 * give a retained parser-time hero one paint without adding a request chain for guests or other routes.
 */
const preloadApplication = () => ({
  name: 'den-preload-application',
  enforce: 'post' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, context: { bundle?: Record<string, unknown> }) {
      const outputs = Object.values(context.bundle ?? {});
      const chunks = outputs.filter(
        (
          output,
        ): output is {
          type: 'chunk';
          fileName: string;
          facadeModuleId: string | null;
          imports: string[];
          viteMetadata?: { importedCss?: Set<string> };
        } =>
          typeof output === 'object' &&
          output !== null &&
          'type' in output &&
          output.type === 'chunk',
      );
      const application = chunks.find((chunk) => chunk.facadeModuleId?.endsWith('/src/appMain.ts'));
      if (!application) return html;
      const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const scripts = new Set<string>();
      const styles = new Set<string>();
      const visit = (chunk: (typeof chunks)[number]) => {
        if (scripts.has(chunk.fileName)) return;
        scripts.add(chunk.fileName);
        for (const file of chunk.viteMetadata?.importedCss ?? []) styles.add(file);
        for (const file of chunk.imports) {
          const imported = byFile.get(file);
          if (imported) visit(imported);
        }
      };
      visit(application);
      const absentFromHtml = (file: string) =>
        !html.includes(`href="/${file}"`) && !html.includes(`src="/${file}"`);
      return {
        html,
        tags: [
          ...[...scripts].filter(absentFromHtml).map((file) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: '', href: `/${file}` },
            injectTo: 'head' as const,
          })),
          ...[...styles].filter(absentFromHtml).map((file) => ({
            tag: 'link',
            attrs: { rel: 'stylesheet', crossorigin: '', href: `/${file}` },
            injectTo: 'head' as const,
          })),
        ],
      };
    },
  },
});

export default defineConfig({
  plugins: [previewBuild(), ...(watching ? [probe()] : []), svelte(), preloadApplication()],
  server: {
    // Pairing and the library's keys need WebCrypto, which a browser gives only to a secure context: a plain
    // http LAN address has no `crypto.subtle` at all. `tailscale serve --bg --https=8443 http://127.0.0.1:5173`
    // puts this server behind the tailnet's own certificate, and the dev server has to answer to that name.
    allowedHosts: ['.ts.net', 'localhost'],
    proxy: {
      ...Object.fromEntries(api.map((path) => [path, { target: edge, changeOrigin: true }])),
      '/atlas': {
        target: atlas,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/atlas/, ''),
      },
      '/reel': { target: reel, changeOrigin: true, rewrite: (path) => path.replace(/^\/reel/, '') },
      '/remux': { target: remux, changeOrigin: true },
    },
  },
  // Keep route styles beside their already-split route chunks. Settings, Player and other uncommon screens are
  // intent-loaded, so Home should not transfer or parse their CSS either.
  build: { target: 'es2022', cssCodeSplit: true },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['test/setup-sync.ts'],
  },
});
