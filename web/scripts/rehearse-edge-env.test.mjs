import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crossHostPlaybackEdgeOptions,
  playbackStartupConfirmed,
  rehearsalEdgeEnvironment,
  requirePlaybackStartup,
  settleFailedEdgeStartup,
} from './rehearse-edge-env.mjs';

const options = {
  dataDir: '/tmp/edge',
  newLibraries: 'visitors',
  port: 43127,
  web: '/tmp/web',
};

test('rehearsal Edge keeps Den playback default-off and enables it only when requested', () => {
  assert.equal(rehearsalEdgeEnvironment(options).DEN_PLAYBACK_ENABLED, undefined);
  assert.equal(
    rehearsalEdgeEnvironment({ ...options, denPlayback: true }).DEN_PLAYBACK_ENABLED,
    '1',
  );
});

test('opt-in playback requires the exact startup confirmation on initial start and restart', () => {
  const phases = [crossHostPlaybackEdgeOptions(), crossHostPlaybackEdgeOptions({ port: 43128 })];
  for (const [index, phase] of phases.entries()) {
    assert.equal(phase.denPlayback, true);
    if (index === 1) assert.equal(phase.port, 43128);
    assert.equal(playbackStartupConfirmed(['den_playback=off'], phase.denPlayback), false);
    assert.equal(playbackStartupConfirmed(['den_playback=on'], phase.denPlayback), true);
  }
  assert.equal(playbackStartupConfirmed([], false), true);
});

const edgeChild = () => {
  let resolveExit;
  let settled = false;
  const exited = new Promise((resolve) => {
    resolveExit = (value) => {
      settled = true;
      resolve(value);
    };
  });
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {
      signals.push('SIGTERM');
      child.signalCode = 'SIGTERM';
      resolveExit('SIGTERM');
    },
  };
  return {
    child,
    exited,
    resolveExit,
    signals,
    get settled() {
      return settled;
    },
  };
};

test('playback startup accepts a delayed exact log token after health', async () => {
  const edge = edgeChild();
  const log = [];
  let pauses = 0;
  await requirePlaybackStartup({
    attempts: 3,
    child: edge.child,
    denPlayback: true,
    exited: edge.exited,
    log,
    pause: async () => {
      pauses += 1;
      log.push('listening den_playback=on oauth=off');
    },
  });
  assert.equal(pauses, 1);
  assert.deepEqual(edge.signals, []);
});

test('playback startup timeout kills and awaits the owned Edge child', async () => {
  const edge = edgeChild();
  await assert.rejects(
    requirePlaybackStartup({
      attempts: 2,
      child: edge.child,
      denPlayback: true,
      exited: edge.exited,
      log: [],
      pause: async () => {},
    }),
    /did not confirm/,
  );
  assert.deepEqual(edge.signals, ['SIGTERM']);
  assert.equal(edge.settled, true);
});

test('playback startup observes and awaits an early Edge exit without killing again', async () => {
  const edge = edgeChild();
  edge.child.exitCode = 9;
  edge.resolveExit(9);
  await assert.rejects(
    requirePlaybackStartup({
      child: edge.child,
      denPlayback: true,
      exited: edge.exited,
      log: [],
      pause: async () => {},
    }),
    /exited 9/,
  );
  assert.deepEqual(edge.signals, []);
  assert.equal(edge.settled, true);
});

test('playback startup observes a signal exit without killing again', async () => {
  const edge = edgeChild();
  edge.child.signalCode = 'SIGKILL';
  edge.resolveExit('SIGKILL');
  await assert.rejects(
    requirePlaybackStartup({
      child: edge.child,
      denPlayback: true,
      exited: edge.exited,
      log: [],
      pause: async () => {},
    }),
    /exited SIGKILL/,
  );
  assert.deepEqual(edge.signals, []);
  assert.equal(edge.settled, true);
});

test('playback startup rejects an already-exited child even with a confirmation token', async () => {
  const edge = edgeChild();
  edge.child.exitCode = 9;
  edge.resolveExit(9);
  await assert.rejects(
    requirePlaybackStartup({
      child: edge.child,
      denPlayback: true,
      exited: edge.exited,
      log: ['den_playback=on'],
      pause: async () => {},
    }),
    /exited 9/,
  );
  assert.deepEqual(edge.signals, []);
});

test('unready Edge startup kills and settles its live child before failing', async () => {
  const edge = edgeChild();
  await assert.rejects(
    settleFailedEdgeStartup({
      child: edge.child,
      exited: edge.exited,
      message: 'health unavailable',
    }),
    /health unavailable/,
  );
  assert.deepEqual(edge.signals, ['SIGTERM']);
  assert.equal(edge.settled, true);
});

test('already-exited Edge startup settles without a duplicate kill', async () => {
  const edge = edgeChild();
  edge.child.exitCode = 7;
  edge.resolveExit(7);
  await assert.rejects(
    settleFailedEdgeStartup({
      child: edge.child,
      exited: edge.exited,
      message: 'exited 7',
    }),
    /exited 7/,
  );
  assert.deepEqual(edge.signals, []);
  assert.equal(edge.settled, true);
});

test('signal-exited Edge startup settles without a duplicate kill', async () => {
  const edge = edgeChild();
  edge.child.signalCode = 'SIGABRT';
  edge.resolveExit('SIGABRT');
  await assert.rejects(
    settleFailedEdgeStartup({
      child: edge.child,
      exited: edge.exited,
      message: 'signal exit',
    }),
    /signal exit/,
  );
  assert.deepEqual(edge.signals, []);
  assert.equal(edge.settled, true);
});
