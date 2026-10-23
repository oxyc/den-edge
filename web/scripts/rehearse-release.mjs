// `npm run rehearse:release`: a release reaches a browser on its first reload (den-edge#789). The real den-edge binary
// serves a build; real Chromium opens it and loads it once more, its hashed files now in its HTTP cache. Then the
// release: den-edge is stopped and started again on the same address with a second build, as a deploy restarts it,
// and the browser's first reload runs the second build. Nothing is routed in the browser, because Playwright's
// routing turns the HTTP cache off, and that cache is part of what is being tried.
//
// The two builds are the one `npm run build` made, each with a marker script of its own added to its shell, so the
// second is a release with its own shell and its own file, as a real one is. The load reports den-edge logs say where
// each load's script and Wasm files came from (`fileTally`, `loadReport.ts`): the second load of the first build from
// the cache.
//
// Needs `cargo build --locked` (or DEN_EDGE_BIN) and `npm run build` first.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as listen } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');
const BINARY = process.env.DEN_EDGE_BIN ?? join(ROOT, 'target/debug/den-edge');
const DIST = join(WEB, 'dist');
const KEEP = process.env.REHEARSE_KEEP === '1';

const fail = (message) => {
  console.error(`rehearse-release: ${message}`);
  process.exit(2);
};
if (!existsSync(BINARY)) fail(`no den-edge binary at ${BINARY}: run cargo build --locked`);
if (!existsSync(join(DIST, 'index.html'))) fail('no built web app: run npm run build in web/');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const work = mkdtempSync(join(tmpdir(), 'den-release-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/** The built app as release `name`: its shell runs `/assets/rehearse-release-<name>.js`, which names it. */
function release(name) {
  const web = join(work, `web-${name}`);
  cpSync(DIST, web, { recursive: true });
  writeFileSync(
    join(web, `assets/rehearse-release-${name}.js`),
    `globalThis.denRehearsedRelease = ${JSON.stringify(name)};\n`,
  );
  const shell = join(web, 'index.html');
  const html = readFileSync(shell, 'utf8');
  if (!html.includes('</head>')) fail('the built shell has no </head>');
  writeFileSync(
    shell,
    html.replace(
      '</head>',
      `<script type="module" src="/assets/rehearse-release-${name}.js"></script></head>`,
    ),
  );
  // The precompressed shell is of the original bytes; den-edge would not serve it, but leave no doubt.
  for (const sidecar of ['index.html.br', 'index.html.gz'])
    rmSync(join(web, sidecar), { force: true });
  return web;
}

const freePort = () =>
  new Promise((done) => {
    const probe = listen().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

/** den-edge serving `web` on `port`; its request log lines are kept in `log`. */
async function startEdge(web, port) {
  const log = [];
  const child = spawn(BINARY, [], {
    env: {
      PORT: String(port),
      DATA_DIR: join(work, 'edge-data'),
      LOG_REQUESTS: '1',
      WEB_DIR: web,
      WEB_HOSTS: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let buffered = '';
  child.stderr.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    log.push(...lines);
  });
  const exited = new Promise((done) => child.once('exit', done));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) fail(`den-edge exited ${child.exitCode}:\n${log.join('\n')}`);
    if (
      await fetch(`${origin}/health`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      const shell = await fetch(`${origin}/`);
      return {
        origin,
        log,
        release: shell.headers.get('x-den-release'),
        stop: async () => {
          child.kill();
          await exited;
        },
      };
    }
    await sleep(100);
  }
  fail('den-edge did not answer /health');
}

/** The load reports den-edge logged, as their tags. */
const loadReports = (edge) =>
  edge.log
    .filter((line) => line.includes('/playback/load'))
    .map((line) => line.match(/load=(\S+)/)?.[1] ?? line);

/** Wait until `edge` has logged `count` load reports, or give up after 15 s. */
async function reported(edge, count) {
  for (let i = 0; i < 150 && loadReports(edge).length < count; i += 1) await sleep(100);
  return loadReports(edge);
}

/** `files:cache<n>/net<n>/…` from a load report tag, as numbers. */
function files(tag, prefix = 'files') {
  const found = tag?.match(
    new RegExp(`(?:^|,)${prefix}:cache(\\d+)/net(\\d+)/sw(\\d+)/unknown(\\d+)`),
  );
  return found && { cache: +found[1], net: +found[2], sw: +found[3], unknown: +found[4] };
}

/** What the page on screen runs: its marker, the release its shell was (Server-Timing), and whether the app mounted. */
async function running(page) {
  await page.waitForFunction(() => 'denRehearsedRelease' in globalThis, null, { timeout: 30_000 });
  return page.evaluate(() => ({
    marker: globalThis.denRehearsedRelease,
    release: performance
      .getEntriesByType('navigation')[0]
      ?.serverTiming?.find((timing) => timing.name === 'den-release')?.description,
  }));
}

function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(system) ? system : undefined;
}

async function main() {
  const port = await freePort();
  const first = release('a');
  const second = release('b');
  // Nothing beyond den-edge is reached: an address that is not loopback does not resolve.
  const browser = await chromium.launch({
    executablePath: executablePath(),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const page = await browser.newPage();
  const mounted = [];
  page.on('console', (message) => {
    if (message.text().includes('app mounted')) mounted.push(Date.now());
  });
  /** Wait for the app on screen to mount (its `app mounted` milestone), then for its startup to settle. */
  const settled = async (count) => {
    for (let i = 0; i < 300 && mounted.length < count; i += 1) await sleep(100);
    await sleep(3000);
    return mounted.length >= count;
  };

  let edge = await startEdge(first, port);
  const edgeA = edge;
  try {
    await page.goto(`${edge.origin}/`);
    const opened = await running(page);
    check(
      'the first build is on screen',
      opened.marker === 'a' && opened.release === edge.release && (await settled(1)),
      JSON.stringify(opened),
    );

    await page.reload();
    const again = await running(page);
    check(
      'loaded again, it is still the first build',
      again.marker === 'a' && (await settled(2)),
      JSON.stringify(again),
    );
    const [firstReport] = await reported(edge, 1);
    check(
      'the first load fetched its script and Wasm files from the network',
      files(firstReport)?.net > 0 && files(firstReport)?.cache === 0,
      firstReport,
    );

    // The deploy.
    await edge.stop();
    edge = await startEdge(second, port);
    check(
      'the second build is a release of its own',
      edge.release && edge.release !== edgeA.release,
    );

    await page.reload();
    const after = await running(page);
    check(
      'the first reload after the deploy runs the second build',
      after.marker === 'b' && after.release === edge.release && (await settled(3)),
      JSON.stringify(after),
    );
    const [secondReport] = await reported(edge, 1);
    const cached = files(secondReport);
    check(
      'the second load of the first build took its script and Wasm files from the HTTP cache',
      cached?.cache > 0 && cached?.net === 0 && secondReport.includes(`release:${edgeA.release}`),
      secondReport,
    );
    await page.goto('about:blank');
    const [, thirdReport] = await reported(edge, 2);
    check(
      'the reload onto the second build reports it, and fetched its new file from the network',
      thirdReport?.includes(`release:${edge.release}`) && files(thirdReport)?.net >= 1,
      thirdReport,
    );
  } finally {
    writeFileSync(
      join(work, 'den-edge.log'),
      [...edgeA.log, ...(edge === edgeA ? [] : edge.log)].join('\n'),
    );
    await browser.close();
    await edge.stop();
  }
}

try {
  await main();
} catch (error) {
  check('the rehearsal ran to the end', false, String(error?.stack ?? error));
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length ? 'REHEARSAL FAILED' : 'REHEARSAL PASSED'}: ${results.length - failed.length}/${results.length} checks`,
);
if (failed.length || KEEP) console.log(`den-edge log kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
