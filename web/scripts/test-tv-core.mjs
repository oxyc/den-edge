// Binary compatibility/parity check, complementary to the real old-engine encrypted-library E2E journeys.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCore, tvCore, verifyTvCore } from './tv-core-artifacts.mjs';
import { checkSeasonProjection } from './season-projection-parity.mjs';

verifyTvCore();
for (const [name, maximum] of [
  ['den_core_bg.wasm', 1_000_000],
  ['den_core_startup_bg.wasm', 450_000],
  ['den_core_deferred_bg.wasm', 900_000],
  ['den_core_assistant_bg.wasm', 540_000],
  ['den_core_recovery_bg.wasm', 140_000],
]) {
  const bytes = statSync(join(tvCore, 'generated', name)).size;
  assert.ok(bytes <= maximum, `${name} is ${bytes} bytes; expected at most ${maximum}`);
}
const cores = await Promise.all(
  [browserCore, tvCore].map(async (directory) => {
    const main = await import(pathToFileURL(join(directory, 'index.js')).href);
    const startup = await import(pathToFileURL(join(directory, 'startup.js')).href);
    const deferred = await import(pathToFileURL(join(directory, 'deferred.js')).href);
    const lifecycle = await import(pathToFileURL(join(directory, 'lifecycle.js')).href);
    const assistant = await import(pathToFileURL(join(directory, 'assistant.js')).href);
    const recovery = await import(pathToFileURL(join(directory, 'recovery.js')).href);
    await main.initialize(readFileSync(join(directory, 'generated/den_core_bg.wasm')));
    await startup.initializeStartup(
      readFileSync(join(directory, 'generated/den_core_startup_bg.wasm')),
    );
    await deferred.initializeDeferred(
      readFileSync(join(directory, 'generated/den_core_deferred_bg.wasm')),
    );
    await assistant.initializeAssistant(
      readFileSync(join(directory, 'generated/den_core_assistant_bg.wasm')),
    );
    await recovery.initializeRecovery(
      readFileSync(join(directory, 'generated/den_core_recovery_bg.wasm')),
    );
    return (request) => {
      const input = JSON.stringify(request);
      if (request.op.startsWith('assistant_'))
        return JSON.parse(assistant.evaluateAssistant(input));
      if (request.op === 'recovery_derive') return JSON.parse(recovery.evaluateRecovery(input));
      const full = JSON.parse(main.evaluate(input));
      const split = JSON.parse(
        lifecycle.isStartupOperation(request.op)
          ? startup.evaluateStartup(input)
          : deferred.evaluateDeferred(input),
      );
      assert.deepEqual(split, full, `${request.op}: lifecycle/full parity in ${directory}`);
      return split;
    };
  }),
);
let count = 0;
for (const file of ['policy-v1.json', 'profiles-v1.json']) {
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
for (const [index, runtime] of ['browser', 'TV'].entries())
  checkSeasonProjection(cores[index], runtime);
console.log('Browser and TV season projection matches scalar episode policy');
