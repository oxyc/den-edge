import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transformAsync } from '@babel/core';
import { verifyTvCore, verifyTizen3Core, sha256 } from './tv-core-artifacts.mjs';

/**
 * The first syntax in `code` that Chromium 47 cannot run, or null. Read from the syntax tree: the same characters in
 * a string or a regular expression (core-js feature-tests `async function*` inside `Function("…")`) are not syntax.
 */
async function modernSyntax(code, fileName) {
  let found = null;
  const note = (what) => () => void (found ??= what);
  await transformAsync(code, {
    babelrc: false,
    configFile: false,
    filename: fileName,
    code: false,
    sourceType: 'script',
    plugins: [
      () => ({
        visitor: {
          ArrowFunctionExpression: note('an arrow function'),
          BigIntLiteral: note('a BigInt literal'),
          VariableDeclaration(path) {
            if (path.node.kind !== 'var') found ??= path.node.kind;
          },
          Function(path) {
            if (path.node.async) found ??= 'an async function';
          },
        },
      }),
    ],
  });
  return found;
}

const tvCore = verifyTvCore();

const platform = process.argv[2];
if (!['webos', 'tizen'].includes(platform)) throw new Error('Expected webos or tizen');
const directory = resolve(
  import.meta.dirname,
  '..',
  process.env.DEN_TV_OUT_DIR ??
    (process.env.DEN_TV_PACKAGED === '1' ? 'dist-tv-tizen-package' : `dist-tv-${platform}`),
);
const assets = await readdir(resolve(directory, 'assets'));
const entryHtml = await readFile(resolve(directory, 'index.html'), 'utf8');
const expectedViewport = 'width=1920, initial-scale=1';
if (!entryHtml.includes(`<meta name="viewport" content="${expectedViewport}">`))
  throw new Error('TV entry is missing its fixed 1920px viewport');
const tizenVersion = process.env.DEN_TIZEN_VERSION;
const tizen3 = platform === 'tizen' && tizenVersion === '3.0';
if (platform === 'tizen' && (tizen3 || tizenVersion === '5.5')) {
  for (const file of assets.filter((name) => name.endsWith('.js'))) {
    const code = await readFile(resolve(directory, 'assets', file), 'utf8');
    if (/type:[`'"]module[`'"]/.test(code))
      throw new Error(`Module Worker option remains in the Tizen ${tizenVersion} build: ${file}`);
    if (
      tizen3 &&
      /(?:diagnosticWorker|libraryServiceWorker|libraryWorker|recoveryWorker)-/.test(file)
    ) {
      const found = await modernSyntax(code, file);
      if (found)
        throw new Error(
          `Post-minify legacy syntax lowering left ${found} in Tizen 3 Worker: ${file}`,
        );
    }
  }
}
if (tizen3) {
  verifyTizen3Core();
  if (/type=["']module["']|rel=["']modulepreload["']/.test(entryHtml))
    throw new Error('Native module loading remains in the Tizen 3 build');
  if (
    !entryHtml.includes('id="vite-legacy-polyfill"') ||
    !entryHtml.includes('id="vite-legacy-entry"')
  )
    throw new Error('Tizen 3 build is missing the SystemJS legacy loader');
  // The package metadata is written only for a packaged build (`DEN_TV_PACKAGED=1`).
  if (process.env.DEN_TV_PACKAGED === '1') {
    const metadata = JSON.parse(await readFile(resolve(directory, 'den-tv-package.json'), 'utf8'));
    if (
      metadata.tizenVersion !== '3.0' ||
      metadata.legacyNonModule !== true ||
      metadata.policyCore !== 'javascript'
    )
      throw new Error('Tizen 3 package metadata is not marked as legacy non-module output');
  }
  const pairFiles = assets.filter((file) => /^pair-legacy-.*\.js$/.test(file));
  if (pairFiles.length !== 1) throw new Error('Expected one Tizen 3 pairing chunk');
  const pair = await readFile(resolve(directory, 'assets', pairFiles[0]), 'utf8');
  if (/\bBigInt\s*\(|\b\d+n\b/.test(pair))
    throw new Error('Native BigInt remains in the Tizen 3 pairing path');
  if (!pair.includes('ristretto255'))
    throw new Error('Tizen 3 pairing did not select the typed-array Ristretto adapter');
  if (process.env.DEN_TV_OLD_ENGINE_LIMITS === '1') {
    const scripts = await Promise.all(
      assets
        .filter((file) => file.endsWith('.js'))
        .map(async (file) => ({
          file,
          code: await readFile(resolve(directory, 'assets', file), 'utf8'),
        })),
    );
    if (!scripts.some(({ code }) => code.includes('__denOldEngineLimits')))
      throw new Error('Tizen 3 page did not install the enforced old-engine limits');
    for (const worker of [
      'assistantProjectionWorker',
      'diagnosticWorker',
      'libraryServiceWorker',
      'libraryWorker',
      'recoveryWorker',
    ]) {
      const output = scripts.find(({ file }) => file.startsWith(`${worker}-`));
      if (output && !output.code.includes('__denOldEngineLimits'))
        throw new Error(`${worker} did not install the enforced old-engine limits`);
    }
  }
  const css = (
    await Promise.all(
      assets
        .filter((file) => file.endsWith('.css'))
        .map((file) => readFile(resolve(directory, 'assets', file), 'utf8')),
    )
  ).join('\n');
  if (
    /(?:-webkit-)?backdrop-filter\s*:|\bblur\(|@(?:-webkit-)?keyframes\b|\b(?:animation|transition)(?:-[\w-]+)?\s*:/i.test(
      css,
    )
  )
    throw new Error('Tizen 3 CSS still contains a blur, animation or transition');
  const hls = assets.filter((file) => /(?:^|[-.])hls(?:-legacy)?[-.]/i.test(file));
  if (hls.length) throw new Error(`hls.js leaked into the Tizen 3 package: ${hls.join(', ')}`);
}
if (tizen3 && assets.some((file) => file.endsWith('.wasm')))
  throw new Error('A Wasm asset leaked into the Tizen 3 JavaScript-core package');
for (const name of [
  'den_core_startup',
  'den_core_deferred',
  'den_core_assistant',
  'den_core_recovery',
]) {
  const matches = assets.filter((file) => file.startsWith(`${name}_bg-`) && file.endsWith('.wasm'));
  if (tizen3) continue;
  if (matches.length !== 1) throw new Error(`Expected only the compatible TV ${name} WASM asset`);
  const bytes = await readFile(resolve(directory, 'assets', matches[0]));
  if (sha256(bytes) !== tvCore.artifacts[`generated/${name}_bg.wasm`])
    throw new Error(`Non-TV WASM leaked into the TV build: ${matches[0]}`);
}
if (!tizen3 && assets.some((file) => /^den_core_bg-.*\.wasm$/.test(file)))
  throw new Error('The duplicate full policy core leaked into the TV build');
if (platform === 'webos' && assets.some((file) => /^avplay-/.test(file)))
  throw new Error('Samsung AVPlay leaked into the LG build');
for (const worker of ['libraryServiceWorker', 'recoveryWorker']) {
  const files = assets.filter((file) => file.startsWith(`${worker}-`) && file.endsWith('.js'));
  if (files.length !== 1) throw new Error(`Expected exactly one ${worker}, got ${files.length}`);
  const code = await readFile(resolve(directory, 'assets', files[0]), 'utf8');
  if (/\$(?:state|derived|effect|props|bindable|inspect|host)(?:\.|\()/.test(code))
    throw new Error(`Uncompiled Svelte rune in ${files[0]}`);
  // Both entries need their own standard-library shims, not the page's global objects.
  if (!code.includes('randomUUID') || !code.includes('throwIfAborted'))
    throw new Error(`Missing TV runtime compatibility in ${files[0]}`);
}

if (assets.some((file) => file.includes('libraryServiceSharedWorker')))
  throw new Error(`${platform}: desktop SharedWorker leaked into the TV build`);
const manifest = JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'));
const fixture = Object.keys(manifest).some((file) => /(?:test\/|test-entry)/.test(file));
if (fixture !== (process.env.DEN_TV_E2E === '1'))
  throw new Error('TV test fixture isolation failed');
console.log(`${platform}: Worker compilation, compatibility and test fixture isolation verified`);
