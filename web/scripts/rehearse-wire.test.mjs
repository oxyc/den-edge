import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { loadRehearsalWire, ownRehearsalWire } from './rehearse-wire.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('initializes the exact Browser policy splits before their wire consumers', async () => {
  const calls = [];
  const initialized = (name) => async (bytes) => calls.push(`initialize:${name}:${bytes}`);
  const server = {
    ssrLoadModule: async (path) => {
      calls.push(`load:${path}`);
      if (path.endsWith('/index.js')) return { initialize: initialized('main') };
      if (path.endsWith('/startup.js')) return { initializeStartup: initialized('startup') };
      if (path.endsWith('/deferred.js')) return { initializeDeferred: initialized('deferred') };
      if (path.endsWith('/libraryV4.ts')) return { projectDocument() {}, projectEpisode() {} };
      return { deriveKeys() {} };
    },
  };

  await loadRehearsalWire(server, '/web', (path) => path);

  assert.deepEqual(calls, [
    'load:/src/vendor/den-core/index.js',
    'initialize:main:/web/src/vendor/den-core/generated/den_core_bg.wasm',
    'load:/src/vendor/den-core/startup.js',
    'initialize:startup:/web/src/vendor/den-core/generated/den_core_startup_bg.wasm',
    'load:/src/vendor/den-core/deferred.js',
    'initialize:deferred:/web/src/vendor/den-core/generated/den_core_deferred_bg.wasm',
    'load:/src/lib/libraryV4.ts',
    'load:/src/lib/wire.ts',
  ]);
});

test('the initialized checked-in splits answer startup and deferred requests', async (context) => {
  const server = await createServer({
    root: WEB,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  context.after(() => server.close());

  await loadRehearsalWire(server, WEB, readFileSync);
  const startup = await server.ssrLoadModule('/src/vendor/den-core/startup.js');
  const deferred = await server.ssrLoadModule('/src/vendor/den-core/deferred.js');
  const lifecycle = await server.ssrLoadModule('/src/vendor/den-core/lifecycle.js');
  const fixtures = JSON.parse(
    readFileSync(resolve(WEB, 'src/vendor/den-core/policy-v1.json'), 'utf8'),
  );
  const startupCase = fixtures.cases.find(({ request }) =>
    lifecycle.isStartupOperation(request.op),
  );
  const deferredCase = fixtures.cases.find(
    ({ request }) => !lifecycle.isStartupOperation(request.op),
  );

  assert.deepEqual(
    JSON.parse(startup.evaluateStartup(JSON.stringify(startupCase.request))).ok,
    startupCase.ok,
  );
  assert.deepEqual(
    JSON.parse(deferred.evaluateDeferred(JSON.stringify(deferredCase.request))).ok,
    deferredCase.ok,
  );
});

test('closes the owned Vite server when split setup fails', async () => {
  const failure = new Error('deferred initialization failed');
  let closes = 0;
  const server = { close: async () => closes++ };

  await assert.rejects(
    ownRehearsalWire(server, '/web', async () => {
      throw failure;
    }),
    failure,
  );
  assert.equal(closes, 1);
});
