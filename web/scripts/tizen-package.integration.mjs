#!/usr/bin/env node

// Unsigned package-preparation smoke test. It deliberately never installs or signs.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const webRoot = resolve(import.meta.dirname, '..');
const shell = join(webRoot, 'tv-packages', 'smoke-test', 'tizen', 'shell');
const widget = join(webRoot, 'tv-packages', 'smoke-test', 'tizen', 'packages', 'den-tv-tizen.wgt');

run(process.execPath, ['scripts/tizen3-core.integration.mjs'], process.env);

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: webRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function testTier(tizenVersion, wasmCspSource) {
  const env = {
    ...process.env,
    DEN_TV_PACKAGED: '1',
    DEN_TV_API_ORIGIN: 'https://den.example',
    DEN_TIZEN_VERSION: tizenVersion,
  };
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:tv:tizen'], env);
  run(
    process.execPath,
    [
      'scripts/tv-package.mjs',
      'tizen',
      '--prepare',
      '--smoke-test',
      '--url',
      'https://den.example',
      '--version',
      '1.2.3',
    ],
    env,
  );

  const config = readFileSync(join(shell, 'config.xml'), 'utf8');
  for (const required of [
    'DenTvApp1X.Den',
    'package="DenTvApp1X"',
    `required_version="${tizenVersion}"`,
    '<tizen:profile name="tv-samsung"',
    'metadata/devel.api.version',
    `value="${tizenVersion}"`,
    'origin="*"',
    'privilege/internet',
    'privilege/tv.inputdevice',
    '<tizen:content-security-policy>',
    `script-src 'self' ${wasmCspSource}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
    "object-src 'self'",
    "connect-src 'self' https: wss:",
    "media-src 'self' blob: https:",
    'frame-src https://www.youtube-nocookie.com',
  ])
    if (!config.includes(required)) throw new Error(`Tizen config validation failed: ${required}`);
  if (/script-src[^;]*'unsafe-inline'/.test(config))
    throw new Error('Inline JavaScript CSP source present in Tizen config');
  if (tizenVersion === '3.0' && !/style-src[^;]*'unsafe-inline'/.test(config))
    throw new Error('Tizen 3 config must permit Svelte legacy component styles');
  if (tizenVersion !== '3.0' && /style-src[^;]*'unsafe-inline'/.test(config))
    throw new Error('Supported Tizen tiers unnecessarily permit inline element styles');
  if (tizenVersion === '8.0' && /script-src[^;]*'unsafe-eval'/.test(config))
    throw new Error('Modern Tizen config unnecessarily permits JavaScript eval');

  const index = readFileSync(join(shell, 'index.html'), 'utf8');
  if (/\b(?:src|href)="\/(?:assets|manifest)/.test(index))
    throw new Error('Root-absolute asset URL remains in packaged index');
  const bridge = '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>';
  if (!index.includes(bridge))
    throw new Error(
      'Packaged Tizen index is missing the Samsung Web API bridge required by AVPlay',
    );
  const applicationScript =
    tizenVersion === '3.0'
      ? index.indexOf('id="vite-legacy-polyfill"')
      : index.indexOf('<script type="module"');
  if (applicationScript < 0 || index.indexOf(bridge) > applicationScript)
    throw new Error('Samsung Web API bridge must load before the application');
  if (tizenVersion === '3.0') {
    if (/type=["']module["']|rel=["']modulepreload["']/.test(index))
      throw new Error('Tizen 3 package contains native module loading');
    if (!index.includes('id="vite-legacy-entry"'))
      throw new Error('Tizen 3 package is missing its SystemJS entry');
  }
  const icon = readFileSync(join(shell, 'icon.png'));
  if (
    icon.length < 24 ||
    icon.toString('ascii', 1, 4) !== 'PNG' ||
    icon.readUInt32BE(16) !== 117 ||
    icon.readUInt32BE(20) !== 117
  )
    throw new Error('Packaged Tizen icon must be a 117x117 PNG');
  if (!index.includes('http-equiv="Content-Security-Policy"'))
    throw new Error(
      'Packaged index does not enforce its manifest CSP during browser/E2E execution',
    );
  for (const source of [`script-src 'self' ${wasmCspSource}`, "object-src 'self'"])
    if (!index.includes(source)) throw new Error(`Packaged index CSP is missing: ${source}`);
  const xmllint = spawnSync('xmllint', ['--noout', join(shell, 'config.xml')], {
    encoding: 'utf8',
  });
  if (!xmllint.error && xmllint.status !== 0)
    throw new Error(`config.xml is not well-formed: ${xmllint.stderr}`);

  run(process.execPath, ['scripts/tizen-unsigned-wgt.mjs', shell, widget], env);
}

testTier('8.0', "'wasm-unsafe-eval'");
testTier('6.5', "'unsafe-eval'");
testTier('5.5', "'unsafe-eval'");
testTier('3.0', "'unsafe-eval'");

const rejected = spawnSync(
  process.execPath,
  ['scripts/tv-package.mjs', 'tizen', '--prepare', '--smoke-test', '--url', 'https://den.example'],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      DEN_TV_PACKAGED: '1',
      DEN_TV_API_ORIGIN: 'https://den.example/api',
      DEN_TIZEN_VERSION: '8.0',
    },
    encoding: 'utf8',
  },
);
if (rejected.status === 0 || !rejected.stderr.includes('exact HTTPS origin'))
  throw new Error('Packager accepted an API URL with a path');
console.log(
  'Tizen 8.0, 6.5, 5.5, and experimental 3.0 unsigned WGTs passed metadata, CSP, root-layout, asset-path, icon, and optional XML validation.',
);
