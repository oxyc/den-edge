import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import legacy from '@vitejs/plugin-legacy';
import { transformAsync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import postcssCustomProperties from 'postcss-custom-properties';
import postcssGlobalData from '@csstools/postcss-global-data';
import postcssLogical from 'postcss-logical';
import { Features as LightningCssFeatures } from 'lightningcss';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import browser from './vite.config.ts';
import { getTizenVersion, tvCsp } from './scripts/tv-csp.mjs';
import { bootBodyStyle, bootSplash } from './scripts/tv-boot-splash.mjs';
import {
  tizen3FixedViewportMath,
  tizen3FocusSelectors,
  tizen3ScrollLogical,
  tizen3UnsupportedEnhancements,
  tizen3ViewerEffects,
} from './scripts/tizen3-css-compat.ts';

const platform = process.env.DEN_TV_PLATFORM ?? 'webos';
if (platform !== 'webos' && platform !== 'tizen') throw new Error('Unknown DEN_TV_PLATFORM');
const standardCompat = fileURLToPath(new URL('./src/tv/compat.ts', import.meta.url));
const legacyCompat = fileURLToPath(new URL('./src/tv/compat-legacy.ts', import.meta.url));
const tizen3WorkerCompat = fileURLToPath(
  new URL('./src/tv/compat-tizen3-worker.ts', import.meta.url),
);
const tizen3PairCurve = fileURLToPath(new URL('./src/lib/pairCurve-tizen3.ts', import.meta.url));
const tizen3Core = fileURLToPath(new URL('./src/vendor/den-core-tizen3/index.js', import.meta.url));
const tizen3SyncLoader = fileURLToPath(new URL('./src/lib/syncLoader-tizen3.ts', import.meta.url));
const tizen3SyncEvaluator = fileURLToPath(
  new URL('./src/lib/syncEvaluator-tizen3.ts', import.meta.url),
);
const tizen3SyncLifecycle = fileURLToPath(
  new URL('./src/lib/syncLifecycle-tizen3.ts', import.meta.url),
);
const tizen3HlsLoader = fileURLToPath(new URL('./src/lib/hlsLoader-tizen3.ts', import.meta.url));
const tizen3UnsupportedMediaEngine = fileURLToPath(
  new URL('./src/lib/unsupportedMediaEngine-tizen3.ts', import.meta.url),
);
const tizen3SyncPolicyModule = fileURLToPath(
  new URL('./src/lib/syncPolicyModule-tizen3.ts', import.meta.url),
);
const tizen3AssistantCore = fileURLToPath(
  new URL('./src/lib/assistantCore-tizen3.ts', import.meta.url),
);
const tizen3RecoveryCore = fileURLToPath(
  new URL('./src/lib/recoveryCore-tizen3.ts', import.meta.url),
);
const appCss = fileURLToPath(new URL('./src/app.css', import.meta.url));
const tvCss = fileURLToPath(new URL('./src/tv/tv.css', import.meta.url));
const packagedRuntime = fileURLToPath(new URL('./src/tv/packaged.ts', import.meta.url));
const oldEngineLimitsRuntime = fileURLToPath(
  new URL('./src/tv/old-engine-limits.ts', import.meta.url),
);
const tvCore = fileURLToPath(new URL('./src/vendor/den-core-tv', import.meta.url));
const e2e = process.env.DEN_TV_E2E === '1';
const packaged = process.env.DEN_TV_PACKAGED === '1';
const tizenVersion = getTizenVersion(process.env.DEN_TIZEN_VERSION);
const tizen3 = platform === 'tizen' && tizenVersion === '3.0';
const enforceOldEngineLimits = process.env.DEN_TV_OLD_ENGINE_LIMITS === '1';
if (enforceOldEngineLimits && (!tizen3 || !e2e))
  throw new Error('DEN_TV_OLD_ENGINE_LIMITS is only valid for a Tizen 3 E2E build');
const legacyTizen = platform === 'tizen' && (tizen3 || tizenVersion === '5.5');
const workerCompat = tizen3 ? tizen3WorkerCompat : legacyTizen ? legacyCompat : standardCompat;
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
// Links a phone opens must name the web app, which the device API and the TV's own host do not serve.
let webOrigin = serviceOrigin;
if (process.env.DEN_TV_WEB_ORIGIN) {
  const parsed = new URL(process.env.DEN_TV_WEB_ORIGIN);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('DEN_TV_WEB_ORIGIN must be an exact HTTPS origin');
  webOrigin = parsed.origin;
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
      const oldLimits = enforceOldEngineLimits
        ? `import ${JSON.stringify(oldEngineLimitsRuntime)};\n`
        : '';
      if (legacyTizen && /\/src\/tv\/main\.ts$/.test(id)) {
        const ordinary = "import './compat';";
        if (!code.includes(ordinary))
          throw new Error('Tizen 5.5 compatibility entry no longer matches TV main');
        const replacement = tizen3 ? "import './compat-tizen3';" : "import './compat-legacy';";
        return { code: oldLimits + code.replace(ordinary, replacement), map: null };
      }
      if (/\/src\/lib\/syncPolicyModule\.ts$/.test(id)) {
        const modules = ['den_core_startup', 'den_core_deferred'];
        if (
          modules.some((module) => !code.includes(`../vendor/den-core/generated/${module}_bg.wasm`))
        )
          throw new Error('TV den-core lifecycle URL seams no longer match syncPolicyModule');
        return {
          code: modules.reduce(
            (rewritten, module) =>
              rewritten.replace(
                `../vendor/den-core/generated/${module}_bg.wasm`,
                `../vendor/den-core-tv/generated/${module}_bg.wasm`,
              ),
            code,
          ),
          map: null,
        };
      }
      if (/\/src\/lib\/(?:recoveryCore|recoveryWorker)\.ts$/.test(id)) {
        const original = '../vendor/den-core/recovery.js';
        if (!code.includes(original))
          throw new Error('TV recovery core seam no longer matches its loader');
        code = code.replace(original, '../vendor/den-core-tv/recovery.js');
      }
      if (
        /\/src\/(?:lib\/(?:assistantProjectionWorker|libraryServiceWorker|libraryWorker|recoveryWorker)|tv\/diagnosticWorker)\.ts$/.test(
          id,
        )
      )
        return {
          code: `${oldLimits}import ${JSON.stringify(workerCompat)};\nimport ${JSON.stringify(packagedRuntime)};\n${code}`,
          map: null,
        };
    },
  };
}

// Chromium 47 (Tizen 3) and Chromium 69 (Tizen 5.5) predate module Workers. Vite emits each owned Worker entry as an IIFE, but normalizes
// its constructor to `{ type: "module" }` after source transforms have run. Lower that generated option at the
// output boundary, in the page and nested Worker builds, while retaining the useful startup Worker name.
function legacyWorkerOutput(workerBundle = false): Plugin {
  return {
    name: `den-tv-legacy-worker-output${workerBundle ? '-bundle' : ''}`,
    async generateBundle(_options, bundle) {
      if (!legacyTizen) return;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        output.code = output.code
          .replace(/\{type:`module`\}/g, '{}')
          .replace(/\{type:`module`,name:/g, '{name:');
        if (/type:[`'"]module[`'"]/.test(output.code))
          this.error(
            `Legacy Tizen output still contains a module Worker option: ${output.fileName}`,
          );
        if (tizen3 && workerBundle)
          output.code = (await lowerTizen3Syntax(output.code, output.fileName, true)).code;
      }
    },
  };
}

// Vite 8's legacy plugin converts Rolldown output to SystemJS before Babel lowers syntax. Several
// Babel 7.29 transforms depend on the original module scopes and ordering for Den's larger chunks.
// Lower syntax first while those scopes are intact; plugin-legacy still owns SystemJS conversion,
// its loader, and polyfill selection.
async function lowerTizen3Syntax(code: string, fileName: string, compact = false) {
  // Lower classes/spread/iteration before async functions. Babel's combined pass can otherwise
  // hand regenerator syntax it does not understand inside generated Rolldown expressions.
  const structuralResult = await transformAsync(code, {
    babelrc: false,
    configFile: false,
    filename: fileName,
    sourceMaps: !compact,
    compact,
    minified: compact,
    presets: [
      [
        presetEnv,
        {
          // Force every expression form that regenerator does not understand through this
          // structural pass. The final output still targets Chromium 47, not IE.
          targets: { ie: '11' },
          bugfixes: true,
          modules: false,
          exclude: [
            '@babel/plugin-transform-async-generator-functions',
            '@babel/plugin-transform-async-to-generator',
            '@babel/plugin-transform-regenerator',
          ],
        },
      ],
    ],
  });
  const result = await transformAsync(structuralResult?.code ?? code, {
    babelrc: false,
    configFile: false,
    filename: fileName,
    sourceMaps: !compact,
    compact,
    minified: compact,
    inputSourceMap: compact ? undefined : (structuralResult?.map ?? undefined),
    presets: [[presetEnv, { targets: { chrome: '47' }, bugfixes: true, modules: false }]],
  });
  if (!result?.code) throw new Error(`Babel produced no Tizen 3 output for ${fileName}`);
  return { code: result.code, map: result.map ?? null };
}

function tizen3SyntaxCompatibility(): Plugin {
  return {
    name: 'den:tizen3-syntax-compatibility',
    async renderChunk(code, chunk) {
      if (!tizen3 || !chunk.fileName.includes('-legacy')) return null;
      return lowerTizen3Syntax(code, chunk.fileName);
    },
  };
}

function tizen3LegacyHtml(): Plugin {
  return {
    name: 'den:tizen3-legacy-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      if (!tizen3) return;
      const index = bundle['index.html'];
      if (index?.type !== 'asset' || typeof index.source !== 'string')
        this.error('Tizen 3 build is missing index.html');
      index.source = index.source.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');
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
      // The hosted page is a TV preview, not a responsive phone layout. iOS honors this numeric viewport and
      // scales the complete 1920px TV canvas into the device; desktop browsers already expose that same canvas.
      // Packages keep it too so every preview and real TV exercises one layout coordinate system.
      const viewport = 'width=1920, initial-scale=1';
      return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${packaged ? `<meta http-equiv="Content-Security-Policy" content="${tvCspValue}">` : ''}
<meta name="viewport" content="${viewport}"><meta name="theme-color" content="#0b0b0f">
<title>Den TV</title></head><body style="${bootBodyStyle}"><div id="app">${bootSplash('Starting Den…')}</div>
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
          {
            packaged: true,
            platform,
            apiOrigin,
            serviceOrigin,
            tizenVersion,
            legacyNonModule: tizen3,
            policyCore: tizen3 ? 'javascript' : 'wasm',
            e2e,
          },
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

// Run maintained CSS compatibility transforms before Svelte/Vite embeds component styles into the legacy chunks.
// Global Data makes fixed browser and TV tokens visible while each component stylesheet is processed, then removes
// the injected rules again. Fixed-viewport math is lowered only when it has an unambiguous numeric result; the
// packaged-output report keeps genuinely dynamic/scoped values visible instead of guessing at their behavior.
const tizen3CssPlugins = tizen3
  ? (() => {
      const globalData = postcssGlobalData({ files: [appCss, tvCss], lateRemover: true }).plugins;
      return [
        globalData[0],
        tizen3UnsupportedEnhancements(),
        tizen3ViewerEffects(),
        postcssCustomProperties({ preserve: false }),
        tizen3FixedViewportMath(),
        tizen3FocusSelectors(),
        tizen3ScrollLogical(),
        postcssLogical({ blockDirection: 'top-to-bottom', inlineDirection: 'left-to-right' }),
        globalData[1],
      ];
    })()
  : [];

const samsungBridge: Plugin = {
  name: 'den-tv-samsung-bridge',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      if (!packaged) return html;
      // A platform-owned local script, not remote executable code. Keep it after the CSP meta and before
      // the app module; ordinary browser and hosted preview builds do not request Samsung device files.
      return html.replace(
        /(?=<script(?:\s|>))|(?=<\/body>)/,
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
      __DEN_TV_LEGACY_JS_CORE__: tizen3 ? 'true' : 'false',
      __DEN_TV_API_ORIGIN__: JSON.stringify(apiOrigin),
      __DEN_TV_SERVICE_ORIGIN__: JSON.stringify(serviceOrigin),
      __DEN_TV_WEB_ORIGIN__: JSON.stringify(webOrigin),
    },
    // The TV artifact is built without Wasm reference types for one-table engines such as Chromium 87. Keep the
    // browser's vendored den-core untouched; this config and its Worker builds alone resolve the JS entry points
    // to wrappers with byte-identical APIs beside the compatible generated modules.
    resolve: {
      alias: [
        ...(tizen3
          ? [
              { find: /^hls\.js$/, replacement: tizen3UnsupportedMediaEngine },
              { find: './pairCurve', replacement: tizen3PairCurve },
              { find: './syncLoader', replacement: tizen3SyncLoader },
              { find: './syncEvaluator', replacement: tizen3SyncEvaluator },
              { find: './hlsLoader', replacement: tizen3HlsLoader },
              { find: './syncPolicyModule', replacement: tizen3SyncPolicyModule },
              { find: './assistantCore', replacement: tizen3AssistantCore },
              { find: './recoveryCore', replacement: tizen3RecoveryCore },
              {
                find: /^(?:.*\/)?vendor\/den-core\/index\.js$/,
                replacement: tizen3Core,
              },
              {
                find: /^(?:.*\/)?vendor\/den-core\/(?:startup|deferred)\.js$/,
                replacement: tizen3SyncLifecycle,
              },
            ]
          : []),
        {
          find: /^(?:.*\/)?vendor\/den-core\/(index|startup|deferred|assistant|recovery)\.js$/,
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
      tizen3SyntaxCompatibility(),
      ...(tizen3
        ? [
            legacy({
              targets: ['chrome 47'],
              renderModernChunks: false,
              additionalLegacyPolyfills: ['core-js/proposals/global-this'],
            }),
          ]
        : []),
      tizen3LegacyHtml(),
    ],
    worker: {
      plugins: () => [workerCompatibility(), legacyWorkerOutput(true), svelte()],
    },
    css: {
      postcss: { plugins: [legacyScopedCss, ...tizen3CssPlugins] },
      // Vite uses Lightning CSS as its production minifier. Supplying its own target (rather than relying only on
      // esbuild's cssTarget) lets the maintained transformer add every fallback it can for the old engine.
      ...(tizen3
        ? {
            lightningcss: {
              targets: { chrome: 47 << 16 },
              // clamp() -> min()/max() is not useful for this engine: both forms are unsupported.
              exclude: LightningCssFeatures.ClampFunction,
            },
          }
        : {}),
    },
    build: {
      ...(!tizen3 ? { target: legacyTizen ? 'chrome69' : 'chrome85' } : {}),
      cssTarget: tizen3 ? 'chrome47' : legacyTizen ? 'chrome69' : 'chrome85',
      ...(tizen3 ? { cssMinify: 'lightningcss' as const } : {}),
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
