import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview, type PreviewServer } from 'vite';
import { previewDiagnostics } from './preview-diagnostics';

let root: string;
let server: PreviewServer | undefined;
type Record = {
  event: string;
  id?: number;
  path?: string;
  status?: number;
  pending?: { id: number; ageMs: number }[];
  elapsedMs?: number;
  rssBytes?: number;
};

afterEach(async () => {
  if (server && 'closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
  await server?.close();
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function start(failedOutput?: 'open' | 'mkdir') {
  vi.stubEnv('DEN_E2E', '1');
  root = await mkdtemp(join(tmpdir(), 'den-preview-diagnostics-'));
  await writeFile(join(root, 'index.html'), '<main>Library fixture</main>');
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'worker.js'), 'self.postMessage("ready");');
  const file =
    failedOutput === 'open'
      ? root
      : failedOutput === 'mkdir'
        ? join(root, 'index.html', 'preview.jsonl')
        : join(root, 'evidence', 'preview.jsonl');
  server = await preview({
    configFile: false,
    root,
    logLevel: 'silent',
    build: { outDir: root },
    preview: { host: '127.0.0.1', port: 0 },
    plugins: [
      previewDiagnostics(file),
      {
        name: 'held-request-fixture',
        configurePreviewServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url !== '/held') next();
          });
        },
      },
    ],
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP preview server');
  const records = async (): Promise<Record[]> => {
    const text = await readFile(file, 'utf8').catch(() => '');
    // A stream write can still be in flight while polling: consume complete JSONL records only.
    return text
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line));
  };
  return { origin: `http://127.0.0.1:${address.port}`, records, file };
}

it('retains actual SPA and worker request receipt/completion without query or header secrets', async () => {
  const { origin, records, file } = await start();
  const page = await fetch(`${origin}/watchlist?invite=fixture-secret`, {
    headers: { authorization: 'Bearer header-secret' },
  });
  expect(await page.text()).toContain('Library fixture');
  expect(await (await fetch(`${origin}/assets/worker.js`)).text()).toContain('postMessage');
  await expect
    .poll(async () => (await records()).filter((r) => r.event === 'finish').length)
    .toBe(2);
  const evidence = await records();
  expect(evidence.some((r) => r.event === 'listening')).toBe(true);
  const requests = evidence.filter((r) => r.event === 'request');
  expect(requests.map((r) => r.path)).toEqual(['/watchlist', '/assets/worker.js']);
  for (const request of requests)
    expect(evidence.find((r) => r.event === 'finish' && r.id === request.id)?.status).toBe(200);
  expect(await readFile(file, 'utf8')).not.toContain('secret');
});

it('redacts capability-bearing and unknown paths while continuing to serve them', async () => {
  const { origin, records, file } = await start();
  for (const path of [
    '/den/config-secret/manifest.json',
    '/direct/s/session-secret/signature-secret/movie',
    '/invite/invite-secret',
    '/recovery/recovery-secret',
    '/new-api/future-secret',
  ])
    expect(await (await fetch(`${origin}${path}`)).text()).toContain('Library fixture');
  await expect
    .poll(async () => (await records()).filter((r) => r.event === 'finish').length)
    .toBe(5);
  expect((await records()).filter((r) => r.event === 'request').map((r) => r.path)).toEqual(
    Array(5).fill('/[redacted]'),
  );
  expect(await readFile(file, 'utf8')).not.toContain('secret');
});

it('distinguishes a received but unanswered request from a completed request and a client abort', async () => {
  const { origin, records } = await start();
  const held = get(`${origin}/held`);
  held.on('error', () => {});
  try {
    await expect.poll(async () => (await records()).some((r) => r.event === 'request')).toBe(true);
    const request = (await records()).find((r) => r.event === 'request')!;
    await expect
      .poll(
        async () => (await records()).some((r) => r.pending?.some((p) => p.id === request.id)),
        {
          timeout: 5_000,
        },
      )
      .toBe(true);
    const sample = (await records()).find((r) => r.event === 'sample')!;
    expect(sample.elapsedMs).toBeGreaterThan(0);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(await (await fetch(`${origin}/watchlist`)).text()).toContain('Library fixture');
    await expect.poll(async () => (await records()).some((r) => r.event === 'finish')).toBe(true);
    held.destroy();
    await expect
      .poll(async () => (await records()).some((r) => r.event === 'close' && r.id === request.id))
      .toBe(true);
    expect((await records()).some((r) => r.event === 'finish' && r.id === request.id)).toBe(false);
  } finally {
    held.destroy();
  }
});

it.each(['open', 'mkdir'] as const)(
  'keeps serving if diagnostic file %s fails',
  async (failure) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { origin } = await start(failure);
    expect(await (await fetch(`${origin}/watchlist`)).text()).toContain('Library fixture');
    await expect
      .poll(() => warning.mock.calls)
      .toEqual([['TV preview diagnostics unavailable; continuing without server evidence.']]);
  },
);

it('does not install diagnostics without an explicit path and refuses them outside isolated E2E', () => {
  expect(previewDiagnostics(undefined)).toBe(false);
  vi.stubEnv('DEN_E2E', '');
  expect(() => previewDiagnostics('/tmp/not-a-production-log')).toThrow('require DEN_E2E=1');
});
