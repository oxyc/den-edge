import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const exitError = ({ code, error, signal }, phase) => {
  if (error) return new Error(`native xcodebuild failed to start: ${error.message ?? error}`);
  if (signal) return new Error(`native xcodebuild exited via ${signal} ${phase}`);
  return new Error(`native xcodebuild exited ${code} ${phase}`);
};

/** Validate and normalize the ephemeral coordinator transported in a generated xctestrun. */
export function coordinatorBuildSetting(raw) {
  const coordinator = new URL(raw);
  if (
    coordinator.protocol !== 'http:' ||
    coordinator.hostname !== '127.0.0.1' ||
    !coordinator.port ||
    !/^\/run\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      coordinator.pathname,
    ) ||
    coordinator.username ||
    coordinator.password ||
    coordinator.search ||
    coordinator.hash
  )
    throw new Error('native coordinator must be an uncredentialed loopback run URL');
  return `DEN_CROSS_HOST_COORDINATOR=${coordinator.href}`;
}

const generatedUITestTarget = (document) => {
  if (document === null || Array.isArray(document) || typeof document !== 'object')
    throw new Error('generated xctestrun root is malformed');
  const configurations = document.TestConfigurations;
  let targets = [];
  if (configurations !== undefined) {
    if (!Array.isArray(configurations))
      throw new Error('generated xctestrun has malformed TestConfigurations');
    if (configurations.some((configuration) => !Array.isArray(configuration?.TestTargets)))
      throw new Error('generated xctestrun has malformed TestTargets');
    targets = configurations.flatMap((configuration) => configuration.TestTargets);
  }
  targets.push(
    ...Object.entries(document)
      .filter(
        ([key, value]) =>
          key !== 'TestConfigurations' &&
          key !== '__xctestrun_metadata__' &&
          value !== null &&
          !Array.isArray(value) &&
          typeof value === 'object' &&
          typeof value.BlueprintName === 'string',
      )
      .map(([, value]) => value),
  );
  const matching = targets.filter((target) => target.BlueprintName === 'DenMobileUITests');
  if (matching.length !== 1)
    throw new Error(`generated xctestrun has ${matching.length} DenMobileUITests targets`);
  return matching[0];
};

/** Inject one ephemeral coordinator into exactly one generated DenMobile UI-test target. */
export function injectCoordinatorEnvironment(document, raw) {
  const target = generatedUITestTarget(document);
  if (
    target.EnvironmentVariables !== undefined &&
    (target.EnvironmentVariables === null ||
      Array.isArray(target.EnvironmentVariables) ||
      typeof target.EnvironmentVariables !== 'object')
  )
    throw new Error('generated DenMobileUITests environment is malformed');
  const coordinator = coordinatorBuildSetting(raw).slice('DEN_CROSS_HOST_COORDINATOR='.length);
  target.EnvironmentVariables = {
    ...(target.EnvironmentVariables ?? {}),
    DEN_CROSS_HOST_COORDINATOR: coordinator,
  };
  return document;
}

export const generatedCoordinatorEnvironment = (document) =>
  generatedUITestTarget(document).EnvironmentVariables?.DEN_CROSS_HOST_COORDINATOR;

export const nativeBuildArguments = ({ derivedDataPath, destination, sourcePackagesPath }) => [
  'build-for-testing',
  '-project',
  'App/Den.xcodeproj',
  '-scheme',
  'DenMobile',
  '-destination',
  destination,
  '-derivedDataPath',
  derivedDataPath,
  '-clonedSourcePackagesDirPath',
  sourcePackagesPath,
  '-disableAutomaticPackageResolution',
  '-skipPackageUpdates',
];

export const nativeTestArguments = ({ destination, resultBundlePath, xctestrunPath }) => [
  'test-without-building',
  '-xctestrun',
  xctestrunPath,
  '-destination',
  destination,
  '-only-testing:DenMobileUITests/MobileCrossHostQualificationUITests/' +
    'testRealNativeAndBrowserHostsConvergeAcrossProfilesAndRestart',
  '-resultBundlePath',
  resultBundlePath,
];

/** Resolve Node's cwd-relative glob matches beneath the exact isolated Products root. */
export const generatedXCTestRuns = (productsPath) =>
  globSync('**/*.xctestrun', { cwd: productsPath }).map((match) => resolve(productsPath, match));

const readPlist = (path) =>
  JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));

const writePlist = (document, injectedPath, temporaryJSONPath) => {
  writeFileSync(temporaryJSONPath, JSON.stringify(document));
  execFileSync('plutil', ['-convert', 'binary1', '-o', injectedPath, temporaryJSONPath]);
};

/** Copy, inject and round-trip a generated xctestrun without mutating Xcode's canonical output. */
export function prepareInjectedXCTestRun({
  canonicalPath,
  injectedPath,
  origin,
  readDocument = readPlist,
  temporaryJSONPath,
  writeDocument = writePlist,
}) {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const canonicalDigest = digest(canonicalPath);
  copyFileSync(canonicalPath, injectedPath);
  try {
    const document = readDocument(injectedPath);
    injectCoordinatorEnvironment(document, origin);
    writeDocument(document, injectedPath, temporaryJSONPath);
    const verified = readDocument(injectedPath);
    if (generatedCoordinatorEnvironment(verified) !== origin)
      throw new Error('generated xctestrun did not retain the coordinator environment');
  } finally {
    rmSync(temporaryJSONPath, { force: true });
  }
  if (digest(canonicalPath) !== canonicalDigest)
    throw new Error('canonical generated xctestrun changed during coordinator injection');
  return injectedPath;
}

/** Wait for sequence-zero readiness while retaining ownership of the timeout and exit observation. */
export function waitForNativeReady(
  native,
  coordinator,
  { timeoutMs = 180_000, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      unsubscribe();
      action(value);
    };
    const timer = setTimer(
      () => finish(reject, new Error('native UI runner ready timed out')),
      timeoutMs,
    );
    unsubscribe = coordinator.subscribeReady((result) => {
      if (result.status === 'ready') finish(resolve, result);
      else finish(reject, new Error(`native readiness failed: ${result.detail ?? 'no detail'}`));
    });
    native.exited.then((result) => finish(reject, exitError(result, 'before ready')));
  });
}

/** Request mounted native cleanup only from a confirmed, still-running qualification runner. */
export async function cleanupNativeIfReady({ coordinator, native, ready, cleaned }) {
  if (
    !coordinator ||
    !ready ||
    cleaned ||
    native?.child.exitCode !== null ||
    native?.child.signalCode !== null
  )
    return cleaned;
  await coordinator.command('cleanup', { timeoutSeconds: 45 });
  return true;
}
