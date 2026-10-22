import { readFileSync } from 'node:fs';
import { initialize } from '../src/vendor/den-core/index.js';
import { initializeAssistant } from '../src/vendor/den-core/assistant.js';
import { initializeRecovery } from '../src/vendor/den-core/recovery.js';

// Node has no HTTP origin. Exercise the real separately packaged WASM without a browser fetch.
await initialize(
  readFileSync(new URL('../src/vendor/den-core/generated/den_core_bg.wasm', import.meta.url)),
);
// The assistant ops' module, loaded in the app only when needed (`assistantCore.ts`), is ready here from the start.
await initializeAssistant(
  readFileSync(
    new URL('../src/vendor/den-core/generated/den_core_assistant_bg.wasm', import.meta.url),
  ),
);
// Recovery's KDF is another lazy production module; tests initialize its real bytes explicitly because Node has no
// HTTP origin from which its dynamic capability loader could fetch them.
await initializeRecovery(
  readFileSync(
    new URL('../src/vendor/den-core/generated/den_core_recovery_bg.wasm', import.meta.url),
  ),
);
