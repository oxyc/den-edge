/** Isolated den-edge environment; managed playback is opt-in for the native cross-host gate only. */
export function rehearsalEdgeEnvironment({
  dataDir,
  denPlayback = false,
  newLibraries,
  port,
  web,
}) {
  return {
    PORT: String(port),
    DATA_DIR: dataDir,
    LOG_REQUESTS: '1',
    WEB_DIR: web,
    WEB_HOSTS: '127.0.0.1',
    PROFILES_HOSTS: '127.0.0.1',
    NEW_LIBRARIES: newLibraries,
    ...(denPlayback ? { DEN_PLAYBACK_ENABLED: '1' } : {}),
  };
}

export const playbackStartupConfirmed = (log, denPlayback) =>
  !denPlayback || log.some((line) => /(^| )den_playback=on( |$)/.test(line));

const edgeSettled = (child) => child.exitCode !== null || child.signalCode !== null;

/** Wait for stderr delivery after health, and always settle the owned child on failure. */
export async function requirePlaybackStartup({
  attempts = 20,
  child,
  denPlayback,
  exited,
  log,
  pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
}) {
  if (!denPlayback) return;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (edgeSettled(child)) {
      await exited;
      throw new Error(
        `den-edge exited ${child.exitCode ?? child.signalCode} before confirming den_playback=on`,
      );
    }
    if (playbackStartupConfirmed(log, true)) return;
    await pause(50);
  }
  if (edgeSettled(child)) {
    await exited;
    throw new Error(
      `den-edge exited ${child.exitCode ?? child.signalCode} before confirming den_playback=on`,
    );
  }
  if (playbackStartupConfirmed(log, true)) return;
  child.kill();
  await exited;
  throw new Error('den-edge did not confirm den_playback=on for the isolated rehearsal');
}

/** Initial and restarted Edge instances in the cross-host gate must use the same explicit capability. */
export const crossHostPlaybackEdgeOptions = (options = {}) => ({
  ...options,
  denPlayback: true,
});

/** A failed startup never strands its not-yet-returned child handle. */
export async function settleFailedEdgeStartup({ child, exited, message }) {
  if (!edgeSettled(child)) child.kill();
  await exited;
  throw new Error(message);
}
