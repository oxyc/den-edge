// Single source of truth for the e2e dev server's port, so running two worktrees' e2e suites at
// once (each on its own port) can't have one reuse — and silently test against — the other's
// vite server.
//
// Playwright's config module is evaluated once in the runner process and re-evaluated in every
// worker process. This module picks the port (or reads E2E_PORT) exactly once — in the runner, on
// first import — and stamps it onto process.env.E2E_PORT, which every worker process inherits, so
// a run stays pinned to one port throughout.
import { createServer } from 'node:net';

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// CI always runs a single job on the default port; only local runs — where parallel worktrees are
// the problem — need a port picked automatically. An explicit E2E_PORT always wins, so parallel
// worktrees can also each pin their own.
if (!process.env.CI && !process.env.E2E_PORT) {
  process.env.E2E_PORT = String(await pickFreePort());
}

export const E2E_PORT = Number(process.env.E2E_PORT) || 5198;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
