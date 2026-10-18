import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const platform = process.argv[2];
if (!['webos', 'tizen'].includes(platform)) throw new Error('Expected webos or tizen');
const directory = resolve(
  import.meta.dirname,
  '..',
  process.env.DEN_TV_OUT_DIR ??
    (process.env.DEN_TV_PACKAGED === '1' ? 'dist-tv-tizen-package' : `dist-tv-${platform}`),
);
const assets = await readdir(resolve(directory, 'assets'));
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
