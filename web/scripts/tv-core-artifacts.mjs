import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const browserCore = resolve(import.meta.dirname, '../src/vendor/den-core');
export const tvCore = resolve(import.meta.dirname, '../src/vendor/den-core-tv');
export const tizen3Core = resolve(import.meta.dirname, '../src/vendor/den-core-tizen3');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const coreManifest = () => JSON.parse(readFileSync(resolve(browserCore, 'SOURCE.json')));
export const tvCoreArtifacts = [
  'LICENSE',
  'index.js',
  'index.d.ts',
  'startup.js',
  'startup.d.ts',
  'deferred.js',
  'deferred.d.ts',
  'lifecycle.js',
  'lifecycle.d.ts',
  'assistant.js',
  'assistant.d.ts',
  'recovery.js',
  'recovery.d.ts',
  ...[
    'den_core',
    'den_core_startup',
    'den_core_deferred',
    'den_core_assistant',
    'den_core_recovery',
  ].flatMap((name) =>
    [`${name}.js`, `${name}.d.ts`, `${name}_bg.wasm`, `${name}_bg.wasm.d.ts`].map(
      (file) => `generated/${file}`,
    ),
  ),
].sort();

export function checkTvCoreInventory(directory = tvCore) {
  const visit = (prefix = '') =>
    readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return visit(`${name}/`);
      if (!entry.isFile()) throw new Error(`Unexpected TV core artifact type: ${name}`);
      return [name];
    });
  const expected = new Set([...tvCoreArtifacts, 'SOURCE.json']);
  for (const name of visit()) {
    if (!expected.has(name))
      throw new Error(`Unrecorded TV core artifact; review before regenerating: ${name}`);
  }
}

// A core update must update both targets from exactly the same policy sources. Never silently ship a stale TV
// policy beside a newer browser policy, or let an edited/generated binary bypass its recorded artifact hashes.
export function verifyTvCore() {
  checkTvCoreInventory();
  const source = coreManifest();
  const tv = JSON.parse(readFileSync(resolve(tvCore, 'SOURCE.json')));
  if (tv.sourceDigest !== source.sourceDigest || tv.wasmBindgen !== source.wasmBindgen)
    throw new Error('TV den-core is stale: rebuild it from the browser core manifest sources');
  if (
    tv.schema !== 1 ||
    tv.rust !== source.rust ||
    tv.sourceManifest !== '../den-core/SOURCE.json' ||
    tv.rustflags !==
      '-Zunstable-options -Cpanic=immediate-abort -C target-feature=-reference-types' ||
    JSON.stringify(tv.buildStd) !== JSON.stringify(['std', 'panic_abort']) ||
    tv.removeNameSection !== true ||
    tv.normalizedBuildPaths !== true
  )
    throw new Error('TV den-core compatibility build recipe does not match the pinned generator');
  if (JSON.stringify(Object.keys(tv.artifacts).sort()) !== JSON.stringify(tvCoreArtifacts))
    throw new Error('TV den-core manifest has an incomplete artifact list');
  for (const name of [
    'index.js',
    'index.d.ts',
    'startup.js',
    'startup.d.ts',
    'deferred.js',
    'deferred.d.ts',
    'lifecycle.js',
    'lifecycle.d.ts',
    'assistant.js',
    'assistant.d.ts',
    'recovery.js',
    'recovery.d.ts',
    'LICENSE',
  ]) {
    if (!readFileSync(resolve(browserCore, name)).equals(readFileSync(resolve(tvCore, name))))
      throw new Error(`TV den-core wrapper differs from the shared core: ${name}`);
  }
  for (const [name, expected] of Object.entries(tv.artifacts)) {
    if (sha256(readFileSync(resolve(tvCore, name))) !== expected)
      throw new Error(`TV den-core artifact hash mismatch: ${name}`);
  }
  return tv;
}

/** The JavaScript fallback is an explicit third artifact set, never an alias for either Wasm build. */
export function verifyTizen3Core() {
  const source = coreManifest();
  const legacy = JSON.parse(readFileSync(resolve(tizen3Core, 'SOURCE.json')));
  const expectedArtifacts = ['generated/den_core.js', 'index.d.ts', 'index.js'];
  if (
    legacy.schema !== 1 ||
    legacy.sourceDigest !== source.sourceDigest ||
    legacy.sourceManifest !== '../den-core/SOURCE.json' ||
    legacy.rust !== source.rust ||
    legacy.binaryen !== 133 ||
    legacy.rustflags !==
      '-Zunstable-options -Cpanic=immediate-abort -C target-feature=-reference-types,-multivalue' ||
    JSON.stringify(legacy.excludes) !== JSON.stringify(['assistant'])
  )
    throw new Error('Tizen 3 den-core recipe does not match the pinned JavaScript fallback');
  if (JSON.stringify(Object.keys(legacy.artifacts).sort()) !== JSON.stringify(expectedArtifacts))
    throw new Error('Tizen 3 den-core manifest has an incomplete artifact list');
  const inventory = readdirSync(tizen3Core, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(tizen3Core.length + 1))
    .sort();
  if (JSON.stringify(inventory) !== JSON.stringify([...expectedArtifacts, 'SOURCE.json'].sort()))
    throw new Error('Tizen 3 den-core contains an unrecorded artifact');
  for (const [name, expected] of Object.entries(legacy.artifacts)) {
    if (sha256(readFileSync(resolve(tizen3Core, name))) !== expected)
      throw new Error(`Tizen 3 den-core artifact hash mismatch: ${name}`);
  }
  return legacy;
}
