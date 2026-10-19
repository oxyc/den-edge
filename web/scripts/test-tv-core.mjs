// Binary compatibility/parity check, complementary to the real old-engine encrypted-library E2E journeys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCore, tvCore, verifyTvCore } from './tv-core-artifacts.mjs';

verifyTvCore();
const cores = await Promise.all(
  [browserCore, tvCore].map(async (directory) => {
    const main = await import(pathToFileURL(join(directory, 'index.js')).href);
    const assistant = await import(pathToFileURL(join(directory, 'assistant.js')).href);
    await main.initialize(readFileSync(join(directory, 'generated/den_core_bg.wasm')));
    await assistant.initializeAssistant(
      readFileSync(join(directory, 'generated/den_core_assistant_bg.wasm')),
    );
    return (request) =>
      JSON.parse(
        (request.op.startsWith('assistant_') ? assistant.evaluateAssistant : main.evaluate)(
          JSON.stringify(request),
        ),
      );
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
