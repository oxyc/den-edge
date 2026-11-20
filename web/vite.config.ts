import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin, ProxyOptions, ViteDevServer } from 'vite';
import { previewBuild } from './scripts/previewBuild.ts';
import { probe } from './scripts/probe.ts';
import { stripEdgeAuthority, upstream } from './scripts/upstream.ts';
import { localizeMarkup } from './scripts/localize-markup.ts';
import { libraryModules } from './scripts/libraryModules.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourcePhrases as spanishPhrases } from './src/lib/messages/phrases/es.ts';
import { sourcePhrases as swedishPhrases } from './src/lib/messages/phrases/sv.ts';

// The TV builds merge this config and keep the automatic split: grouped, their app never got past "Starting Den…".
const grouped = libraryModules(
  fileURLToPath(new URL('./src', import.meta.url)),
  Boolean(process.env.DEN_TV_PLATFORM),
);

const phraseKey = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** Compile translator-friendly English-keyed sources to compact runtime maps before any app code is bundled. */
const compiledPhrases = (): Plugin => {
  const catalogs = new Map([
    ['\0den-phrases-es', spanishPhrases],
    ['\0den-phrases-sv', swedishPhrases],
  ]);
  return {
    name: 'den-compiled-phrase-catalogs',
    resolveId(id) {
      const resolved = `\0${id}`;
      return catalogs.has(resolved) ? resolved : undefined;
    },
    load(id) {
      const source = catalogs.get(id);
      if (!source) return undefined;
      const compact = Object.fromEntries(
        Object.entries(source).map(([english, translation]) => [phraseKey(english), translation]),
      );
      return `export const phrases=${JSON.stringify(compact)}`;
    },
  };
};

const translationRevision = createHash('sha256');
for (const file of [
  'es.ts',
  'sv.ts',
  'phrases/es.ts',
  'phrases/sv.ts',
  'parameters/es.ts',
  'parameters/sv.ts',
])
  translationRevision.update(
    readFileSync(fileURLToPath(new URL(`./src/lib/messages/${file}`, import.meta.url))),
  );
const translationsRevision = translationRevision.digest('hex').slice(0, 16);

// In production den-edge serves the app and its API from one origin. Ordinary UI development uses that public
// stack too, so a contributor signed in as a guest exercises the real guest authority and Hearth integrations.
// The root launcher selects loopback explicitly for backend work. Under e2e (`DEN_E2E=1`) this is always dead local.
const edge = upstream('DEN_EDGE', 'https://d.oxy.fi');
// The public default must retain its Web face when Vite connects to it. An explicit Edge is normally a standalone
// local listener; DEN_EDGE_HOST remains available for a shared raw listener with several faces.
const edgeHost =
  process.env.DEN_EDGE_HOST ??
  (!process.env.DEN_EDGE && process.env.DEN_E2E !== '1' ? 'd.oxy.fi' : undefined);
const edgeProxy: ProxyOptions = {
  target: edge,
  changeOrigin: true,
  ...(edgeHost
    ? {
        // node-http-proxy applies changeOrigin after static headers. Set Host on the final outbound request.
        configure(proxy) {
          proxy.on('proxyReq', (request) => request.setHeader('host', edgeHost));
        },
      }
    : {}),
};
// `/tmdb` is den-edge lending its TMDB key to a browser that has none, so it has to be proxied too — without
// it this server answers the app's own index.html to a request for a title and nothing is ever named here.
// `/metadata` names the titles atlas lists without a poster; without it every atlas row is empty here.
const api = [
  '/pair',
  '/inbox',
  '/lib',
  '/recovery',
  '/config',
  '/capabilities',
  '/health',
  '/routes',
  '/scout',
  '/tmdb',
  '/metadata',
  '/assistant',
  '/performance',
  // Runtime routes the installed web app receives from den-edge too. Keeping them same-origin in development lets a
  // local HTTPS page use the real library's Hearth config, playback and account integrations without CORS or a
  // second local configuration. The TV config inherits this same proxy table.
  '/grant',
  '/oauth',
  '/playback',
  '/diagnostics',
  // Reel's carried-source control plane belongs to Edge. Keep these more-specific entries before the raw `/reel`
  // media proxy below; otherwise local development strips the prefix and asks Reel itself for POST `/transport`,
  // which correctly answers 405 and forces every carried source onto its relay fallback.
  '/reel/transport',
  '/reel/activate',
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
];
// The default is Edge's bounded public Atlas relay, which keeps /atlas. An explicit DEN_ATLAS names a standalone
// Atlas service, whose listener does not have that prefix. E2E replaces either default with a dead loopback port.
const atlasDirect = process.env.DEN_ATLAS !== undefined;
const atlas = upstream('DEN_ATLAS', 'https://d.oxy.fi');
// Reel also defaults to Edge's public relay. A standalone DEN_REEL listener receives the prefix-stripped path.
const reelDirect = process.env.DEN_REEL !== undefined;
const reel = upstream('DEN_REEL', 'https://d.oxy.fi');
// den-remux, for the player and for test/remux.html. Unlike atlas and reel this keeps the prefix: den-remux's own
// routes are under /remux, which is why tailscale serve sends /remux to :8095/remux rather than stripping it. A
// rewrite here would ask it for /session, which it does not serve.
const remux = upstream('DEN_REMUX', 'https://d.oxy.fi');
// A service proxy carries the browser's Edge credentials only to the Edge that issued them: the public stack's own
// relay while Edge is the default. A standalone service, or the public relay while `DEN_EDGE` names another Edge,
// gets the request without them.
function withoutEdgeAuthority(direct: boolean): Pick<ProxyOptions, 'configure'> {
  return direct || process.env.DEN_EDGE !== undefined
    ? { configure: (proxy) => proxy.on('proxyReq', stripEdgeAuthority) }
    : {};
}
// The probe is an instrument, not part of the app: it injects a beacon into every page this server hands
// out. Left on unconditionally it reaches the e2e suite too, where `POST /__probe` reads as an unmocked
// request and fails every spec that guards the network. On for a session someone is watching from a
// phone — `env DEN_PROBE=1 npm run dev -- --host` — and off the rest of the time.
const watching = process.env.DEN_PROBE === '1';
const profilesPreview = process.env.DEN_PROFILES_PREVIEW === '1';

/** A local-only capability answer. Production serves the endpoint in Rust and remains default-off. */
const previewProfiles = (): Plugin => ({
  name: 'den-preview-profiles',
  configureServer(server: ViteDevServer) {
    if (!profilesPreview) return;
    server.middlewares.use(
      '/capabilities/profiles',
      (
        request: { method?: string },
        response: {
          statusCode: number;
          setHeader: (name: string, value: string) => void;
          end: (body: string) => void;
        },
        next: () => void,
      ) => {
        if (request.method !== 'GET') return next();
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({ enabled: true, preview: true }));
      },
    );
  },
});

/**
 * Keep the full application graph on the wire beside the tiny entry without evaluating it. The entry can then
 * give a retained parser-time hero one paint without adding a request chain for guests or other routes.
 */
const preloadApplication = () => ({
  name: 'den-preload-application',
  enforce: 'post' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, context: { path?: string; bundle?: Record<string, unknown> }) {
      if (context.path !== '/index.html') return html;
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
      const assetPrefix = process.env.DEN_TV_PACKAGED === '1' ? './' : '/';
      const absentFromHtml = (file: string) =>
        !html.includes(`href="${assetPrefix}${file}"`) &&
        !html.includes(`src="${assetPrefix}${file}"`);
      return {
        html,
        tags: [
          ...[...scripts].filter(absentFromHtml).map((file) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: '', href: `${assetPrefix}${file}` },
            injectTo: 'head' as const,
          })),
          ...[...styles].filter(absentFromHtml).map((file) => ({
            tag: 'link',
            attrs: { rel: 'stylesheet', crossorigin: '', href: `${assetPrefix}${file}` },
            injectTo: 'head' as const,
          })),
        ],
      };
    },
  },
});

/**
 * What only the library reaches loads as one chunk, and what it shares with the first paint as another
 * (`scripts/libraryModules.ts`). The client build only: grouped in the server-rendered shell's build, a module of the
 * group ran before the one it extends (`SvelteMap is not a constructor`), so group chunks are not free of ordering
 * hazards and stay where the end-to-end runs see them.
 */
const libraryChunks = (): Plugin => ({
  name: 'den-library-chunks',
  config(_config, { isSsrBuild }) {
    if (isSsrBuild) return;
    return {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: (['library', 'startup'] as const).map((which) => ({
                name: which === 'library' ? 'routed-library' : 'startup-shared',
                // Their dependencies are in the other graph or the same one, and stay where they are.
                includeDependenciesRecursively: false,
                test: (id: string) => grouped[which].has(id.split('?')[0]!.replaceAll('\\', '/')),
              })),
            },
          },
        },
      },
    };
  },
});

export default defineConfig({
  define: {
    __DEN_TV__: 'false',
    __DEN_TV_PLATFORM__: JSON.stringify('browser'),
    __DEN_TV_PACKAGED__: 'false',
    __DEN_TV_LEGACY_JS_CORE__: 'false',
    __DEN_MANAGED_PLAYBACK_RECEIPTS__: 'true',
    __DEN_TV_API_ORIGIN__: JSON.stringify(''),
    __DEN_TV_SERVICE_ORIGIN__: JSON.stringify(''),
    __DEN_TV_WEB_ORIGIN__: JSON.stringify(''),
    __DEN_TRANSLATIONS_REVISION__: JSON.stringify(translationsRevision),
    // A routed e2e build leaves the SharedWorker out: Playwright's routes never see its requests. One whose preview
    // proxies them to the spec's bridge (`DEN_E2E_SHARED_WORKER=1`, e2e/shared-worker-bridge.mjs) keeps it, as shipped.
    'import.meta.env.DEN_E2E': JSON.stringify(
      process.env.DEN_E2E === '1' && process.env.DEN_E2E_SHARED_WORKER !== '1',
    ),
    // Only the routed multi-entry production build has the stable explicit projection entry. The ordinary E2E dev
    // server must keep Vite's ?worker constructor so it can compile and serve that Worker on demand.
    'import.meta.env.DEN_E2E_PROJECTION_ENTRY': JSON.stringify(
      process.env.DEN_E2E === '1' && process.env.DEN_E2E_SEED === '1',
    ),
    'import.meta.env.DEN_ALLOCATION_AUDIT': JSON.stringify(
      process.env.DEN_ALLOCATION_AUDIT === '1',
    ),
  },
  plugins: [
    {
      name: 'den-browser-platform-isolation',
      // Inspect every output chunk, not just the initial entry. An accidentally lazy TV import still leaks.
      generateBundle(_options, bundle) {
        if (process.env.DEN_TV_PLATFORM) return;
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue;
          const leaked = output.moduleIds.find((id) =>
            /\/src\/tv\/|\/src\/vendor\/den-core-tv\/|\/src\/lib\/runtimeUrl\.ts$|\/node_modules\/core-js\//.test(
              id,
            ),
          );
          if (leaked) this.error(`TV-only module leaked into browser build: ${leaked}`);
        }
      },
    },
    previewProfiles(),
    previewBuild(),
    ...(watching ? [probe()] : []),
    compiledPhrases(),
    svelte({ preprocess: localizeMarkup() }),
    preloadApplication(),
    libraryChunks(),
  ],
  server: {
    // Pairing and the library's keys need WebCrypto, which a browser gives only to a secure context: a plain
    // http LAN address has no `crypto.subtle` at all. `tailscale serve --bg --https=8443 http://127.0.0.1:5173`
    // puts this server behind the tailnet's own certificate, and the dev server has to answer to that name.
    allowedHosts: ['.ts.net', 'localhost'],
    proxy: {
      ...Object.fromEntries(api.map((path) => [path, edgeProxy])),
      '/atlas': {
        target: atlas,
        changeOrigin: true,
        rewrite: (path) => (atlasDirect ? path.replace(/^\/atlas/, '') : path),
        ...withoutEdgeAuthority(atlasDirect),
      },
      '/reel': {
        target: reel,
        changeOrigin: true,
        rewrite: (path) => (reelDirect ? path.replace(/^\/reel/, '') : path),
        ...withoutEdgeAuthority(reelDirect),
      },
      '/remux': {
        target: remux,
        changeOrigin: true,
        ...withoutEdgeAuthority(process.env.DEN_REMUX !== undefined),
      },
    },
  },
  // Keep route styles beside their already-split route chunks. Settings, Player and other uncommon screens are
  // intent-loaded, so Home should not transfer or parse their CSS either.
  build: {
    sourcemap: process.env.DEN_ALLOCATION_AUDIT === '1',
    target: 'es2022',
    cssCodeSplit: true,
    // The production build the time budgets run against (`playwright.budgets.config.ts`) also carries the page that
    // seeds their household with the app's own code (`test/seed-library.html`). Never in a release build.
    rolldownOptions: {
      ...(process.env.DEN_E2E_SEED === '1'
        ? {
            // Rolldown may retain the nested library Worker's generated URL while dropping its asset from a
            // multi-entry build. An explicit, stable test-only entry keeps the production-path Worker executable.
            input: {
              index: 'index.html',
              seed: 'test/seed-library.html',
              assistantProjectionWorker: 'src/lib/assistantProjectionWorker.ts',
            },
          }
        : {}),
      ...(process.env.DEN_E2E_SEED === '1'
        ? {
            output: {
              entryFileNames: (chunk: { name: string }) =>
                chunk.name === 'assistantProjectionWorker'
                  ? 'assets/assistantProjectionWorker.js'
                  : chunk.name === 'shell'
                    ? 'shell.js'
                    : 'assets/[name]-[hash].js',
            },
          }
        : {}),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'cast/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['test/setup-sync.ts'],
  },
});
