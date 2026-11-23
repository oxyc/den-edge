const exitError = ({ code, error, signal }, phase) => {
  if (error) return new Error(`native xcodebuild failed to start: ${error.message ?? error}`);
  if (signal) return new Error(`native xcodebuild exited via ${signal} ${phase}`);
  return new Error(`native xcodebuild exited ${code} ${phase}`);
};

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
      if (result.status === 'passed') finish(resolve, result);
      else finish(reject, new Error(`native readiness failed: ${result.detail ?? 'no detail'}`));
    });
    native.exited.then((result) => finish(reject, exitError(result, 'before ready')));
  });
}

/** Request mounted native cleanup only from a confirmed, still-running qualification runner. */
export async function cleanupNativeIfReady({ coordinator, native, ready, cleaned }) {
  if (!coordinator || !ready || cleaned || native?.child.exitCode !== null) return cleaned;
  await coordinator.command('cleanup', { timeoutSeconds: 45 });
  return true;
}
