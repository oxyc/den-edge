import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  cleanupNativeIfReady,
  coordinatorBuildSetting,
  finalizeNativeRunner,
  generatedCoordinatorEnvironment,
  generatedXCTestRuns,
  injectCoordinatorEnvironment,
  injectedXCTestRunPath,
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
    fireAll() {
      for (const callback of [...active]) callback();
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
  const coordinator = 'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef';
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
  injectCoordinatorEnvironment(document, coordinator);
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
  for (const malformed of [null, [], 'not a plist dictionary'])
    assert.throws(
      () => injectCoordinatorEnvironment(malformed, coordinator),
      /xctestrun root is malformed/,
    );

  const topLevel = {
    DenMobileTests: { BlueprintName: 'DenMobileTests', EnvironmentVariables: { KEEP: 'yes' } },
    DenMobileUITests: {
      BlueprintName: 'DenMobileUITests',
      EnvironmentVariables: { EXISTING: 'yes' },
      IsUITestBundle: true,
    },
    __xctestrun_metadata__: { BlueprintName: 'DenMobileUITests', FormatVersion: 2 },
  };
  injectCoordinatorEnvironment(topLevel, coordinator);
  assert.equal(generatedCoordinatorEnvironment(topLevel), coordinator);
  assert.deepEqual(topLevel.DenMobileTests.EnvironmentVariables, { KEEP: 'yes' });
  assert.equal(topLevel.DenMobileUITests.EnvironmentVariables.EXISTING, 'yes');
  assert.deepEqual(topLevel.__xctestrun_metadata__, {
    BlueprintName: 'DenMobileUITests',
    FormatVersion: 2,
  });
  assert.throws(
    () =>
      injectCoordinatorEnvironment(
        {
          DenMobileUITests: { BlueprintName: 'DenMobileUITests' },
          AnotherUITestTarget: { BlueprintName: 'DenMobileUITests' },
          __xctestrun_metadata__: { FormatVersion: 2 },
        },
        coordinator,
      ),
    /2 DenMobileUITests targets/,
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

test('generated xctestrun discovery resolves cwd-relative Node glob matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'den-xctestrun-discovery-'));
  try {
    const nested = join(root, 'Debug-iphonesimulator');
    mkdirSync(nested, { recursive: true });
    const run = join(nested, 'DenMobile.xctestrun');
    writeFileSync(run, 'fixture');
    assert.deepEqual(generatedXCTestRuns(root), [run]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('xctestrun injection round-trips a run-owned copy and leaves canonical output unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'den-xctestrun-test-'));
  const products = join(root, 'DerivedData', 'Build', 'Products');
  mkdirSync(products, { recursive: true });
  const canonicalPath = join(products, 'Canonical.xctestrun');
  const injectedPath = injectedXCTestRunPath(canonicalPath);
  const temporaryJSONPath = `${injectedPath}.json`;
  const origin = 'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef';
  try {
    writeFileSync(
      canonicalPath,
      JSON.stringify({
        DenMobileTests: {
          BlueprintName: 'DenMobileTests',
          EnvironmentVariables: { UNIT: 'preserved' },
        },
        DenMobileUITests: {
          BlueprintName: 'DenMobileUITests',
          DependentProductPaths: [
            '__TESTROOT__/Debug-iphonesimulator/Den.app',
            '__TESTROOT__/Debug-iphonesimulator/DenMobileUITests-Runner.app',
          ],
          EnvironmentVariables: { EXISTING: 'preserved' },
          IsUITestBundle: true,
          TestBundlePath:
            '__TESTROOT__/Debug-iphonesimulator/DenMobileUITests-Runner.app/PlugIns/DenMobileUITests.xctest',
          TestingEnvironmentVariables: {
            DYLD_FRAMEWORK_PATH:
              '__TESTROOT__/Debug-iphonesimulator:__TESTROOT__/Debug-iphonesimulator/PackageFrameworks',
          },
        },
        __xctestrun_metadata__: {
          FormatVersion: 2,
        },
      }),
    );
    const canonicalBefore = readFileSync(canonicalPath);
    const before = createHash('sha256').update(canonicalBefore).digest('hex');
    assert.equal(dirname(injectedPath), dirname(canonicalPath));
    assert.notEqual(injectedPath, canonicalPath);
    assert.notEqual(basename(injectedPath), basename(canonicalPath));
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
    assert.deepEqual(readFileSync(canonicalPath), canonicalBefore);
    assert.equal(existsSync(temporaryJSONPath), false);
    const injected = readDocument(injectedPath);
    assert.equal(generatedCoordinatorEnvironment(injected), origin);
    assert.equal(injected.DenMobileUITests.EnvironmentVariables.EXISTING, 'preserved');
    assert.equal(injected.DenMobileTests.EnvironmentVariables.UNIT, 'preserved');
    assert.deepEqual(injected.DenMobileUITests.DependentProductPaths, [
      '__TESTROOT__/Debug-iphonesimulator/Den.app',
      '__TESTROOT__/Debug-iphonesimulator/DenMobileUITests-Runner.app',
    ]);
    assert.equal(
      injected.DenMobileUITests.TestBundlePath,
      '__TESTROOT__/Debug-iphonesimulator/DenMobileUITests-Runner.app/PlugIns/DenMobileUITests.xctest',
    );
    assert.equal(
      injected.DenMobileUITests.TestingEnvironmentVariables.DYLD_FRAMEWORK_PATH,
      '__TESTROOT__/Debug-iphonesimulator:__TESTROOT__/Debug-iphonesimulator/PackageFrameworks',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('xctestrun injection rejects an equal or non-sibling output path before copying', () => {
  const root = mkdtempSync(join(tmpdir(), 'den-xctestrun-boundary-'));
  const canonicalPath = join(root, 'Canonical.xctestrun');
  const origin = 'http://127.0.0.1:43127/run/01234567-89ab-cdef-0123-456789abcdef';
  try {
    writeFileSync(canonicalPath, 'canonical');
    for (const injectedPath of [canonicalPath, join(root, 'nested', 'Injected.xctestrun')]) {
      assert.throws(
        () =>
          prepareInjectedXCTestRun({
            canonicalPath,
            injectedPath,
            origin,
            temporaryJSONPath: `${injectedPath}.json`,
          }),
        /paths must be distinct siblings/,
      );
      assert.equal(readFileSync(canonicalPath, 'utf8'), 'canonical');
      assert.equal(existsSync(injectedPath), injectedPath === canonicalPath);
    }
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

const nativeRunner = () => {
  const exit = deferred();
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      child.signalCode = signal;
      exit.resolve({ code: null, error: null, signal });
    },
  };
  return { child, exited: exit.promise, resolveExit: exit.resolve, signals };
};

test('failed journey finalization requests cleanup then finish and awaits natural exit', async () => {
  const native = nativeRunner();
  const commands = [];
  const coordinator = {
    async command(...command) {
      commands.push(command);
      if (command[0] === 'finish') {
        native.child.exitCode = 65;
        native.resolveExit({ code: 65, error: null, signal: null });
      }
    },
  };

  const result = await finalizeNativeRunner({
    coordinator,
    native,
    ready: true,
    cleaned: false,
    finished: false,
  });

  assert.deepEqual(commands, [['cleanup', { timeoutSeconds: 45 }], ['finish']]);
  assert.deepEqual(result, { cleaned: true, errors: [], finished: true, timedOut: false });
  assert.deepEqual(native.signals, []);
});

test('failed journey finalization retains cleanup error and still finishes naturally', async () => {
  const native = nativeRunner();
  const commands = [];
  const coordinator = {
    async command(...command) {
      commands.push(command);
      if (command[0] === 'cleanup') throw new Error('cleanup detail');
      native.child.exitCode = 65;
      native.resolveExit({ code: 65, error: null, signal: null });
    },
  };

  const result = await finalizeNativeRunner({
    coordinator,
    native,
    ready: true,
    cleaned: false,
    finished: false,
  });

  assert.deepEqual(commands, [['cleanup', { timeoutSeconds: 45 }], ['finish']]);
  assert.equal(result.cleaned, false);
  assert.equal(result.finished, true);
  assert.match(result.errors[0].message, /cleanup detail/);
  assert.equal(result.timedOut, false);
});

test('native finalization timeout sends exactly one SIGTERM', async () => {
  const native = nativeRunner();
  const timer = timers();
  const finalizing = finalizeNativeRunner({
    coordinator: { command: async () => {} },
    native,
    ready: true,
    cleaned: false,
    finished: false,
    ...timer,
  });
  await Promise.resolve();
  await Promise.resolve();
  timer.fireAll();

  const result = await finalizing;
  assert.equal(result.timedOut, true);
  assert.deepEqual(native.signals, ['SIGTERM']);
  assert.match(result.errors.at(-1).message, /finalization timed out/);
  assert.equal(timer.count, 0);
});

test('completed success does not duplicate cleanup or finish', async () => {
  const commands = [];
  const result = await finalizeNativeRunner({
    coordinator: { command: async (...command) => commands.push(command) },
    native: {
      child: { exitCode: 0, signalCode: null },
      exited: Promise.resolve({ code: 0, error: null, signal: null }),
    },
    ready: true,
    cleaned: true,
    finished: true,
  });
  assert.deepEqual(commands, []);
  assert.deepEqual(result, { cleaned: true, errors: [], finished: true, timedOut: false });
});

test('early native exit sends neither cleanup nor finish', async () => {
  const commands = [];
  await finalizeNativeRunner({
    coordinator: { command: async (...command) => commands.push(command) },
    native: {
      child: { exitCode: 65, signalCode: null },
      exited: Promise.resolve({ code: 65, error: null, signal: null }),
    },
    ready: true,
    cleaned: false,
    finished: false,
  });
  assert.deepEqual(commands, []);
});

test('live unready native runner receives no commands and is terminated exactly once', async () => {
  const native = nativeRunner();
  const commands = [];
  await finalizeNativeRunner({
    coordinator: { command: async (...command) => commands.push(command) },
    native,
    ready: false,
    cleaned: false,
    finished: false,
  });
  assert.deepEqual(commands, []);
  assert.deepEqual(native.signals, ['SIGTERM']);
});

test('live native runner without a coordinator is terminated exactly once', async () => {
  const native = nativeRunner();
  await finalizeNativeRunner({
    coordinator: null,
    native,
    ready: true,
    cleaned: false,
    finished: false,
  });
  assert.deepEqual(native.signals, ['SIGTERM']);
});
