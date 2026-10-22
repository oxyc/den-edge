import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import browser from './vite.config.ts';
import { getTizenVersion, tvCsp } from './scripts/tv-csp.mjs';

const platform = process.env.DEN_TV_PLATFORM ?? 'webos';
if (platform !== 'webos' && platform !== 'tizen') throw new Error('Unknown DEN_TV_PLATFORM');
const standardCompat = fileURLToPath(new URL('./src/tv/compat.ts', import.meta.url));
const legacyCompat = fileURLToPath(new URL('./src/tv/compat-legacy.ts', import.meta.url));
const packagedRuntime = fileURLToPath(new URL('./src/tv/packaged.ts', import.meta.url));
const tvCore = fileURLToPath(new URL('./src/vendor/den-core-tv', import.meta.url));
const e2e = process.env.DEN_TV_E2E === '1';
const packaged = process.env.DEN_TV_PACKAGED === '1';
const tizenVersion = getTizenVersion(process.env.DEN_TIZEN_VERSION);
const legacyTizen = platform === 'tizen' && tizenVersion === '5.5';
const compat = legacyTizen ? legacyCompat : standardCompat;
const tvCspValue = tvCsp(tizenVersion);
const apiOriginText = process.env.DEN_TV_API_ORIGIN;
if (packaged && !apiOriginText)
  throw new Error('DEN_TV_API_ORIGIN is required for packaged TV builds');
let apiOrigin = '';
if (apiOriginText) {
  let parsed: URL;
  try {
    parsed = new URL(apiOriginText);
  } catch {
    throw new Error('DEN_TV_API_ORIGIN must be a valid URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    parsed.search
  )
    throw new Error(
      'DEN_TV_API_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment',
    );
  apiOrigin = parsed.origin;
}
const serviceOriginText = process.env.DEN_TV_SERVICE_ORIGIN;
let serviceOrigin = apiOrigin;
if (serviceOriginText) {
  let parsed: URL;
  try {
    parsed = new URL(serviceOriginText);
  } catch {
    throw new Error('DEN_TV_SERVICE_ORIGIN must be a valid URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    parsed.search
  )
    throw new Error(
      'DEN_TV_SERVICE_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment',
    );
  serviceOrigin = parsed.origin;
}
if (packaged && platform !== 'tizen')
  throw new Error('DEN_TV_PACKAGED=1 is only supported for Tizen');
const outDir =
  process.env.DEN_TV_OUT_DIR ?? (packaged ? 'dist-tv-tizen-package' : `dist-tv-${platform}`);
if (!/^dist-tv-(?:webos|tizen)(?:-package)?(?:-e2e-\d+)?$/.test(outDir))
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
      if (legacyTizen && /\/src\/tv\/main\.ts$/.test(id)) {
        const ordinary = "import './compat';";
        if (!code.includes(ordinary))
          throw new Error('Tizen 5.5 compatibility entry no longer matches TV main');
        return { code: code.replace(ordinary, "import './compat-legacy';"), map: null };
      }
      if (/\/src\/lib\/syncPolicyModule\.ts$/.test(id)) {
        const original = '../vendor/den-core/generated/den_core_bg.wasm';
        if (!code.includes(original))
          throw new Error('TV den-core URL seam no longer matches syncPolicyModule');
        return {
          code: code.replace(original, '../vendor/den-core-tv/generated/den_core_bg.wasm'),
          map: null,
        };
      }
      if (/\/src\/lib\/(?:recoveryCore|recoveryWorker)\.ts$/.test(id)) {
        const original = '../vendor/den-core/recovery.js';
        if (!code.includes(original))
          throw new Error('TV recovery core seam no longer matches its loader');
        code = code.replace(original, '../vendor/den-core-tv/recovery.js');
      }
      if (/\/src\/lib\/(?:libraryServiceWorker|libraryWorker|recoveryWorker)\.ts$/.test(id))
        return {
          code: `import ${JSON.stringify(compat)};\nimport ${JSON.stringify(packagedRuntime)};\n${code}`,
          map: null,
        };
    },
  };
}

// Chromium 69 (Tizen 5.5) predates module Workers. Vite emits each owned Worker entry as an IIFE, but normalizes
// its constructor to `{ type: "module" }` after source transforms have run. Lower that generated option at the
// output boundary, in the page and nested Worker builds, while retaining the useful startup Worker name.
function legacyWorkerOutput(): Plugin {
  return {
    name: 'den-tv-legacy-worker-output',
    generateBundle(_options, bundle) {
      if (!legacyTizen) return;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        output.code = output.code
          .replace(/\{type:`module`\}/g, '{}')
          .replace(/\{type:`module`,name:/g, '{name:');
        if (/type:[`'"]module[`'"]/.test(output.code))
          this.error(`Tizen 5.5 output still contains a module Worker option: ${output.fileName}`);
      }
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
          return html
            .replace(
              '<head>',
              `<head>${packaged ? `<meta http-equiv="Content-Security-Policy" content="${tvCspValue}">` : ''}`,
            )
            .replace('/test/player.ts', '/src/tv/test-entry.ts');
        return html;
      }
      return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${packaged ? `<meta http-equiv="Content-Security-Policy" content="${tvCspValue}">` : ''}
<meta name="viewport" content="width=1920, initial-scale=1"><meta name="theme-color" content="#0b0b0f">
<title>Den TV</title></head><body><div id="app"><p>Starting Den…</p></div>
<script type="module" src="/src/tv/main.ts"></script></body></html>`;
    },
  },
};

const packagedMetadata: Plugin = {
  name: 'den-tv-packaged-metadata',
  generateBundle() {
    if (packaged)
      this.emitFile({
        type: 'asset',
        fileName: 'den-tv-package.json',
        source: JSON.stringify(
          { packaged: true, platform, apiOrigin, serviceOrigin, tizenVersion, e2e },
          null,
          2,
        ),
      });
  },
};

// Svelte 5 keeps a component's descendant selectors at their authored specificity by putting the repeated scope
// class in :where(). Chrome 87 predates :where() and drops each complete rule that contains it. The TV build targets
// those engines, so lower only Svelte's generated, single-class form; never unwrap an authored selector or remove
// the scope class. Old Svelte output repeated this class directly too. There is no zero-specificity equivalent in
// these engines, so descendant rules gain that one generated class while retaining their component isolation.
const legacyScopedCss = {
  postcssPlugin: 'den-tv-legacy-scoped-css',
  Once(root: { walkRules: (visit: (rule: { selector: string }) => void) => void }) {
    root.walkRules((rule) => {
      rule.selector = rule.selector.replace(/:where\((\.svelte-[a-z0-9]+)\)/g, '$1');
      if (rule.selector.includes(':where('))
        throw new Error(
          `TV CSS contains an unsupported non-Svelte :where() selector: ${rule.selector}`,
        );
    });
  },
};

const samsungBridge: Plugin = {
  name: 'den-tv-samsung-bridge',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      if (!packaged) return html;
      // A platform-owned local script, not remote executable code. Keep it after the CSP meta and before
      // the app module; ordinary browser and hosted preview builds do not request Samsung device files.
      return html.replace(
        /(?=<script type="module")/,
        '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>\n',
      );
    },
  },
};

const https =
  process.env.DEN_TLS_CERT && process.env.DEN_TLS_KEY
    ? { cert: readFileSync(process.env.DEN_TLS_CERT), key: readFileSync(process.env.DEN_TLS_KEY) }
    : undefined;
const tvProxy = browser.server?.proxy;

export default mergeConfig(
  browser,
  defineConfig({
    base: packaged ? './' : '/',
    define: {
      __DEN_TV__: 'true',
      __DEN_TV_PLATFORM__: JSON.stringify(platform),
      __DEN_TV_PACKAGED__: packaged ? 'true' : 'false',
      __DEN_TV_API_ORIGIN__: JSON.stringify(apiOrigin),
      __DEN_TV_SERVICE_ORIGIN__: JSON.stringify(serviceOrigin),
    },
    // The TV artifact is built without Wasm reference types for one-table engines such as Chromium 87. Keep the
    // browser's vendored den-core untouched; this config and its Worker builds alone resolve the JS entry points
    // to wrappers with byte-identical APIs beside the compatible generated modules.
    resolve: {
      alias: [
        {
          find: /^(?:.*\/)?vendor\/den-core\/(index|assistant|recovery)\.js$/,
          replacement: `${tvCore}/$1.js`,
        },
      ],
    },
    plugins: [
      tvEntry,
      workerCompatibility(),
      legacyWorkerOutput(),
      packagedMetadata,
      samsungBridge,
    ],
    worker: { plugins: () => [workerCompatibility(), legacyWorkerOutput(), svelte()] },
    css: { postcss: { plugins: [legacyScopedCss] } },
    build: {
      target: legacyTizen ? 'chrome69' : 'chrome85',
      cssTarget: legacyTizen ? 'chrome69' : 'chrome85',
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
