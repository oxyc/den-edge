import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, normalize } from 'node:path';
import { chromium } from '@playwright/test';

const dist = new URL('../dist/', import.meta.url);
const workerNames = (await readdir(new URL('assets/', dist))).filter(
  (name) => name.startsWith('libraryServiceWorker-') && name.endsWith('.js'),
);
assert.equal(workerNames.length, 1, 'expected one built library service worker');

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/blank.html') {
      response.setHeader('content-type', types.get('.html'));
      response.end('<!doctype html><title>Worker test</title>');
      return;
    }
    const relative = normalize(pathname).replace(/^[/\\]+/, '');
    const body = await readFile(new URL(relative, dist));
    response.setHeader('content-type', types.get(extname(relative)) ?? 'application/octet-stream');
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const workerPath = `/assets/${workerNames[0]}`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/blank.html`);

  const local = await page.evaluate(async (workerPath) => {
    const libraryKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const open = () => {
      const worker = new globalThis.Worker(workerPath, { type: 'module' });
      const pending = new Map();
      const updates = new Map();
      let failure;
      worker.addEventListener('error', (event) => {
        failure = new Error(event.message || 'library service worker failed');
        for (const { reject, timer } of pending.values()) {
          clearTimeout(timer);
          reject(failure);
        }
        pending.clear();
      });
      worker.addEventListener('message', (event) => {
        for (const message of event.data) {
          if (message.type === 'update') updates.set(message.subscriptionId, message.value);
          if (message.requestId && pending.has(message.requestId)) {
            const request = pending.get(message.requestId);
            clearTimeout(request.timer);
            pending.delete(message.requestId);
            if (message.type === request.expectedType) request.resolve(message);
            else
              request.reject(
                new Error(
                  `library service answered ${message.type}, expected ${request.expectedType}: ${JSON.stringify(message)}`,
                ),
              );
          }
        }
      });
      const send = (message, expectedType) => {
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(message.requestId);
            reject(new Error(`library service request timed out: ${message.type}`));
          }, 10_000);
          pending.set(message.requestId, { resolve, reject, timer, expectedType });
          worker.postMessage(message);
        });
      };
      return { worker, send, updates };
    };
    let request = 0;
    let protocol = 0;
    const message = (body) => ({ protocol, requestId: `request-${++request}`, ...body });
    const first = open();
    const mismatch = await first.send(
      message({ type: 'hello', clientId: 'protocol-probe', libraryKey, mode: 'local' }),
      'error',
    );
    protocol = mismatch.error.expectedProtocol;
    await first.send(
      message({ type: 'hello', clientId: 'seed', libraryKey, mode: 'local' }),
      'ready',
    );
    const command = (operationId, command) =>
      first.send(message({ type: 'command', operationId, command }), 'command-result');
    await command('watchlist', {
      kind: 'watchlist.add',
      title: { type: 'movie', id: 617126 },
    });
    await command('progress', {
      kind: 'progress.record',
      title: { type: 'movie', id: 550 },
      fraction: 0.4,
      seconds: 240,
      observedAt: 5_000,
    });
    await command('dismiss-continue', {
      kind: 'continue-dismissed.set',
      title: { type: 'movie', id: 550 },
      dismissed: true,
    });
    await command('visible-progress', {
      kind: 'progress.record',
      title: { type: 'movie', id: 551 },
      fraction: 0.3,
      seconds: 180,
      observedAt: 6_000,
    });
    await command('watched', {
      kind: 'watched.set',
      title: { type: 'movie', id: 680 },
      watched: true,
    });
    await command('settings', {
      kind: 'preferences.patch',
      patch: { hideAnime: true },
    });
    first.worker.terminate();

    const reopened = open();
    await reopened.send(
      message({ type: 'hello', clientId: 'reader', libraryKey, mode: 'local' }),
      'ready',
    );
    for (const kind of ['overview', 'continue', 'settings', 'history']) {
      const subscriptionId = `subscription-${kind}`;
      await reopened.send(
        message({ type: 'subscribe', subscriptionId, selection: { kind } }),
        'subscribed',
      );
    }
    reopened.worker.terminate();
    return Object.fromEntries(reopened.updates);
  }, workerPath);

  assert.deepEqual(local['subscription-overview'].watchlist, [{ type: 'movie', id: 617126 }]);
  assert.deepEqual(local['subscription-continue'].items[0]?.title, {
    type: 'movie',
    id: 551,
  });
  assert.equal(
    local['subscription-continue'].items.some(({ title }) => title.id === 550),
    false,
  );
  assert.equal(local['subscription-settings'].preferences.hideAnime, true);
  assert.deepEqual(local['subscription-history'].items[0]?.title, {
    type: 'movie',
    id: 680,
  });
  console.log('built library service worker: encrypted local reopen and selectors passed');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
