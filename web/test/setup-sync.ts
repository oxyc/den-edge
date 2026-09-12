import { readFileSync } from 'node:fs';
import { initialize } from '../src/vendor/den-core/index.js';

// Node has no HTTP origin. Exercise the real separately packaged WASM without a browser fetch.
await initialize(readFileSync(new URL('../src/vendor/den-core/generated/den_core_bg.wasm', import.meta.url)));
