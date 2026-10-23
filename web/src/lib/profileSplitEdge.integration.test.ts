import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryLog } from './log';
import { registerMember } from './profileKeyResetBackend';
import { ensureSyncPolicy } from './syncLoader';
import { deriveKeys, seal, sealPlaintext, type Row } from './wire';

/*
 * What the Den Web profile split needs of a real household, against the real den-edge binary. Nothing in den-edge is
 * faked. (A household cannot be seeded while `NEW_LIBRARIES=members`, so the store here is open; the candidate's
 * generation handling does not depend on it.)
 *
 * It needs a built binary (`cargo build --locked`, or DEN_EDGE_BIN) and is skipped, visibly, without one.
 */

const BINARY = process.env.DEN_EDGE_BIN ?? resolve(__dirname, '../../../target/debug/den-edge');
const available = existsSync(BINARY);

const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const keysOf = (key: string) => deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
const settings = (name: string) => ({ kind: 'set', schema: 2, name, values: {} }) as unknown as Row;

interface Edge {
  fetch: typeof fetch;
  stop(): Promise<void>;
}

const running: Edge[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function startEdge(): Promise<Edge> {
  const data = await mkdtemp(join(tmpdir(), 'den-edge-split-'));
  const child: ChildProcess = spawn(BINARY, [], {
    env: { PORT: '0', DATA_DIR: data, PROFILE_MIGRATION_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise<string>((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`den-edge did not start:\n${output}`)), 20_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const port = /listening on :(\d+)/.exec(output)?.[1];
      if (port) {
        clearTimeout(timer);
        done(`http://127.0.0.1:${port}`);
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('exit', (code) => fail(new Error(`den-edge exited ${code}:\n${output}`)));
  });
  const edge: Edge = {
    fetch: ((input: string, init?: RequestInit) => fetch(base + input, init)) as typeof fetch,
    stop: async () => {
      child.kill();
      await rm(data, { recursive: true, force: true });
    },
  };
  running.push(edge);
  return edge;
}

/** A first batch starts the library. */
async function seedHousehold(
  edge: Edge,
  key: string,
  rows: Row[],
  sealed: { k: string; v: string }[] = [],
) {
  const keys = await keysOf(key);
  const writes = [...(await Promise.all(rows.map((row) => seal(keys, row)))), ...sealed];
  const response = await edge.fetch(`/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': keys.token,
      'x-den-wire': '4',
      'x-den-wire-min': '4',
      'x-den-generation': '0',
    },
    body: JSON.stringify({ writes: writes.map(({ k, v }) => ({ k, base: 0, v })) }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return keys;
}

const storedKeys = async (edge: Edge, keys: Awaited<ReturnType<typeof keysOf>>) => {
  const response = await edge.fetch(`/lib/${keys.id}/changes?since=0&limit=1000`, {
    headers: { 'x-den-library-token': keys.token, 'x-den-wire': '4' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { entries: { k: string }[] }).entries.map(({ k }) => k);
};

type Writer = {
  writeMigrationCandidate(keys: unknown, writes: { k: string; v: string }[]): Promise<void>;
  readMigrationCandidate(keys: unknown): Promise<{ k: string }[]>;
};

describe.skipIf(!available)(
  'the profile split against the real den-edge',
  { timeout: 60_000 },
  () => {
    it('writes an Owner candidate of several chunks, past the one that creates the library', async () => {
      const edge = await startEdge();
      await seedHousehold(edge, keyOf(31), [settings('household')]);
      const household = await LibraryLog.forReset(keyOf(31), 4, edge.fetch, undefined, null);
      await registerMember(household);

      const candidate = await keysOf(keyOf(32));
      // More rows than one rewrite batch holds, so the write is more than one request.
      const rows = await Promise.all(
        Array.from({ length: 450 }, (_, index) => seal(candidate, settings(`owner-${index}`))),
      );
      const io = household as unknown as Writer;
      await io.writeMigrationCandidate(candidate, rows);

      expect(new Set((await io.readMigrationCandidate(candidate)).map(({ k }) => k))).toEqual(
        new Set(rows.map(({ k }) => k)),
      );
    });

    it('switches a v4 library that holds a tracker event this build cannot read as a row', async () => {
      const edge = await startEdge();
      // A restore left a v1 tracker event as a bare row, under no name this build can attribute it to. This build holds
      // no row for it, but an older build's switch removes it, and the split refuses it until then.
      const keys = await keysOf(keyOf(33));
      const event = {
        schema: 1,
        id: 'e2',
        at: [5000, 0, 'aaaaaaaaaaaaaaaa'],
        after: {
          kind: 'ep',
          schema: 2,
          title: { type: 'tv', id: 1399 },
          season: 1,
          episode: 2,
          progress: { value: 1, viewing: 1, at: [5000, 0, 'aaaaaaaaaaaaaaaa'] },
        },
      };
      const bare = await sealPlaintext(
        keys,
        'bare-event',
        new TextEncoder().encode(JSON.stringify(event)),
      );
      // A library that already holds documents is a v4 library a stray row was written into, not a pre-v3 backup.
      await ensureSyncPolicy();
      const film = {
        format: 4,
        kind: 'title',
        title: { type: 'movie', id: 7 },
        status: { value: 'watchlist', at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
        addedAt: 1000,
      } as unknown as Row;
      await seedHousehold(edge, keyOf(33), [settings('prefs'), film], [bare]);
      expect(await storedKeys(edge, keys)).toContain(bare.k);

      const log = (await LibraryLog.open(keyOf(33), edge.fetch, undefined, null))!;
      expect(log.readOnly).toBe(true);
      expect(await storedKeys(edge, keys)).toContain(bare.k);
    });
  },
);

describe.skipIf(available)('the profile split against the real den-edge (skipped)', () => {
  it.skip('needs a built den-edge: cargo build --locked, or set DEN_EDGE_BIN', () => {});
});
