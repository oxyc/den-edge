// Opt-in diagnostics, never enabled by CI budgets. Keeps terminated nested workers alive until page close so their
// complete profiles can be read. Diagnostic retained memory is therefore NOT a normal-lifetime measurement.
import { writeFileSync } from 'node:fs';

export async function allocationAudit(cdp, output) {
  const records = [];
  const ignoredTargets = [];
  let next = 0;
  function connection(send, name, depth) {
    const pending = new Map();
    const children = new Map();
    const record = { name, depth, errors: [] };
    const ask = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          record.errors.push({ method, error: 'timeout after 15000ms' });
          resolve(undefined);
        }, 15_000);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          pending.delete(id);
          if (answer.error) record.errors.push({ method, error: answer.error });
          resolve(answer.result);
        });
        void send({ id, method, params }).catch((error) => {
          record.errors.push({ method, error: String(error) });
          pending.get(id)?.({});
        });
      });
    const receive = (message) => {
      if (message.id) return pending.get(message.id)?.(message);
      if (message.method === 'Target.receivedMessageFromTarget') {
        children.get(message.params.sessionId)?.receive(JSON.parse(message.params.message));
      } else if (message.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo, waitingForDebugger } = message.params;
        if (targetInfo.type !== 'worker') {
          ignoredTargets.push({ type: targetInfo.type, url: targetInfo.url, waitingForDebugger });
          if (waitingForDebugger)
            void ask('Target.sendMessageToTarget', {
              sessionId,
              message: JSON.stringify({ id: 0, method: 'Runtime.runIfWaitingForDebugger' }),
            });
          return;
        }
        const child = connection(
          (message) =>
            ask('Target.sendMessageToTarget', {
              sessionId,
              message: JSON.stringify(message),
            }),
          targetInfo.url,
          depth + 1,
        );
        children.set(sessionId, child);
        records.push(child);
        child.ready = (async () => {
          await child.ask('Runtime.evaluate', { expression: `(${instrument})()` });
          await child.ask('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: false,
          });
          await child.ask('HeapProfiler.startSampling', {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          await child.ask('Profiler.enable');
          await child.ask('Profiler.setSamplingInterval', { interval: 1000 });
          await child.ask('Profiler.start');
          if (waitingForDebugger) await child.ask('Runtime.runIfWaitingForDebugger');
        })();
      } else if (message.method === 'Target.detachedFromTarget') {
        const child = children.get(message.params.sessionId);
        if (child) child.record.detached = true;
        children.delete(message.params.sessionId);
      }
    };
    return { ask, receive, record, ready: Promise.resolve() };
  }
  // Test-only accounting of data-copy boundaries and retirement. No request/response contents or keys recorded.
  function instrument() {
    const audit = (globalThis.__allocationAudit = {
      postMs: 0,
      posts: 0,
      jsonParseMs: 0,
      jsonParses: 0,
      jsonParseChars: 0,
      jsonStringifyMs: 0,
      jsonStrings: 0,
      jsonStringifyChars: 0,
      operations: {},
      wasm: [],
      retired: [],
    });
    for (const [name, counter, time, chars] of [
      ['parse', 'jsonParses', 'jsonParseMs', 'jsonParseChars'],
      ['stringify', 'jsonStrings', 'jsonStringifyMs', 'jsonStringifyChars'],
    ]) {
      const original = JSON[name];
      JSON[name] = function (...args) {
        const start = performance.now();
        const answer = original.apply(this, args);
        const elapsed = performance.now() - start;
        audit[time] += elapsed;
        audit[counter]++;
        audit[chars] += (name === 'parse' ? args[0] : answer)?.length ?? 0;
        if (name === 'stringify' && typeof args[0]?.op === 'string') {
          const operation = (audit.operations[args[0].op] ??= { count: 0, chars: 0, ms: 0 });
          operation.count++;
          operation.chars += answer?.length ?? 0;
          operation.ms += elapsed;
        }
        return answer;
      };
    }
    const post = globalThis.postMessage;
    globalThis.postMessage = function (...args) {
      const start = performance.now();
      const answer = post.apply(this, args);
      audit.postMs += performance.now() - start;
      audit.posts++;
      return answer;
    };
    if (globalThis.Worker) {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        const start = performance.now();
        const answer = post.apply(this, args);
        audit.postMs += performance.now() - start;
        audit.posts++;
        return answer;
      };
      Worker.prototype.terminate = function () {
        audit.retired.push(this);
      };
    }
    for (const name of ['instantiate', 'instantiateStreaming']) {
      const original = WebAssembly[name];
      WebAssembly[name] = function (...args) {
        return original.apply(this, args).then((made) => {
          const instance = made instanceof WebAssembly.Instance ? made : made?.instance;
          for (const value of Object.values(instance?.exports ?? {}))
            if (value instanceof WebAssembly.Memory) audit.wasm.push(value);
          return made;
        });
      };
    }
  }
  const root = connection(
    async (message) => {
      try {
        root.receive({ id: message.id, result: await cdp.send(message.method, message.params) });
      } catch (error) {
        root.receive({ id: message.id, error: String(error) });
      }
    },
    'page',
    0,
  );
  records.push(root);
  for (const method of [
    'Target.attachedToTarget',
    'Target.detachedFromTarget',
    'Target.receivedMessageFromTarget',
  ])
    cdp.on(method, (params) => root.receive({ method, params }));
  await root.ask('Page.enable');
  await root.ask('Page.addScriptToEvaluateOnNewDocument', { source: `(${instrument})()` });
  await root.ask('Runtime.evaluate', { expression: `(${instrument})()` });
  await root.ask('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  await root.ask('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await root.ask('Profiler.enable');
  await root.ask('Profiler.setSamplingInterval', { interval: 1000 });
  await root.ask('Profiler.start');
  return async () => {
    const held = [];
    for (const child of records) {
      await child.ready;
      const cpu = await child.ask('Profiler.stop');
      const allocation = await child.ask('HeapProfiler.stopSampling');
      await child.ask('HeapProfiler.collectGarbage');
      const heap = await child.ask('Runtime.getHeapUsage');
      const accounting = await child.ask('Runtime.evaluate', {
        expression: `(() => { const a = globalThis.__allocationAudit; return a && {
          ...a, wasm: a.wasm.reduce((sum, m) => sum + m.buffer.byteLength, 0), retired: a.retired.length,
          policyRequests: globalThis.__denPolicyRequests ?? {},
        }; })()`,
        returnByValue: true,
      });
      if (accounting?.exceptionDetails)
        child.record.errors.push({
          method: 'Runtime.evaluate(accounting)',
          error: accounting.exceptionDetails.text,
        });
      Object.assign(child.record, {
        cpu: cpu?.profile,
        allocation: allocation?.profile,
        heap,
        accounting: accounting?.result?.value,
      });
      const bytes = (node) => node.selfSize + node.children.reduce((sum, n) => sum + bytes(n), 0);
      held.push({
        name: child.record.name,
        depth: child.record.depth,
        heap: (heap?.usedSize ?? 0) / 2 ** 20,
        wasm: (accounting?.result?.value?.wasm ?? 0) / 2 ** 20,
        allocated: allocation?.profile ? bytes(allocation.profile.head) / 2 ** 20 : null,
      });
    }
    const incomplete = records.flatMap(({ record }) => {
      const missing = ['cpu', 'allocation', 'heap', 'accounting'].filter(
        (field) => record[field] === undefined,
      );
      return record.errors.length || missing.length || record.detached
        ? [
            {
              name: record.name,
              depth: record.depth,
              missing,
              detached: !!record.detached,
              errors: record.errors,
            },
          ]
        : [];
    });
    writeFileSync(
      `${output}.json`,
      JSON.stringify({
        profileComplete: incomplete.length === 0,
        profileErrors: incomplete,
        records: records.map(({ record }) => record),
        ignoredTargets,
      }),
    );
    held.profileComplete = incomplete.length === 0;
    held.profileErrors = incomplete;
    return held;
  };
}
