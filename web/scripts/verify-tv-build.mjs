import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyTvCore, sha256 } from './tv-core-artifacts.mjs';

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
if (platform === 'tizen' && process.env.DEN_TIZEN_VERSION === '5.5') {
  for (const file of assets.filter((name) => name.endsWith('.js'))) {
    const code = await readFile(resolve(directory, 'assets', file), 'utf8');
    if (/type:[`'"]module[`'"]/.test(code))
      throw new Error(`Module Worker option remains in the Tizen 5.5 build: ${file}`);
  }
}
for (const name of ['den_core', 'den_core_assistant', 'den_core_recovery']) {
  const matches = assets.filter((file) => file.startsWith(`${name}_bg-`) && file.endsWith('.wasm'));
  if (matches.length !== 1) throw new Error(`Expected only the compatible TV ${name} WASM asset`);
  const bytes = await readFile(resolve(directory, 'assets', matches[0]));
  if (sha256(bytes) !== tvCore.artifacts[`generated/${name}_bg.wasm`])
    throw new Error(`Non-TV WASM leaked into the TV build: ${matches[0]}`);
}
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
const manifest = JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'));
const fixture = Object.keys(manifest).some((file) => /(?:test\/|test-entry)/.test(file));
if (fixture !== (process.env.DEN_TV_E2E === '1'))
  throw new Error('TV test fixture isolation failed');
console.log(`${platform}: Worker compilation, compatibility and test fixture isolation verified`);
