// Production CSP smoke test against the actual vendored browser module, including fully offline calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import ts from 'typescript';

const serverSource = await readFile(new URL('../../src/web.rs', import.meta.url), 'utf8');
const literal = serverSource.match(/"default-src[\s\S]+?form-action 'self'"/)?.[0];
assert.ok(literal, 'read the actual production CSP');
const csp = literal.slice(1, -1).replace(/\\\s*\n\s*/g, '').replaceAll('{remux}', '');
const fixture = JSON.parse(await readFile(new URL('../src/vendor/den-core/policy-v1.json', import.meta.url), 'utf8'));
const requests = fixture.cases.filter((c) => ['capture seen', 'derive seen command', 'negative historical time'].includes(c.name));
const loader = ts.transpile(await readFile(new URL('../src/lib/syncLoader.ts', import.meta.url), 'utf8'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
}).replace('../vendor/den-core/index.js', '/core/index.js');
const harness = `import { evaluate } from '/core/index.js';
import { ensureSyncPolicy, preloadSyncPolicy } from '/loader.js';
window.preloadSync = preloadSyncPolicy;
window.runSync = async () => { await ensureSyncPolicy(); return JSON.parse(evaluate(JSON.stringify({op:'issue',last:[5000,2,'peer'],now:2000,device:'web'}))); };
window.harnessReady = true;
window.benchmark = () => ${JSON.stringify(requests)}.map(test => {
  const start=performance.now(), count=10000;
  for(let i=0;i<count;i++) JSON.parse(evaluate(JSON.stringify(test.request)));
  return {operation:test.name, count, totalMs:performance.now()-start};
});`;
const html = '<!doctype html><meta charset="utf-8"><script type="module" src="/harness.js"></script>';
let downloads = 0;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/' || path === '/blocked') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': path === '/blocked' ? csp.replace(" 'wasm-unsafe-eval'", '') : csp });
      response.end(html);
    } else if (path === '/harness.js' || path === '/loader.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(path === '/loader.js' ? loader : harness);
    } else if (/^\/core\/(index\.js|generated\/den_core(?:\.js|_bg\.wasm))$/.test(path)) {
      const wasm = path.endsWith('.wasm');
      if (wasm) downloads++;
      response.writeHead(200, { 'content-type': wasm ? 'application/wasm' : 'text/javascript',
        ...(wasm ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}) });
      response.end(await readFile(new URL(`../src/vendor/den-core/${path.slice(6)}`, import.meta.url)));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ headless: true,
    channel: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'chrome' : undefined });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.requestIdleCallback = callback => { window.idleWork = callback; return 1; };
    window.cancelIdleCallback = () => { window.idleWork = undefined; };
  });
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => window.harnessReady);
  await page.evaluate(() => window.preloadSync());
  assert.equal(downloads, 0, 'idle work has not fetched yet');
  const expected = {version:1,ok:[5000,3,'web']};
  assert.deepEqual(await page.evaluate(() => Promise.all([window.runSync(), window.runSync()])), [expected, expected]);
  assert.equal(downloads, 1, 'early concurrent actions share one request');
  console.log(JSON.stringify(await page.evaluate(() => ({ operations:window.benchmark() }))));
  await context.setOffline(true);
  assert.deepEqual(await page.evaluate(() => window.runSync()), {version:1,ok:[5000,3,'web']});
  await context.close();
  const idlePage = await browser.newPage();
  await idlePage.addInitScript(() => {
    window.requestIdleCallback = callback => { window.idleWork = callback; return 1; };
    window.cancelIdleCallback = () => {};
  });
  await idlePage.goto(origin); await idlePage.waitForFunction(() => window.harnessReady);
  await idlePage.evaluate(() => { window.preloadSync(); window.idleWork(); });
  assert.deepEqual(await idlePage.evaluate(() => window.runSync()), expected);

  const retry = await browser.newPage();
  let attempts = 0;
  await retry.route('**/*.wasm', route => ++attempts === 1 ? route.fulfill({status:503,body:'unavailable'}) : route.continue());
  await retry.goto(origin); await retry.waitForFunction(() => window.harnessReady);
  assert.equal(await retry.evaluate(() => window.runSync().then(() => false, () => true)), true);
  assert.deepEqual(await retry.evaluate(() => window.runSync()), expected);
  assert.equal(attempts, 2, 'failed loads retry without reloading the page');
  const blocked = await browser.newPage();
  await blocked.goto(`${origin}/blocked`);
  await blocked.waitForFunction(() => window.harnessReady);
  const error = await blocked.evaluate(() => window.runSync().then(() => '', error => String(error)));
  assert.match(error, /CompileError|Wasm|WebAssembly/i);
  console.log('PASS: idle preload, early-action single-flight, async WASM, offline calls, retry, and CSP negative control.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
