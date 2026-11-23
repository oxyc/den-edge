const exitError = ({ code, error, signal }, phase) => {
  if (error) return new Error(`native xcodebuild failed to start: ${error.message ?? error}`);
  if (signal) return new Error(`native xcodebuild exited via ${signal} ${phase}`);
  return new Error(`native xcodebuild exited ${code} ${phase}`);
};

const coordinatorEnvironment =
  '<EnvironmentVariable key="DEN_CROSS_HOST_COORDINATOR" ' +
  'value="$(DEN_CROSS_HOST_COORDINATOR)" isEnabled="YES" />';

/** Build setting expanded by DenMobile's checked-in TestAction environment. */
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

/** Fail before spawning when the native checkout lacks the explicit TestAction transport. */
export function verifyCoordinatorScheme(source) {
  if (!source.includes(coordinatorEnvironment))
    throw new Error('DenMobile scheme does not expand DEN_CROSS_HOST_COORDINATOR for tests');
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
