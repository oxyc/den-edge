#!/usr/bin/env node

// Semantic parity for the capability Tizen 3 actually ships. This executes both generated cores; it does not merely
// inspect filenames or source text. Recovery and assistant are intentionally browser-only on this tier.
import { readFile } from 'node:fs/promises';
const policy = JSON.parse(
  await readFile(new URL('../src/vendor/den-core/policy-v1.json', import.meta.url), 'utf8'),
);
const wasmCore = await import('../src/vendor/den-core-tv/index.js');
// The fallback is emitted as a classic asset so Vite/Babel never expand it into each Worker. Exercise that exact
// global contract here, then supply the tiny adapter's URL import through Node's test-only loader query handling.
await import('../src/vendor/den-core-tizen3/generated/den_core.js');
const adapterSource = await readFile(
  new URL('../src/vendor/den-core-tizen3/index.js', import.meta.url),
  'utf8',
);
const javascriptCore = await import(
  `data:text/javascript,${encodeURIComponent(adapterSource.replace("import coreUrl from './generated/den_core.js?url';", "const coreUrl = 'unused-in-node';"))}`
);
const profiles = JSON.parse(
  await readFile(new URL('../src/vendor/den-core/profiles-v1.json', import.meta.url), 'utf8'),
);
await wasmCore.initialize(
  await readFile(new URL('../src/vendor/den-core-tv/generated/den_core_bg.wasm', import.meta.url)),
);
await javascriptCore.initialize();

let compared = 0;
for (const fixture of [...policy.cases, ...profiles.cases]) {
  const operation = String(fixture.request.op);
  if (operation.startsWith('assistant_') || operation.startsWith('recovery_')) continue;
  const request = JSON.stringify(fixture.request);
  const expected = wasmCore.evaluate(request);
  const actual = javascriptCore.evaluate(request);
  if (actual !== expected)
    throw new Error(
      `Tizen 3 JavaScript policy differs for ${fixture.name}: ${actual} != ${expected}`,
    );
  compared++;
}
if (compared < 100) throw new Error(`Tizen 3 policy parity covered only ${compared} fixtures`);
console.log(
  `Tizen 3 JavaScript policy matched Wasm for ${compared} non-recovery, non-assistant fixtures.`,
);
