// Real native↔browser household qualification for den#550. This orchestration deliberately keeps only provider
// metadata/media synthetic: the browser is the built app with its Wasm Worker/IndexedDB/crypto, native is the real
// DenMobile process with UniFFI/Keychain/SQLite, and both talk to one isolated persistent den-edge store.
//
// This is opt-in because it builds/launches an iOS Simulator host. See den's
// `docs/qualification/native-browser-profile-sync.md` for the exact prerequisites and retained evidence.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, globSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launch,
  metadataFixture,
  prepareCrossHostFixture,
  readLibrary,
  startEdge,
} from './rehearse-household.mjs';
import {
  cleanupNativeIfReady,
  nativeBuildArguments,
  nativeTestArguments,
  prepareInjectedXCTestRun,
  waitForNativeReady,
} from './rehearse-native-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE = resolve(process.env.DEN_NATIVE_ROOT ?? join(ROOT, '../den'));
const DESTINATION = process.env.DEN_IOS_DESTINATION;
const SIMULATOR_ID = DESTINATION?.match(/(?:^|,)id=([^,]+)/)?.[1];
const MOBILE_BUNDLE_ID = process.env.DEN_MOBILE_BUNDLE_IDENTIFIER ?? 'fi.oxy.den';
const KEEP = process.env.REHEARSE_KEEP === '1';
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

if (process.env.DEN_CROSS_HOST !== '1')
  throw new Error('set DEN_CROSS_HOST=1 to run the cross-host rehearsal');
if (!DESTINATION)
  throw new Error('DEN_IOS_DESTINATION must be an exact available iOS Simulator destination');
if (!SIMULATOR_ID)
  throw new Error(
    'DEN_IOS_DESTINATION must include the exact Simulator id=<UDID> for store qualification',
  );

// Do not allocate retained evidence until every argument that can be checked without side effects
// is valid.
const work = mkdtempSync(join(tmpdir(), 'den-cross-host-'));

const eventually = async (description, predicate, timeout = 45_000) => {
  const deadline = Date.now() + timeout;
  let detail;
  while (Date.now() < deadline) {
    try {
      detail = await predicate();
      if (detail) return detail;
    } catch (error) {
      detail = String(error);
    }
    await sleep(250);
  }
  throw new Error(`${description} did not converge: ${detail ?? 'no observation'}`);
};

const watchlisted = (rows) =>
  rows.some(
    (row) =>
      row.kind === 'title' &&
      row.title?.type === 'movie' &&
      row.title?.id === 1002 &&
      row.status?.value === 'watchlist' &&
      !row.deleted?.value,
  );

function nativeCoordinator(configuration, edgeOrigin) {
  let sequence = 0;
  let seeded = false;
  let cleanup = false;
  const commands = [];
  const waiters = [];
  const results = new Map();
  const resultWaiters = new Map();
  const readyWaiters = new Set();
  let readyResult;
  const accessPath = `/run/${randomUUID()}`;
  let origin;

  const answerNext = () => {
    while (waiters.length) {
      const { response, after, timer } = waiters[0];
      const command = commands.find((candidate) => candidate.sequence > after);
      if (!command) break;
      waiters.shift();
      clearTimeout(timer);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(command));
    }
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== accessPath && !url.pathname.startsWith(`${accessPath}/`)) {
      response.writeHead(404).end();
      return;
    }
    const path = url.pathname.slice(accessPath.length) || '/';
    if (request.method === 'GET' && path === '/configuration') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ...configuration, edgeURL: origin, seedSession: !seeded, cleanup }),
      );
      seeded = true;
      return;
    }
    if (request.method === 'GET' && path === '/native/next') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const command = commands.find((candidate) => candidate.sequence > after);
      if (command) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(command));
      } else {
        const entry = { response, after, timer: null };
        waiters.push(entry);
        entry.timer = setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index !== -1) waiters.splice(index, 1);
          if (!response.writableEnded) response.writeHead(204).end();
        }, 55_000);
      }
      return;
    }
    if (request.method === 'POST' && path === '/native/result') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      results.set(result.sequence, result);
      if (result.sequence === 0) {
        readyResult = result;
        for (const waiter of readyWaiters) waiter(result);
        readyWaiters.clear();
      }
      const waiting = resultWaiters.get(result.sequence);
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.done(result);
      }
      resultWaiters.delete(result.sequence);
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && path === '/native/cleanup') {
      cleanup = true;
      response.writeHead(204).end();
      return;
    }
    if (path.startsWith('/tmdb/3/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(metadataFixture(`${origin}${path}${url.search}`)));
      return;
    }
    if (path === '/atlas/manifest.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'com.den.atlas', name: 'atlas', version: '0.0.0' }));
      return;
    }
    if (path.startsWith('/atlas/index/title/movie/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ minimumAge: 0 }));
      return;
    }
    if (path.startsWith('/atlas/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const upstream = await fetch(`${edgeOrigin()}${path}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
      });
      const responseHeaders = Object.fromEntries(upstream.headers);
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'qualification_edge_unavailable' }));
    }
  });

  return {
    start: () =>
      new Promise((done) =>
        server.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${server.address().port}${accessPath}`;
          done(origin);
        }),
      ),
    close: () => new Promise((done) => server.close(done)),
    command: async (action, { target, value, timeoutSeconds } = {}) => {
      sequence += 1;
      const command = { sequence, action, target, value, timeoutSeconds };
      commands.push(command);
      answerNext();
      const result =
        results.get(sequence) ??
        (await new Promise((done, reject) => {
          const timer = setTimeout(() => {
            resultWaiters.delete(sequence);
            reject(new Error(`native command ${sequence} ${action} timed out`));
          }, 90_000);
          resultWaiters.set(sequence, { done, timer });
        }));
      if (result.status !== 'passed')
        throw new Error(`native ${action} failed: ${result.detail ?? 'no detail'}`);
      return result;
    },
    subscribeReady: (waiter) => {
      if (readyResult) waiter(readyResult);
      else readyWaiters.add(waiter);
      return () => readyWaiters.delete(waiter);
    },
  };
}

async function runNative(origin) {
  const spawnRun = (arguments_) => {
    const child = spawn('xcodebuild', arguments_, {
      cwd: NATIVE,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exited = new Promise((done) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        done(result);
      };
      child.once('error', (error) => settle({ code: null, error, signal: null }));
      child.once('exit', (code, signal) => settle({ code, error: null, signal }));
    });
    return { child, exited };
  };
  const derivedDataPath = join(work, 'DerivedData');
  const build = spawnRun(
    nativeBuildArguments({
      derivedDataPath,
      destination: DESTINATION,
      sourcePackagesPath:
        process.env.DEN_SOURCE_PACKAGES ??
        join(homedir(), '.cache/den/SourcePackages/c3401eef9198'),
    }),
  );
  const buildResult = await build.exited;
  if (buildResult.error)
    throw new Error(`native build-for-testing failed to start: ${buildResult.error.message}`);
  if (buildResult.signal)
    throw new Error(`native build-for-testing exited via ${buildResult.signal}`);
  if (buildResult.code !== 0)
    throw new Error(`native build-for-testing exited ${buildResult.code}`);

  const runs = globSync('**/*.xctestrun', {
    cwd: join(derivedDataPath, 'Build/Products'),
    absolute: true,
  });
  if (runs.length !== 1) throw new Error(`build produced ${runs.length} xctestrun files`);
  const canonicalPath = runs[0];
  const injectedPath = join(work, 'NativeCrossHost.xctestrun');
  const temporaryJSON = join(work, 'NativeCrossHost.xctestrun.json');
  prepareInjectedXCTestRun({
    canonicalPath,
    injectedPath,
    origin,
    temporaryJSONPath: temporaryJSON,
  });

  return spawnRun(
    nativeTestArguments({
      destination: DESTINATION,
      resultBundlePath: join(work, 'NativeCrossHost.xcresult'),
      xctestrunPath: injectedPath,
    }),
  );
}

async function switchBrowserTo(page, name, pin) {
  await page.locator('button.profile-trigger').first().click();
  await page.getByRole('button', { name: `Use ${name}` }).click();
  if (pin) {
    const field = page.locator('#owner-pin');
    if (await field.isVisible().catch(() => false)) await field.fill(pin);
  }
  await page
    .locator(`button.profile-trigger[aria-label*="current ${name}"]`)
    .first()
    .waitFor({ timeout: 30_000 });
}

async function main() {
  let fixture;
  let coordinator;
  let native;
  let nativeReady = false;
  let nativeCleaned = false;
  let succeeded = false;
  let blockedStore;
  try {
    fixture = await prepareCrossHostFixture({ root: work });
    await switchBrowserTo(fixture.page, 'Owner', fixture.pin);
    const directory = fixture.household.directory;
    const owner = directory.profiles[directory.owner];
    const runID = `cross-host-${randomUUID().toLowerCase()}`;
    coordinator = nativeCoordinator(
      {
        runID,
        household: {
          version: 3,
          origin: 'recovered',
          libraryKey: fixture.kept.householdKey,
        },
      },
      () => fixture.edge.origin,
    );
    const coordinatorOrigin = await coordinator.start();
    native = await runNative(coordinatorOrigin);
    await waitForNativeReady(native, coordinator);
    nativeReady = true;

    // Browser → native: persisted Owner activity renders in the real native accessibility tree.
    await coordinator.command('switch-profile', {
      target: `profile_card_${directory.owner}`,
      value: fixture.pin,
    });
    await coordinator.command('open-url', { value: 'den://media/movie/1002' });
    await coordinator.command('wait', { target: 'mobile_detail_watchlist' });
    const initial = await coordinator.command('snapshot', { target: 'mobile_detail_watchlist' });
    if (!initial.detail?.includes('label=Remove from Watchlist')) {
      throw new Error(`native did not render browser Watchlist state: ${initial.detail}`);
    }

    // Native → browser: the native control writes through UniFFI/SQLite/Edge; the browser reload reads the same row.
    await coordinator.command('tap', { target: 'mobile_detail_watchlist' });
    await eventually('native removal persisted', async () => {
      const library = await readLibrary(fixture.edge, fixture.wire, owner.library.value.key);
      return !watchlisted(library.rows);
    });
    await fixture.page.reload();
    await fixture.page.getByRole('heading', { name: 'Movie 1002', level: 1 }).waitFor();
    if (
      (await fixture.page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed')) !== 'false'
    )
      throw new Error('browser did not render native removal');

    // Lost response: Edge commits a browser write, the browser observes a transport failure, then readback converges.
    const ownerKeys = await fixture.wire.deriveKeys(Buffer.from(owner.library.value.key, 'base64'));
    const ownerBatch = `/lib/${ownerKeys.id}/batch`;
    const ownerBatchMatch = {
      method: 'POST',
      pathname: ownerBatch,
      token: ownerKeys.token,
      wire: '5',
    };
    const dropped = fixture.browserProxy.dropNext(ownerBatchMatch);
    await fixture.page.getByRole('button', { name: 'Watchlist', exact: true }).click();
    await dropped.matched;
    await eventually('lost-response write read back', async () => {
      const library = await readLibrary(fixture.edge, fixture.wire, owner.library.value.key);
      return watchlisted(library.rows);
    });
    await fixture.page.reload();
    await fixture.page.getByRole('button', { name: 'Watchlist', exact: true }).waitFor();
    if (
      (await fixture.page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed')) !== 'true'
    )
      throw new Error('browser did not render the committed lost-response readback');

    // Profile isolation and held replacement: an Owner write held at transport cannot become Kid activity.
    const held = fixture.browserProxy.holdNext(ownerBatchMatch);
    const ownerMutation = fixture.page
      .getByRole('button', { name: 'Watchlist', exact: true })
      .click();
    await held.matched;
    await switchBrowserTo(fixture.page, 'Kids');
    held.release();
    await ownerMutation.catch(() => {});
    const ownerAfterHeld = await readLibrary(fixture.edge, fixture.wire, owner.library.value.key);
    const ownerHeldWatchlisted = watchlisted(ownerAfterHeld.rows);
    const kidLibrary = await readLibrary(fixture.edge, fixture.wire, fixture.kid.library.value.key);
    if (watchlisted(kidLibrary.rows))
      throw new Error('held Owner mutation crossed into Kid activity');
    await coordinator.command('switch-profile', { target: `profile_card_${fixture.kid.id}` });
    await coordinator.command('open-url', { value: 'den://media/movie/1002' });
    const kidState = await coordinator.command('snapshot', { target: 'mobile_detail_watchlist' });
    if (!kidState.detail?.includes('label=Add to Watchlist'))
      throw new Error('native Kid rendered Owner Watchlist state');

    // Remote/store outage and explicit Retry: no helper writes; the production native action owns recovery/readback.
    await coordinator.command('switch-profile', {
      target: `profile_card_${directory.owner}`,
      value: fixture.pin,
    });
    await coordinator.command('open-url', { value: 'den://media/movie/1002' });
    const heldOwnerState = await coordinator.command('snapshot', {
      target: 'mobile_detail_watchlist',
    });
    const expectedHeldLabel = ownerHeldWatchlisted ? 'Remove from Watchlist' : 'Add to Watchlist';
    if (!heldOwnerState.detail?.includes(`label=${expectedHeldLabel}`))
      throw new Error('native Owner did not render the held mutation durable outcome');
    const oldEdge = fixture.edge;
    await oldEdge.stop();
    await coordinator.command('tap', { target: 'mobile_detail_watchlist' });
    await coordinator.command('wait', {
      target: 'mobile_title_mutation_retry',
      timeoutSeconds: 30,
    });
    fixture.edge = await startEdge(oldEdge.dataDir, 'visitors', { port: oldEdge.port });
    await coordinator.command('tap', { target: 'mobile_title_mutation_retry' });
    await eventually('native Retry persisted after service restart', async () => {
      const library = await readLibrary(fixture.edge, fixture.wire, owner.library.value.key);
      return watchlisted(library.rows) === !ownerHeldWatchlisted;
    });

    // A real protected SQLite namespace is unavailable at open. Restore it, then recover through the mounted Retry.
    await coordinator.command('terminate');
    const container = execFileSync(
      'xcrun',
      ['simctl', 'get_app_container', SIMULATOR_ID, MOBILE_BUNDLE_ID, 'data'],
      { encoding: 'utf8' },
    ).trim();
    const blockedStorePath = join(
      container,
      'Library',
      'Application Support',
      'CrossHostQualification',
      runID,
      'Paired',
    );
    blockedStore = { path: blockedStorePath, mode: statSync(blockedStorePath).mode & 0o777 };
    chmodSync(blockedStore.path, 0o000);
    await coordinator.command('relaunch');
    await coordinator.command('wait-button', { target: 'Retry', timeoutSeconds: 30 });
    chmodSync(blockedStore.path, blockedStore.mode);
    blockedStore = null;
    await coordinator.command('tap-button', { target: 'Retry' });
    await coordinator.command('wait', { target: 'active_profile_button', timeoutSeconds: 45 });

    // Both host processes restart against the same stores. Keychain/SQLite and IndexedDB must render the readback.
    await switchBrowserTo(fixture.page, 'Owner', fixture.pin);
    await fixture.context.close();
    fixture.context = await launch(fixture.browserDirectory);
    fixture.page = fixture.context.pages()[0] ?? (await fixture.context.newPage());
    await fixture.page.goto(`${fixture.browserOrigin}/movie/1002`);
    await fixture.page.getByRole('heading', { name: 'Movie 1002', level: 1 }).waitFor();
    const expectedFinalWatchlist = !ownerHeldWatchlisted;
    if (
      (await fixture.page
        .getByRole('button', { name: 'Watchlist', exact: true })
        .getAttribute('aria-pressed')) !== String(expectedFinalWatchlist)
    )
      throw new Error('restarted browser did not render the durable Owner outcome');
    await coordinator.command('relaunch');
    await coordinator.command('wait', { target: 'active_profile_button', timeoutSeconds: 45 });
    await coordinator.command('open-url', { value: 'den://media/movie/1002' });
    const restartedNative = await coordinator.command('snapshot', {
      target: 'mobile_detail_watchlist',
    });
    const expectedFinalLabel = expectedFinalWatchlist
      ? 'Remove from Watchlist'
      : 'Add to Watchlist';
    if (!restartedNative.detail?.includes(`label=${expectedFinalLabel}`))
      throw new Error('restarted native host did not render the durable Owner outcome');

    const household = await readLibrary(fixture.edge, fixture.wire, fixture.kept.householdKey);
    if (household.wireMin !== 5) throw new Error(`unexpected wire generation ${household.wireMin}`);
    const householdKeys = await fixture.wire.deriveKeys(
      Buffer.from(fixture.kept.householdKey, 'base64'),
    );
    const oldWire = await fetch(`${fixture.edge.origin}/lib/${household.id}/changes?since=0`, {
      headers: { 'x-den-wire': '4', 'x-den-library-token': householdKeys.token },
    });
    if (oldWire.status !== 426 || oldWire.headers.get('x-den-wire-min') !== '5')
      throw new Error('service did not enforce wire generation 5');

    // KEEP retains only host-side evidence. Native state is always removed through the mounted production cleanup
    // seam, so preserving an xcresult can never strand this run's Keychain or Application Support namespace.
    await coordinator.command('cleanup', { timeoutSeconds: 45 });
    nativeCleaned = true;
    await coordinator.command('finish');
    const nativeExit = await native.exited;
    if (nativeExit.error) throw new Error(`native xcodebuild failed to start: ${nativeExit.error}`);
    if (nativeExit.code !== 0) throw new Error(`native xcodebuild exited ${nativeExit.code}`);
    succeeded = true;
    console.log(
      KEEP
        ? `PASS native↔browser cross-host qualification; evidence retained under ${work}`
        : 'PASS native↔browser cross-host qualification; isolated artifacts verified and removed',
    );
  } finally {
    if (blockedStore) {
      try {
        chmodSync(blockedStore.path, blockedStore.mode);
      } catch (error) {
        console.error(`failed to restore blocked native store permissions: ${String(error)}`);
      }
    }
    if (coordinator && !nativeCleaned) {
      try {
        nativeCleaned = await cleanupNativeIfReady({
          coordinator,
          native,
          ready: nativeReady,
          cleaned: nativeCleaned,
        });
      } catch (error) {
        console.error(`bounded native cleanup failed: ${String(error)}`);
      }
    }
    if (native?.child.exitCode === null) {
      native.child.kill('SIGTERM');
      await native.exited;
    }
    await coordinator?.close().catch(() => {});
    await fixture?.context?.close().catch(() => {});
    await fixture?.closeBrowserProxy?.().catch(() => {});
    if (fixture?.edge?.log)
      writeFileSync(join(work, 'den-edge.log'), `${fixture.edge.log.join('\n')}\n`);
    await fixture?.edge?.stop().catch(() => {});
    await fixture?.closeWire?.().catch(() => {});
    if (!KEEP && succeeded) rmSync(work, { recursive: true, force: true });
    else if (!succeeded) {
      console.error(`cross-host evidence retained under ${work}`);
    }
  }
}

await main();
