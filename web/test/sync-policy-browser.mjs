// Production CSP smoke test against the actual vendored browser module, including fully offline calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const serverSource = await readFile(new URL('../../src/web.rs', import.meta.url), 'utf8');
const literal = serverSource.match(/"default-src[\s\S]+?form-action 'self'"/)?.[0];
assert.ok(literal, 'read the actual production CSP');
const csp = literal.slice(1, -1).replace(/\\\s*\n\s*/g, '').replaceAll('{remux}', '');
const fixture = JSON.parse(await readFile(new URL('../src/vendor/den-core/policy-v1.json', import.meta.url), 'utf8'));
const requests = fixture.cases.filter((c) => ['capture seen', 'derive seen command', 'negative historical time'].includes(c.name));
const harness = `import { evaluate } from '/core/index.js';
window.runSync = () => JSON.parse(evaluate(JSON.stringify({op:'issue',last:[5000,2,'peer'],now:2000,device:'web'})));
try { const start=performance.now(); window.result = window.runSync(); window.initMs=performance.now()-start; } catch (error) { window.failure = String(error); }
window.benchmark = () => ${JSON.stringify(requests)}.map(test => {
  const start=performance.now(), count=10000;
  for(let i=0;i<count;i++) JSON.parse(evaluate(JSON.stringify(test.request)));
  return {operation:test.name, count, totalMs:performance.now()-start};
});`;
const html = '<!doctype html><meta charset="utf-8"><script type="module" src="/harness.js"></script>';
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/' || path === '/blocked') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': path === '/blocked' ? csp.replace(" 'wasm-unsafe-eval'", '') : csp });
      response.end(html);
    } else if (path === '/harness.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(harness);
    } else if (/^\/core\/(index|generated\/(den_core|wasm-data))\.js$/.test(path)) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
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
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => window.result || window.failure);
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(await page.evaluate(() => window.result), {version:1,ok:[5000,3,'web']});
  console.log(JSON.stringify(await page.evaluate(() => ({initMs:window.initMs, operations:window.benchmark()}))));
  await context.setOffline(true);
  assert.deepEqual(await page.evaluate(() => window.runSync()), {version:1,ok:[5000,3,'web']});
  await context.close();
  const blocked = await browser.newPage();
  await blocked.goto(`${origin}/blocked`);
  await blocked.waitForFunction(() => window.failure);
  assert.match(await blocked.evaluate(() => window.failure), /CompileError|Wasm|WebAssembly/i);
  console.log('PASS: production CSP permits local WASM; offline calls work; old CSP correctly blocks it.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
