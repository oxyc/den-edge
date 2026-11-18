import { readFileSync } from 'node:fs';
import { minify } from 'terser';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const pageSource = readFileSync(new URL('../src/lib/syncPolicyModule.ts', import.meta.url), 'utf8');
const workerUrl = new URL('../src/vendor/den-core/deferred.js', import.meta.url);
const tvWorkerUrl = new URL('../src/vendor/den-core-tv/deferred.js', import.meta.url);
const workerSource = readFileSync(workerUrl, 'utf8');
const tvWorkerSource = readFileSync(tvWorkerUrl, 'utf8');

const evidence = [
  'den: deferred-wasm-diagnostic',
  'access-control-allow-origin',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
];
const releaseWorkerArtifact =
  'import e,{evaluate_deferred as r}from"./generated/den_core_deferred.js";let t,o=!1;export function initializeDeferred(r){if(o)return Promise.resolve();if(!t){const i=r??fetch(new URL("./generated/den_core_deferred_bg.wasm",import.meta.url),{signal:AbortSignal.timeout(15e3)});t=e({module_or_path:i}).then(()=>{o=!0}).catch(e=>{throw t=void 0,e})}return t}export function evaluateDeferred(e){if(!o)throw new Error("Deferred core is not initialized");return r(e)}';

function javascript(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText;
}

async function artifact(source: string, e2e: boolean, typescript = false): Promise<string> {
  const shaped = source.replaceAll('import.meta.env.DEN_E2E', String(e2e));
  return (
    await minify(typescript ? javascript(shaped) : shaped, {
      module: true,
      compress: true,
      mangle: true,
    })
  ).code!;
}

function reporter(source: string, typescript: boolean) {
  const start = source.indexOf('const safeRuntimeUrl');
  const end = source.indexOf(
    typescript ? '/** One compile of each lifecycle module' : 'export function initializeDeferred',
    start,
  );
  const body = source.slice(start, end);
  const factory = new Function(
    'location',
    'console',
    'URL',
    `${typescript ? javascript(body) : body}; return { reportDeferredWasmFailure };`,
  );
  const warnings: string[] = [];
  return {
    warnings,
    report: factory(
      {
        href: 'https://member:secret@app.example/worker.js?session=secret#fragment',
        origin: 'https://app.example',
      },
      { warn: (message: string) => warnings.push(message) },
      URL,
    ).reportDeferredWasmFailure as (wasm: URL, response: unknown, error: unknown) => void,
  };
}

function payload(message: string) {
  return JSON.parse(message.slice('den: deferred-wasm-diagnostic '.length));
}

function moduleHarness(source: string, typescript: boolean, dependencies: Record<string, unknown>) {
  const withoutImports = source.replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const shaped = withoutImports
    .replaceAll('import.meta.env.DEN_E2E', 'true')
    .replaceAll('import.meta.url', JSON.stringify('https://app.example/assets/module.js'));
  const body = typescript ? javascript(shaped) : shaped;
  const names = Object.keys(dependencies);
  return new Function(
    ...names,
    `${body}; return {
      syncPolicyModule: typeof syncPolicyModule === 'undefined' ? undefined : syncPolicyModule,
      initializeDeferred: typeof initializeDeferred === 'undefined' ? undefined : initializeDeferred,
    };`,
  )(...Object.values(dependencies)) as {
    syncPolicyModule?: (kind: 'deferred') => Promise<unknown>;
    initializeDeferred?: (input?: unknown) => Promise<void>;
  };
}

describe('deferred WASM investigation diagnostics', () => {
  it('omits all evidence from release artifacts and preserves the direct Worker fetch', async () => {
    expect(workerSource).toBe(tvWorkerSource);
    expect(workerSource).toContain(
      "fetch(new URL('./generated/den_core_deferred_bg.wasm', import.meta.url), {",
    );

    const releasePage = await artifact(pageSource, false, true);
    const releaseWorker = await artifact(workerSource, false);
    for (const token of evidence) {
      expect(releasePage).not.toContain(token);
      expect(releaseWorker).not.toContain(token);
    }
    expect(releaseWorker).toBe(releaseWorkerArtifact);

    const e2ePage = await artifact(pageSource, true, true);
    const e2eWorker = await artifact(workerSource, true);
    expect(e2ePage).toContain('page-policy-offer');
    expect(e2eWorker).toContain('worker-fallback');
    for (const token of evidence) {
      expect(e2ePage).toContain(token);
      expect(e2eWorker).toContain(token);
    }
  });

  it.each([
    ['page-policy-offer', pageSource, true],
    ['worker-fallback', workerSource, false],
  ] as const)(
    'sanitizes %s evidence and reads only allowlisted headers',
    (initiator, source, ts) => {
      const get = vi.fn((name: string) => `value:${name}`);
      const { report, warnings } = reporter(source, ts);
      report(
        new URL('https://member:secret@wasm.example/core.wasm?capability=secret#fragment'),
        {
          url: 'https://member:secret@cdn.example/core.wasm?capability=secret#fragment',
          status: 403,
          type: 'cors',
          headers: { get },
        },
        new TypeError('url and capability must not escape'),
      );

      expect(warnings).toHaveLength(1);
      const found = payload(warnings[0]!);
      expect(found).toMatchObject({
        requestInitiator: initiator,
        pageOrigin: 'https://app.example',
        wasmUrl: 'https://wasm.example/core.wasm',
        response: {
          url: 'https://cdn.example/core.wasm',
          status: 403,
          type: 'cors',
          contentType: 'value:content-type',
          accessControlAllowOrigin: 'value:access-control-allow-origin',
          crossOriginResourcePolicy: 'value:cross-origin-resource-policy',
          crossOriginEmbedderPolicy: 'value:cross-origin-embedder-policy',
        },
        errorName: 'TypeError',
      });
      expect(found.workerUrl).toBe(
        initiator === 'worker-fallback' ? 'https://app.example/worker.js' : null,
      );
      expect(warnings[0]).not.toContain('secret');
      expect(get.mock.calls.map(([name]) => name)).toEqual([
        'content-type',
        'access-control-allow-origin',
        'cross-origin-resource-policy',
        'cross-origin-embedder-policy',
      ]);
    },
  );

  it('propagates the page-offer rejection unchanged and retries the next request', async () => {
    const failure = new TypeError('first compile failed');
    const response = { headers: { get: () => null }, status: 0, type: 'error', url: '' };
    const fetch = vi.fn(async () => response);
    const compileStreaming = vi
      .fn<(source: Promise<unknown>) => Promise<unknown>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ compiled: true });
    const harness = moduleHarness(pageSource, true, {
      startupMarkOnce: vi.fn(),
      SYNC_POLICY_OFFER: 'offer',
      SYNC_POLICY_REQUEST: 'request',
      fetch,
      AbortSignal,
      URL,
      location: { href: 'https://app.example/', origin: 'https://app.example' },
      console: { warn: vi.fn() },
      WebAssembly: { compileStreaming },
    });

    await expect(harness.syncPolicyModule!('deferred')).rejects.toBe(failure);
    await expect(harness.syncPolicyModule!('deferred')).resolves.toEqual({ compiled: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(compileStreaming).toHaveBeenCalledTimes(2);
  });

  it('propagates the Worker rejection unchanged and retries initialization', async () => {
    const failure = new TypeError('first init failed');
    const response = { headers: { get: () => null }, status: 0, type: 'error', url: '' };
    const fetch = vi.fn(async () => response);
    const init = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const harness = moduleHarness(workerSource, false, {
      init,
      rustEvaluate: vi.fn(),
      fetch,
      AbortSignal,
      URL,
      location: {
        href: 'https://app.example/worker.js',
        origin: 'https://app.example',
      },
      console: { warn: vi.fn() },
    });

    await expect(harness.initializeDeferred!()).rejects.toBe(failure);
    await expect(harness.initializeDeferred!()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenCalledTimes(2);
  });
});
