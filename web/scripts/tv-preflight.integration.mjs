#!/usr/bin/env node

// A local fixture verifies the preflight's useful network path without touching a real backend,
// tunnel, DNS record, credential, or TV. Its output is also checked for token redaction.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function run(executable, args, options) {
  try {
    return { status: 0, ...(await execute(executable, args, { ...options, timeout: 20_000 })) };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const server = createServer((request, response) => {
  const mode = process.env.TV_PREFLIGHT_FIXTURE ?? 'ok';
  const cors =
    mode === 'nocors' ? {} : { 'access-control-allow-origin': 'https://tv.example.test' };
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html', ...cors });
    response.end(
      mode === 'login'
        ? '<!doctype html><html><body>Sign in</body></html>'
        : '<!doctype html><html><head><title>Den TV</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
    );
    return;
  }
  if (request.url === '/assets/app.js') {
    response.writeHead(200, {
      'content-type': mode === 'module-html' ? 'text/html' : 'text/javascript',
    });
    response.end(
      mode === 'module-html' ? '<html>Login</html>' : 'export const tvPreflight = true;',
    );
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, {
      'content-type': 'application/json',
      ...cors,
    });
    response.end(mode === 'health-html' ? '<html>Login</html>' : '{"status":"ok"}');
    return;
  }
  if (request.url?.startsWith('/media/')) {
    response.writeHead(206, {
      'content-type': 'application/vnd.apple.mpegurl',
      ...cors,
      'content-range': 'bytes 0-20/21',
    });
    response.end('#EXTM3U\n#EXT-X-VERSION:3\n');
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port');
const origin = `http://127.0.0.1:${address.port}`;
try {
  const result = await run(
    process.execPath,
    [
      'scripts/tv-preflight.mjs',
      '--url',
      'https://tv.example.test/',
      '--entry-url',
      `${origin}/`,
      '--edge',
      origin,
      '--media-url',
      `${origin}/media/master.m3u8?token=never-print-this`,
      '--json',
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'preflight failed');
  const report = JSON.parse(result.stdout);
  if (!report.ok || report.checks.filter(({ status }) => status === 'pass').length !== 8)
    throw new Error(`unexpected preflight report: ${result.stdout}`);
  if (result.stdout.includes('never-print-this') || result.stdout.includes('/media/master.m3u8'))
    throw new Error('preflight output leaked a media URL or token');
  process.env.TV_PREFLIGHT_FIXTURE = 'login';
  const login = await run(
    process.execPath,
    [
      'scripts/tv-preflight.mjs',
      '--url',
      'https://tv.example.test/',
      '--entry-url',
      `${origin}/`,
      '--edge',
      origin,
      '--json',
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  if (login.status === 0 || !login.stdout.includes('entry does not expose a module script'))
    throw new Error('preflight accepted a login HTML entry');
  process.env.TV_PREFLIGHT_FIXTURE = 'nocors';
  const cors = await run(
    process.execPath,
    [
      'scripts/tv-preflight.mjs',
      '--url',
      'https://tv.example.test/',
      '--entry-url',
      `${origin}/`,
      '--edge',
      origin,
      '--media-url',
      `${origin}/media/master.m3u8?token=never-print-this`,
      '--json',
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  if (cors.status === 0 || !cors.stdout.includes('CORS header missing'))
    throw new Error('preflight accepted a response without CORS');
  for (const [mode, reason] of [
    ['health-html', 'response is not a healthy Den Edge'],
    ['module-html', 'module request returned HTML instead of JavaScript'],
  ]) {
    process.env.TV_PREFLIGHT_FIXTURE = mode;
    const rejected = await run(
      process.execPath,
      [
        'scripts/tv-preflight.mjs',
        '--url',
        'https://tv.example.test/',
        '--entry-url',
        `${origin}/`,
        '--edge',
        origin,
        '--json',
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    if (rejected.status === 0 || !rejected.stdout.includes(reason))
      throw new Error(`preflight accepted ${mode}`);
  }
  console.log(
    'TV preflight integration passed: hostname, edge health, CORS and HLS readiness were checked with redacted output.',
  );
} finally {
  server.close();
}
