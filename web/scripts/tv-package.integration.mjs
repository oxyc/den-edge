#!/usr/bin/env node

// Real CLI smoke test: this intentionally uses the cached/installed SDK when
// available and does not replace it with a mocked `ares-package` executable.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const webRoot = resolve(import.meta.dirname, '..');
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  command,
  [
    'exec',
    '--yes',
    '--package=@webos-tools/cli@3.2.6',
    '--',
    'node',
    'scripts/tv-package.mjs',
    'webos',
    '--url',
    'https://den-tv.example.invalid/',
    '--version',
    '1.2.3',
    '--smoke-test',
  ],
  { cwd: webRoot, encoding: 'utf8', stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const shell = join(webRoot, 'tv-packages', 'smoke-test', 'webos', 'shell');
const packages = join(webRoot, 'tv-packages', 'smoke-test', 'webos', 'packages');
const appinfo = JSON.parse(readFileSync(join(shell, 'appinfo.json'), 'utf8'));
if (appinfo.version !== '1.2.3' || appinfo.disableBackHistoryAPI !== true)
  throw new Error('webOS metadata smoke check failed');
if (!existsSync(join(shell, 'icon.png')) || !existsSync(join(shell, 'largeicon.png')))
  throw new Error('webOS icon smoke check failed');

const ipk = join(packages, 'com.den.edge.tv_1.2.3_all.ipk');
if (!existsSync(ipk)) throw new Error('LG SDK did not produce the expected package');
for (const [file, size] of [
  ['icon.png', 80],
  ['largeicon.png', 130],
]) {
  const bytes = readFileSync(join(shell, file));
  if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size)
    throw new Error(`${file} has invalid PNG dimensions`);
}
console.log(`SDK package smoke passed: ${ipk}`);
