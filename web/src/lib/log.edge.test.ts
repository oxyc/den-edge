import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addToWatchlist, blankTitle, markWatched } from './actions';
import { LibraryLog, LibraryUpdateRequiredError } from './log';
import { applyOps, opsFor } from './libraryV4';
import { deriveKeys, seal, type TitleRow } from './wire';

// Opt in because this starts the real Rust HTTP/store fixture. Ordinary Vitest runs need no Cargo toolchain.
// Run: DEN_EDGE_REAL_RECOVERY=1 npm test -- src/lib/log.edge.test.ts
describe.skipIf(process.env.DEN_EDGE_REAL_RECOVERY !== '1')('LibraryLog against real Edge', () => {
  let child: ChildProcess | undefined;
  let exited: Promise<void>;
  let origin: string | undefined;
  let directory: string;

  async function start() {
    origin = undefined;
    child = spawn(
      'cargo',
      [
        'test',
        '--locked',
        'library::recovery_client_server::serve_real_client',
        '--',
        '--exact',
        '--ignored',
        '--nocapture',
      ],
      {
        cwd: process.env.EDGE_RECOVERY_CARGO_DIR ?? resolve(process.cwd(), '..'),
        env: { ...process.env, EDGE_RECOVERY_DIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let output = '';
    exited = new Promise((resolve) => child!.once('exit', () => resolve()));
    origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Edge startup timed out:\n${output}`)),
        120_000,
      );
      function consume(data: Buffer) {
        output += data.toString();
        const match = output.match(/EDGE_RECOVERY_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      }
      child!.stdout!.on('data', consume);
      child!.stderr!.on('data', consume);
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
  }

  async function waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function stop() {
    const stopping = child;
    const address = origin;
    origin = undefined;
    if (!stopping) return;
    try {
      if (address && stopping.exitCode === null) {
        await fetch(`${address}/__test/shutdown`, { signal: AbortSignal.timeout(2000) }).catch(
          () => undefined,
        );
      }
      if (!(await waitForExit(2000))) {
        // Cargo owns a child test binary. Kill the whole isolated group if graceful shutdown fails.
        if (process.platform !== 'win32' && stopping.pid) {
          try {
            process.kill(-stopping.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        } else stopping.kill('SIGKILL');
        if (!(await waitForExit(2000)))
          throw new Error('Edge fixture did not exit after forced shutdown');
      }
    } finally {
      child = undefined;
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'den-edge-client-933-'));
    await start();
  }, 130_000);

  afterAll(async () => {
    await stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 10_000);

  const storage = () => {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => values.clear(),
    } satisfies Storage;
  };
  const title = (id: number) =>
    addToWatchlist(blankTitle({ type: 'movie', id }, 1000), [1000, 0, 'aaaaaaaaaaaaaaaa']);
  const documents = (row: TitleRow) =>
    applyOps(opsFor(blankTitle(row.title, 1000), row), () => undefined);

  it.each([4, 5])(
    'recovers a delayed write across minimum %i with real crypto and persistent readback',
    async (minimum) => {
      const key = new Uint8Array(32).fill(minimum);
      const encoded = btoa(String.fromCharCode(...key));
      const keys = await deriveKeys(key);
      const headers = (generation: string, wire = 4) => ({
        'x-den-library-token': keys.token,
        'x-den-generation': generation,
        'x-den-wire': String(wire),
        'content-type': 'application/json',
      });
      const path = `/lib/${keys.id}`;
      const initial = await Promise.all(
        [...documents(title(1)), ...documents(title(2))].map((row) => seal(keys, row)),
      );
      const created = await fetch(`${origin}${path}/batch`, {
        method: 'POST',
        headers: { ...headers('0'), 'x-den-wire-min': '4' },
        body: JSON.stringify({ writes: initial.map((row) => ({ ...row, base: 0 })) }),
      });
      expect(created.status).toBe(200);
      const oldGeneration = created.headers.get('x-den-generation')!;
      let hold = false;
      const writes: { status: number; generation: string | null }[] = [];
      const connection: typeof fetch = async (input, init = {}) => {
        const batch = String(input).endsWith('/batch');
        const requestHeaders = new Headers(init.headers);
        if (batch && hold) {
          hold = false;
          requestHeaders.set('x-den-test-hold-body', '1');
        }
        const response = await fetch(new URL(String(input), origin), {
          ...init,
          headers: requestHeaders,
        });
        if (batch)
          writes.push({
            status: response.status,
            generation: response.headers.get('x-den-generation'),
          });
        return response;
      };
      const persisted = storage();
      const oldClient = (await LibraryLog.open(encoded, connection, persisted, null))!;
      expect(oldClient.title({ type: 'movie', id: 1 })).toBeDefined();
      const settled = new Promise<void>((resolve) => {
        oldClient.onDeferred = () => resolve();
      });
      hold = true;
      // This is new user intent for title 3. Title 1 is only an acknowledged old snapshot and must not be replayed
      // by the refused batch's immediate retry. Restore write-back after an explicit refresh has separate rules.
      const pending = oldClient.write(title(3));
      await fetch(`${origin}/__test/entered`, { signal: AbortSignal.timeout(10_000) });
      const opened = await fetch(`${origin}${path}/rewrite`, {
        method: 'POST',
        headers: headers(oldGeneration, minimum),
      });
      expect(opened.status).toBe(200);
      const { rewrite, base } = (await opened.json()) as { rewrite: string; base: number };
      const replacement = await Promise.all(
        documents(markWatched(title(2), [2000, 0, 'bbbbbbbbbbbbbbbb'])).map((row) =>
          seal(keys, row),
        ),
      );
      const staged = await fetch(`${origin}${path}/rewrite/${rewrite}/rows`, {
        method: 'POST',
        headers: headers(oldGeneration, minimum),
        body: JSON.stringify({ writes: replacement }),
      });
      expect(staged.status).toBe(200);
      const committed = await fetch(`${origin}${path}/rewrite/${rewrite}/commit`, {
        method: 'POST',
        headers: headers(oldGeneration, minimum),
        body: JSON.stringify({ base, wireMin: minimum }),
      });
      expect(committed.status).toBe(200);
      const current = committed.headers.get('x-den-generation')!;
      const read = async () => {
        const response = await fetch(`${origin}${path}/changes`, {
          headers: headers(current, minimum),
        });
        expect(response.status).toBe(200);
        return response.json() as Promise<{ head: number; entries: { k: string; v: string }[] }>;
      };
      const before = await read();
      await fetch(`${origin}/__test/release`);
      await pending;
      await settled;
      expect(writes[0]).toEqual({ status: minimum === 4 ? 409 : 426, generation: current });
      const after = await read();
      if (minimum === 4) {
        expect(writes.map(({ status }) => status)).toEqual([409, 200]);
        expect(oldClient.pendingActions).toBe(0);
        expect(after.head).toBe(before.head + 1);
        const currentClient = (await LibraryLog.open(encoded, connection, storage(), null))!;
        expect(currentClient.title({ type: 'movie', id: 1 })).toBeUndefined();
        expect(currentClient.title({ type: 'movie', id: 2 })?.status.value).toBe('watched');
        expect(currentClient.title({ type: 'movie', id: 3 })?.status.value).toBe('watchlist');
        expect(await currentClient.write(title(4), undefined, false)).not.toBeNull();
        currentClient.close();
      } else {
        expect(oldClient.upgradeRequired).toBe(5);
        expect(oldClient.readOnly).toBe(true);
        expect(oldClient.pendingActions).toBeGreaterThan(0);
        expect(after).toEqual(before);
        // Recovery remains durable when the old app is reopened: its queued intent is still present and fenced.
        await expect(LibraryLog.open(encoded, connection, persisted, null)).rejects.toEqual(
          expect.objectContaining<Partial<LibraryUpdateRequiredError>>({
            name: 'LibraryUpdateRequiredError',
            requiredWire: 5,
          }),
        );
      }
      oldClient.close();
      const durable = await read();
      await stop();
      await start();
      expect(await read()).toEqual(durable);
    },
    150_000,
  );

  it.skipIf(process.env.EDGE_RECOVERY_TIMINGS !== '1')(
    'records matched local unchanged-writer timing diagnostics',
    async () => {
      // The Rust test build deliberately caps libraries at eight rows; keep that production test limit intact.
      for (const count of [1, 8]) {
        const id = count === 1 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb';
        const valueBytes = count === 1 ? 1024 : 32 * 1024;
        let generation = '0';
        let writes = Array.from({ length: count }, (_, index) => ({
          k: index.toString(16).padStart(16, '0'),
          base: 0,
          v: 'x'.repeat(valueBytes),
        }));
        const samples: number[] = [];
        for (let batch = 0; batch <= 150; batch++) {
          const started = performance.now();
          const response = await fetch(`${origin}/lib/${id}/batch`, {
            method: 'POST',
            headers: {
              'x-den-library-token': 'local-diagnostic',
              'x-den-wire': '4',
              'x-den-wire-min': '4',
              'x-den-generation': generation,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ writes }),
          });
          if (response.status !== 200)
            throw new Error(
              `rows=${count} batch=${batch}: ${response.status} ${await response.text()}`,
            );
          generation = response.headers.get('x-den-generation')!;
          const answer = (await response.json()) as { applied: { k: string; seq: number }[] };
          expect(answer.applied).toHaveLength(count);
          if (batch > 0) samples.push(performance.now() - started);
          writes = writes.map((row, index) => ({ ...row, base: answer.applied[index]!.seq }));
        }
        samples.sort((a, b) => a - b);
        console.info(
          'edge-batch-diagnostic',
          JSON.stringify({
            rows: count,
            valueBytes,
            batches: samples.length,
            p50Ms: samples[75],
            p95Ms: samples[142],
            totalMs: samples.reduce((a, b) => a + b, 0),
            qualification:
              'local unoptimized HTTP + durable redb; warm library; no production budget',
          }),
        );
      }
    },
    150_000,
  );

  it('shuts down within the cleanup bound even with an admitted body held', async () => {
    const pending = fetch(`${origin}/lib/cccccccccccccccc/batch`, {
      method: 'POST',
      headers: {
        'x-den-library-token': 'cleanup-control',
        'x-den-wire': '4',
        'x-den-wire-min': '4',
        'x-den-generation': '0',
        'x-den-test-hold-body': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ writes: [{ k: 'aaaaaaaaaaaaaaaa', base: 0, v: 'current' }] }),
    });
    await fetch(`${origin}/__test/entered`, { signal: AbortSignal.timeout(10_000) });
    await stop();
    expect((await pending).status).toBe(200);
    await start();
  }, 130_000);
});
