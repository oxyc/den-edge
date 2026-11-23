import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cleanupNativeIfReady,
  coordinatorBuildSetting,
  generatedCoordinatorEnvironment,
  injectCoordinatorEnvironment,
  nativeBuildArguments,
  nativeTestArguments,
  prepareInjectedXCTestRun,
  waitForNativeReady,
} from './rehearse-native-runner.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

const readiness = () => {
  const listeners = new Set();
  return {
    coordinator: {
      subscribeReady(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    report(result) {
      for (const listener of listeners) listener(result);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
};

const timers = () => {
  const active = new Set();
  return {
    setTimer(callback) {
      active.add(callback);
      return callback;
    },
    clearTimer(callback) {
      active.delete(callback);
    },
    get count() {
      return active.size;
    },
  };
};

test('coordinator transport accepts only the ephemeral loopback run URL', () => {
  assert.equal(
    coordinatorBuildSetting('http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef'),
    'DEN_CROSS_HOST_COORDINATOR=http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
  );
  for (const invalid of [
    'https://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
    'http://localhost:43127/run/01234567-89ab-cdef-0123-456789abcdef',
    'http://127.0.0.1:43127/not-a-run',
    'http://user@127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
  ])
    assert.throws(() => coordinatorBuildSetting(invalid), /uncredentialed loopback run URL/);
});

test('injects one ephemeral environment into exactly one generated UI-test target', () => {
  const document = {
    TestConfigurations: [
      {
        TestTargets: [
          { BlueprintName: 'DenMobileTests', EnvironmentVariables: { KEEP: 'yes' } },
          { BlueprintName: 'DenMobileUITests', EnvironmentVariables: { EXISTING: 'yes' } },
        ],
      },
    ],
  };
  injectCoordinatorEnvironment(
    document,
    'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
  );
  assert.deepEqual(document.TestConfigurations[0].TestTargets[0].EnvironmentVariables, {
    KEEP: 'yes',
  });
  assert.deepEqual(document.TestConfigurations[0].TestTargets[1].EnvironmentVariables, {
    EXISTING: 'yes',
    DEN_CROSS_HOST_COORDINATOR: 'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.equal(
    generatedCoordinatorEnvironment(document),
    'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
  );
  assert.throws(
    () =>
      injectCoordinatorEnvironment(
        { TestConfigurations: [] },
        'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
      ),
    /0 DenMobileUITests targets/,
  );
  assert.throws(
    () =>
      injectCoordinatorEnvironment(
        {
          TestConfigurations: [
            {
              TestTargets: [
                { BlueprintName: 'DenMobileUITests' },
                { BlueprintName: 'DenMobileUITests' },
              ],
            },
          ],
        },
        'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
      ),
    /2 DenMobileUITests targets/,
  );
  assert.throws(
    () =>
      injectCoordinatorEnvironment(
        { TestConfigurations: [{}] },
        'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef',
      ),
    /malformed TestTargets/,
  );
});

test('native qualification builds once then runs only the generated injected xctestrun', () => {
  assert.deepEqual(
    nativeBuildArguments({
      derivedDataPath: '/evidence/DerivedData',
      destination: 'platform=iOS Simulator,id=DEVICE',
      sourcePackagesPath: '/cache/SourcePackages',
    }),
    [
      'build-for-testing',
      '-project',
      'App/Den.xcodeproj',
      '-scheme',
      'DenMobile',
      '-destination',
      'platform=iOS Simulator,id=DEVICE',
      '-derivedDataPath',
      '/evidence/DerivedData',
      '-clonedSourcePackagesDirPath',
      '/cache/SourcePackages',
      '-disableAutomaticPackageResolution',
      '-skipPackageUpdates',
    ],
  );
  assert.deepEqual(
    nativeTestArguments({
      destination: 'platform=iOS Simulator,id=DEVICE',
      resultBundlePath: '/evidence/NativeCrossHost.xcresult',
      xctestrunPath: '/evidence/NativeCrossHost.xctestrun',
    }),
    [
      'test-without-building',
      '-xctestrun',
      '/evidence/NativeCrossHost.xctestrun',
      '-destination',
      'platform=iOS Simulator,id=DEVICE',
      '-only-testing:DenMobileUITests/MobileCrossHostQualificationUITests/' +
        'testRealNativeAndBrowserHostsConvergeAcrossProfilesAndRestart',
      '-resultBundlePath',
      '/evidence/NativeCrossHost.xcresult',
    ],
  );
});

test('xctestrun injection round-trips a run-owned copy and leaves canonical output unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'den-xctestrun-test-'));
  const canonicalPath = join(root, 'Canonical.xctestrun');
  const injectedPath = join(root, 'NativeCrossHost.xctestrun');
  const temporaryJSONPath = join(root, 'NativeCrossHost.xctestrun.json');
  const origin = 'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef';
  try {
    writeFileSync(
      canonicalPath,
      JSON.stringify({
        TestConfigurations: [
          {
            TestTargets: [
              {
                BlueprintName: 'DenMobileUITests',
                EnvironmentVariables: { EXISTING: 'preserved' },
              },
            ],
          },
        ],
      }),
    );
    const before = createHash('sha256').update(readFileSync(canonicalPath)).digest('hex');
    const readDocument = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const writeDocument = (document, output, temporary) => {
      writeFileSync(temporary, JSON.stringify(document));
      writeFileSync(output, readFileSync(temporary));
    };
    prepareInjectedXCTestRun({
      canonicalPath,
      injectedPath,
      origin,
      readDocument,
      temporaryJSONPath,
      writeDocument,
    });
    const after = createHash('sha256').update(readFileSync(canonicalPath)).digest('hex');
    assert.equal(after, before);
    assert.equal(existsSync(temporaryJSONPath), false);
    const injected = readDocument(injectedPath);
    assert.equal(generatedCoordinatorEnvironment(injected), origin);
    assert.equal(
      injected.TestConfigurations[0].TestTargets[0].EnvironmentVariables.EXISTING,
      'preserved',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('native exit before readiness fails immediately without retaining its timer or listener', async () => {
  const exited = deferred();
  const ready = readiness();
  const timer = timers();
  const waiting = waitForNativeReady({ exited: exited.promise }, ready.coordinator, timer);

  exited.resolve({ code: 65, error: null, signal: null });

  await assert.rejects(waiting, /native xcodebuild exited 65 before ready/);
  assert.equal(timer.count, 0);
  assert.equal(ready.listenerCount, 0);
});

test('confirmed readiness cancels exit observation effects and preserves normal cleanup eligibility', async () => {
  const exited = deferred();
  const ready = readiness();
  const timer = timers();
  const waiting = waitForNativeReady({ exited: exited.promise }, ready.coordinator, timer);

  ready.report({ sequence: 0, status: 'ready', detail: null });

  assert.equal((await waiting).sequence, 0);
  assert.equal(timer.count, 0);
  assert.equal(ready.listenerCount, 0);
  exited.resolve({ code: 1, error: null, signal: null });
  await Promise.resolve();
});

test('sequence zero must carry the native ready status literal', async () => {
  const exited = deferred();
  const ready = readiness();
  const timer = timers();
  const waiting = waitForNativeReady({ exited: exited.promise }, ready.coordinator, timer);

  ready.report({ sequence: 0, status: 'passed', detail: 'wrong readiness status' });

  await assert.rejects(waiting, /native readiness failed: wrong readiness status/);
  assert.equal(timer.count, 0);
  assert.equal(ready.listenerCount, 0);
});

test('spawn failure retains the exact child error and cancels readiness resources', async () => {
  const exited = deferred();
  const ready = readiness();
  const timer = timers();
  const waiting = waitForNativeReady({ exited: exited.promise }, ready.coordinator, timer);

  exited.resolve({ code: null, error: new Error('ENOENT'), signal: null });

  await assert.rejects(waiting, /native xcodebuild failed to start: ENOENT/);
  assert.equal(timer.count, 0);
  assert.equal(ready.listenerCount, 0);
});

test('cleanup is gated on a confirmed, still-running native runner', async () => {
  const commands = [];
  const coordinator = { command: async (...command) => commands.push(command) };
  const live = { child: { exitCode: null, signalCode: null } };

  assert.equal(
    await cleanupNativeIfReady({ coordinator, native: live, ready: false, cleaned: false }),
    false,
  );
  assert.deepEqual(commands, []);
  assert.equal(
    await cleanupNativeIfReady({ coordinator: null, native: live, ready: true, cleaned: false }),
    false,
  );
  assert.equal(
    await cleanupNativeIfReady({ coordinator, native: live, ready: true, cleaned: true }),
    true,
  );
  assert.equal(
    await cleanupNativeIfReady({
      coordinator,
      native: { child: { exitCode: 65, signalCode: null } },
      ready: true,
      cleaned: false,
    }),
    false,
  );
  assert.equal(
    await cleanupNativeIfReady({
      coordinator,
      native: { child: { exitCode: null, signalCode: 'SIGTERM' } },
      ready: true,
      cleaned: false,
    }),
    false,
  );
  assert.deepEqual(commands, []);
  assert.equal(
    await cleanupNativeIfReady({ coordinator, native: live, ready: true, cleaned: false }),
    true,
  );
  assert.deepEqual(commands, [['cleanup', { timeoutSeconds: 45 }]]);
});
