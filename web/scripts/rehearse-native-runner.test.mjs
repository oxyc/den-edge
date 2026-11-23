import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupNativeIfReady, waitForNativeReady } from './rehearse-native-runner.mjs';

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

  ready.report({ sequence: 0, status: 'passed', detail: null });

  assert.equal((await waiting).sequence, 0);
  assert.equal(timer.count, 0);
  assert.equal(ready.listenerCount, 0);
  exited.resolve({ code: 1, error: null, signal: null });
  await Promise.resolve();
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
  const native = { child: { exitCode: null } };

  assert.equal(
    await cleanupNativeIfReady({ coordinator, native, ready: false, cleaned: false }),
    false,
  );
  assert.deepEqual(commands, []);
  assert.equal(
    await cleanupNativeIfReady({ coordinator, native, ready: true, cleaned: false }),
    true,
  );
  assert.deepEqual(commands, [['cleanup', { timeoutSeconds: 45 }]]);
});
