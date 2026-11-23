import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modules = [
  {
    path: '/src/vendor/den-core/index.js',
    initialize: 'initialize',
    wasm: 'den_core_bg.wasm',
  },
  {
    path: '/src/vendor/den-core/startup.js',
    initialize: 'initializeStartup',
    wasm: 'den_core_startup_bg.wasm',
  },
  {
    path: '/src/vendor/den-core/deferred.js',
    initialize: 'initializeDeferred',
    wasm: 'den_core_deferred_bg.wasm',
  },
];

/** Load every synchronous policy split before importing its wire consumers. */
export async function loadRehearsalWire(server, webRoot, readWasm = readFileSync) {
  for (const module of modules) {
    const core = await server.ssrLoadModule(module.path);
    await core[module.initialize](
      readWasm(join(webRoot, 'src/vendor/den-core/generated', module.wasm)),
    );
  }

  // Documents as the page reads them (den-core's `title_state`, `episode_state_v4`), for the accounting.
  const { projectDocument, projectEpisode } = await server.ssrLoadModule('/src/lib/libraryV4.ts');
  return {
    ...(await server.ssrLoadModule('/src/lib/wire.ts')),
    projectDocument,
    projectEpisode,
  };
}

/** Own the Vite server from creation through either a usable wire or failed setup cleanup. */
export async function ownRehearsalWire(server, webRoot, load = loadRehearsalWire) {
  try {
    return { wire: await load(server, webRoot), close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
