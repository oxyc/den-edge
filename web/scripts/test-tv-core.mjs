// Binary compatibility/parity check, complementary to the real old-engine encrypted-library E2E journeys.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCore, tvCore, verifyTvCore } from './tv-core-artifacts.mjs';

verifyTvCore();
for (const [name, maximum] of [
  ['den_core_bg.wasm', 1_420_000],
  ['den_core_assistant_bg.wasm', 570_000],
  ['den_core_recovery_bg.wasm', 165_000],
]) {
  const bytes = statSync(join(tvCore, 'generated', name)).size;
  assert.ok(bytes <= maximum, `${name} is ${bytes} bytes; expected at most ${maximum}`);
}
const cores = await Promise.all(
  [browserCore, tvCore].map(async (directory) => {
    const main = await import(pathToFileURL(join(directory, 'index.js')).href);
    const assistant = await import(pathToFileURL(join(directory, 'assistant.js')).href);
    const recovery = await import(pathToFileURL(join(directory, 'recovery.js')).href);
    await main.initialize(readFileSync(join(directory, 'generated/den_core_bg.wasm')));
    await assistant.initializeAssistant(
      readFileSync(join(directory, 'generated/den_core_assistant_bg.wasm')),
    );
    await recovery.initializeRecovery(
      readFileSync(join(directory, 'generated/den_core_recovery_bg.wasm')),
    );
    return (request) => {
      const evaluate = request.op.startsWith('assistant_')
        ? assistant.evaluateAssistant
        : request.op === 'recovery_derive'
          ? recovery.evaluateRecovery
          : main.evaluate;
      return JSON.parse(evaluate(JSON.stringify(request)));
    };
  }),
);
let count = 0;
for (const file of ['policy-v1.json', 'policy-v3.json', 'profiles-v1.json']) {
  const fixture = JSON.parse(readFileSync(join(browserCore, file)));
  for (const vector of fixture.cases) {
    const actual = cores[1](vector.request);
    assert.deepEqual(
      actual,
      cores[0](vector.request),
      `${file}: ${vector.name}: TV/browser parity`,
    );
    if ('error' in vector) assert.equal(actual.error, vector.error, vector.name);
    else assert.deepEqual(actual.ok, vector.ok, vector.name);
    count++;
  }
}
console.log(`TV and browser core: ${count} source-pinned policy vectors agree`);
