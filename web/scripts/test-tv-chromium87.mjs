#!/usr/bin/env node

// Explicit, resource-heavy opt-in. Runs selected unchanged TV E2E tests against real M87
// Chromium in an amd64, network-isolated container. Only copied test inputs enter it, not the live workspace.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const execute = promisify(execFile);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const run = (command, args, options = {}) =>
  execute(command, args, { ...options, signal: controller.signal });
const runStreaming = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, signal: controller.signal, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.DEN_TV_CHROMIUM87_IMAGE ?? 'den-tv-chromium87:local';
const REVISION = '812859';
const SNAPSHOT_URL = `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${REVISION}/chrome-linux.zip`;
const SNAPSHOT_SHA256 = 'e8c00b766c50b57898c0084f41eac7642b527b591bd079dc8191d04352260b34';
const largeLibrary = process.env.DEN_TV_LIBRARY_STRESS_200 === '1';
const selected = [
  'tv-compatibility.spec.mjs',
  'tv-navigation.spec.mjs',
  'tv-home.spec.mjs',
  'tv-pairing.spec.mjs',
  'tv-retained-input.spec.mjs',
  'tv-detail-settings.spec.mjs',
  'tv-diagnostics.spec.mjs',
  'tv-library-stress.spec.mjs',
];
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
const port = process.env.DEN_TV_CHROMIUM87_PORT ?? (await freePort());
if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
  throw new Error(`Invalid DEN_TV_CHROMIUM87_PORT: ${port}`);
const output = `dist-tv-webos-e2e-${port}`;
await mkdir(resolve(WEB, 'test-results-tv'), { recursive: true });
const evidence = await mkdtemp(resolve(WEB, 'test-results-tv', `chromium87-${port}-`));
const buildOutput = join(WEB, output);
const temp = await mkdtemp(join(tmpdir(), 'den-m87-e2e-'));
const staging = join(temp, 'web');
const archive = join(temp, 'chrome-linux.zip');
const containerIdFile = join(temp, 'container.id');
let createdOutput = false;

try {
  // Exclusive reservation: never let Vite empty, or cleanup remove, another invocation's artifact directory.
  await mkdir(buildOutput);
  createdOutput = true;
  console.log(`Chromium 87 evidence: ${evidence}`);
  await runStreaming('npm', ['run', 'build:tv:webos'], {
    cwd: WEB,
    env: { ...process.env, DEN_TV_OUT_DIR: output, DEN_TV_E2E: '0', DEN_TV_PACKAGED: '0' },
  });
  await run('curl', ['--fail', '--location', '--retry', '2', '--output', archive, SNAPSHOT_URL]);
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (hash !== SNAPSHOT_SHA256) throw new Error(`Chromium snapshot SHA-256 mismatch: ${hash}`);
  await mkdir(join(staging, 'node_modules'), { recursive: true });
  await cp(join(WEB, 'e2e'), join(staging, 'e2e'), { recursive: true });
  await cp(join(WEB, output), join(staging, 'dist'), { recursive: true });
  for (const packageName of ['@playwright', 'playwright', 'playwright-core'])
    await cp(join(WEB, 'node_modules', packageName), join(staging, 'node_modules', packageName), {
      recursive: true,
    });
  await writeFile(
    join(staging, 'static-server.mjs'),
    `
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const root='/run/tv/dist';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml'};
createServer(async(q,r)=>{
  try {
    const pathname=decodeURIComponent(new URL(q.url,'http://127.0.0.1').pathname);
    let file=resolve(root,'.'+pathname);
    if(file!==root&&!file.startsWith(root+sep)){r.writeHead(403);r.end();return;}
    try {if((await stat(file)).isDirectory())file=resolve(file,'index.html');}
    catch {
      if(extname(pathname)){r.writeHead(404);r.end('Not found');return;}
      file=resolve(root,'index.html');
    }
    const body=await readFile(file);
    r.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','cache-control':'no-store'});
    r.end(body);
  } catch {r.writeHead(500);r.end('Fixture server error');}
}).listen(${port},'127.0.0.1');
`,
  );
  await writeFile(
    join(staging, 'chromium87.config.mjs'),
    `import { defineConfig } from '@playwright/test'; export default defineConfig({testDir:'./e2e',testMatch:${JSON.stringify(selected)},workers:1,timeout:120000,reporter:'line',outputDir:'/run/results/tests',use:{baseURL:'http://127.0.0.1:${port}',viewport:{width:1920,height:1080},trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{executablePath:'/run/chromium/chrome-linux/chrome',args:['--no-sandbox','--disable-dev-shm-usage']}},webServer:{command:'node /run/tv/static-server.mjs',url:'http://127.0.0.1:${port}/',reuseExistingServer:false}});`,
  );
  await writeFile(
    join(staging, 'run.mjs'),
    `
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const version=execFileSync('/run/chromium/chrome-linux/chrome',['--version'],{encoding:'utf8'}).trim();
console.log(version);
assert.equal(version,'Chromium 87.0.4280.0');
const result=spawnSync(process.execPath,['/run/tv/node_modules/@playwright/test/cli.js','test','--config','/run/tv/chromium87.config.mjs'],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
`,
  );
  await writeFile(
    join(evidence, 'runner.json'),
    JSON.stringify(
      {
        revision: REVISION,
        snapshotSha256: SNAPSHOT_SHA256,
        engine: '87.0.4280.0',
        selected,
        port,
        network: 'none',
        largeLibrary,
        tvCore: JSON.parse(await readFile(join(WEB, 'src/vendor/den-core-tv/SOURCE.json'), 'utf8')),
      },
      null,
      2,
    ) + '\n',
  );
  const imageContext = join(temp, 'image-context');
  await mkdir(imageContext, { recursive: true });
  await cp(join(WEB, 'scripts', 'chromium87.Dockerfile'), join(imageContext, 'Dockerfile'));
  await runStreaming('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    join(imageContext, 'Dockerfile'),
    '-t',
    IMAGE,
    imageContext,
  ]);
  await run('unzip', ['-q', archive, '-d', temp]);
  await runStreaming('docker', [
    'run',
    '--rm',
    '--cidfile',
    containerIdFile,
    '--name',
    `den-tv-chromium87-${process.pid}`,
    '--platform',
    'linux/amd64',
    '--network',
    'none',
    '--env',
    `E2E_PORT=${port}`,
    '--env',
    `DEN_TV_LIBRARY_STRESS_200=${largeLibrary ? '1' : ''}`,
    '-v',
    `${staging}:/run/tv:ro`,
    '-v',
    `${evidence}:/run/results`,
    '-v',
    `${join(temp, 'chrome-linux')}:/run/chromium/chrome-linux:ro`,
    IMAGE,
    'node',
    '/run/tv/run.mjs',
  ]);
} finally {
  const containerId = await readFile(containerIdFile, 'utf8').catch(() => '');
  if (/^[a-f0-9]{64}$/.test(containerId.trim()))
    await execute('docker', ['rm', '--force', containerId.trim()]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
  if (createdOutput) await rm(buildOutput, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(`Chromium 87 evidence retained: ${evidence}`);
}
