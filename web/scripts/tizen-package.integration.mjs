#!/usr/bin/env node

// Unsigned package-preparation smoke test. It deliberately never installs or signs.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const webRoot = resolve(import.meta.dirname, '..');
const env = { ...process.env, DEN_TV_PACKAGED: '1', DEN_TV_API_ORIGIN: 'https://den.example' };
const build = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build:tv:tizen'],
  {
    cwd: webRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const prepare = spawnSync(
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
  { cwd: webRoot, env, encoding: 'utf8', stdio: 'inherit' },
);
if (prepare.status !== 0) process.exit(prepare.status ?? 1);

const shell = join(webRoot, 'tv-packages', 'smoke-test', 'tizen', 'shell');
const config = readFileSync(join(shell, 'config.xml'), 'utf8');
for (const required of [
  'DenTvApp1X.Den',
  'package="DenTvApp1X"',
  'required_version="8.0"',
  '<tizen:profile name="tv-samsung"',
  'metadata/devel.api.version',
  'value="8.0"',
  'origin="*"',
  'privilege/internet',
  'privilege/tv.inputdevice',
  '<tizen:content-security-policy>',
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "worker-src 'self' blob:",
  "object-src 'self'",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob: https:",
  'frame-src https://www.youtube-nocookie.com',
])
  if (!config.includes(required)) throw new Error(`Tizen config validation failed: ${required}`);
if (/script-src[^;]*'unsafe-(?:inline|eval)'/.test(config))
  throw new Error('Unsafe JavaScript CSP source present in Tizen config');
const index = readFileSync(join(shell, 'index.html'), 'utf8');
if (/\b(?:src|href)="\/(?:assets|manifest)/.test(index))
  throw new Error('Root-absolute asset URL remains in packaged index');
const bridge = '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>';
if (!index.includes(bridge))
  throw new Error('Packaged Tizen index is missing the Samsung Web API bridge required by AVPlay');
if (index.indexOf(bridge) > index.indexOf('<script type="module"'))
  throw new Error('Samsung Web API bridge must load before the application module');
const icon = readFileSync(join(shell, 'icon.png'));
if (
  icon.length < 24 ||
  icon.toString('ascii', 1, 4) !== 'PNG' ||
  icon.readUInt32BE(16) !== 117 ||
  icon.readUInt32BE(20) !== 117
)
  throw new Error('Packaged Tizen icon must be a 117x117 PNG');
if (!index.includes('http-equiv="Content-Security-Policy"'))
  throw new Error('Packaged index does not enforce its manifest CSP during browser/E2E execution');
for (const source of ["script-src 'self' 'wasm-unsafe-eval'", "object-src 'self'"])
  if (!index.includes(source)) throw new Error(`Packaged index CSP is missing: ${source}`);
const xmllint = spawnSync('xmllint', ['--noout', join(shell, 'config.xml')], { encoding: 'utf8' });
if (!xmllint.error && xmllint.status !== 0)
  throw new Error(`config.xml is not well-formed: ${xmllint.stderr}`);

const widget = join(webRoot, 'tv-packages', 'smoke-test', 'tizen', 'packages', 'den-tv-tizen.wgt');
const packageWidget = spawnSync(
  process.execPath,
  ['scripts/tizen-unsigned-wgt.mjs', shell, widget],
  { cwd: webRoot, encoding: 'utf8', stdio: 'inherit' },
);
if (packageWidget.status !== 0) process.exit(packageWidget.status ?? 1);

const rejected = spawnSync(
  process.execPath,
  ['scripts/tv-package.mjs', 'tizen', '--prepare', '--smoke-test', '--url', 'https://den.example'],
  {
    cwd: webRoot,
    env: { ...env, DEN_TV_API_ORIGIN: 'https://den.example/api' },
    encoding: 'utf8',
  },
);
if (rejected.status === 0 || !rejected.stderr.includes('exact HTTPS origin'))
  throw new Error('Packager accepted an API URL with a path');
console.log(
  'Prepared Tizen shell and unsigned WGT passed metadata, root-layout, asset-path, icon, and optional XML validation.',
);
