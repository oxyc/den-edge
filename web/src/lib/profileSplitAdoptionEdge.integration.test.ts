import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import { validateStoredProfileDirectory } from './profileDirectory';
import { profilesMaterialize } from './profileMigrationCore';
import { ensureSyncPolicy } from './syncLoader';
import {
  deriveKeys,
  fromBase64url,
  openEntry,
  rowName,
  seal,
  sealPlaintext,
  type Row,
  type Stamp,
} from './wire';

/*
 * A browser that cached a household before its profile split committed, against the real den-edge binary: on its next
 * visit it must adopt the split household (profiles-v1 §8.2), not write the old household back into it. Nothing in
 * den-edge is faked. The split's committed state is built with den-edge's own rewrite (a new generation, wire minimum
 * 5, the household half of the rows and the `profiles` directory) beside an Owner library holding the profile half.
 *
 * It needs a built binary (`cargo build --locked`, or DEN_EDGE_BIN) and is skipped, visibly, without one.
 */

const BINARY = process.env.DEN_EDGE_BIN ?? resolve(__dirname, '../../../target/debug/den-edge');
const available = existsSync(BINARY);

const OWNER = '00112233445566778899aabbccddeeff';
const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const keysOf = (key: string) => deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
const at = (t: number): Stamp => [t, 0, 'a1b2c3d4e5f60718'];

interface Request {
  method: string;
  path: string;
  status: number;
}

interface Edge {
  fetch: typeof fetch;
  requests: Request[];
  stop(): Promise<void>;
}

const running: Edge[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function startEdge(): Promise<Edge> {
  const data = await mkdtemp(join(tmpdir(), 'den-edge-adopt-'));
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
  const requests: Request[] = [];
  const edge: Edge = {
    requests,
    fetch: (async (input: string, init?: RequestInit) => {
      const response = await fetch(base + input, init);
      requests.push({ method: init?.method ?? 'GET', path: input, status: response.status });
      return response;
    }) as typeof fetch,
    stop: async () => {
      child.kill();
      await rm(data, { recursive: true, force: true });
    },
  };
  running.push(edge);
  return edge;
}

function memoryVault(): { data: Map<string, Uint8Array>; vault: Vault } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    vault: {
      get: async (key) => data.get(key),
      entries: async (prefix) => [...data].filter(([key]) => key.startsWith(prefix)),
      put: async (key, value) => void data.set(key, value),
      delete: async (key) => void data.delete(key),
      remove: async (prefix) => {
        for (const key of [...data.keys()]) if (key.startsWith(prefix)) data.delete(key);
      },
    },
  };
}

const settings = (name: string, values: Record<string, unknown>) =>
  ({
    kind: 'set',
    schema: 2,
    name,
    values: Object.fromEntries(
      Object.entries(values).map(([key, value], index) => [key, { value, at: at(100 + index) }]),
    ),
  }) as unknown as Row;

const film = (id: number) =>
  ({
    format: 4,
    kind: 'title',
    title: { type: 'movie', id },
    status: { value: 'watchlist', at: at(1000) },
    addedAt: 1000,
  }) as unknown as Row;

/** Owner's rows, as the household held them before the split. */
const OWNER_ROWS = () => [
  film(7),
  film(8),
  settings('trackers', { trakt: { string: 'owner-token' } }),
  settings('assistant-applied', { 'a-1': { bool: true } }),
];
const PREFS = { 'den.watchRegion': { string: 'FI' }, 'den.hideWatched': { bool: true } };
const KEYS = { tmdb: { string: 'household-tmdb' }, simkl: { string: 'owner-simkl' } };

const write = (keys: Awaited<ReturnType<typeof keysOf>>, wire: string, generation: string) => ({
  'content-type': 'application/json',
  'x-den-library-token': keys.token,
  'x-den-wire': wire,
  'x-den-wire-min': wire,
  'x-den-generation': generation,
});

async function seed(edge: Edge, key: string, rows: Row[]) {
  const keys = await keysOf(key);
  const writes = await Promise.all(rows.map((row) => seal(keys, row)));
  const response = await edge.fetch(`/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: write(keys, '4', '0'),
    body: JSON.stringify({ writes: writes.map(({ k, v }) => ({ k, base: 0, v })) }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function entries(edge: Edge, key: string, wire = '5') {
  const keys = await keysOf(key);
  const response = await edge.fetch(`/lib/${keys.id}/changes?since=0&limit=1000`, {
    headers: { 'x-den-library-token': keys.token, 'x-den-wire': wire },
  });
  expect(response.status).toBe(200);
  return {
    generation: response.headers.get('x-den-generation')!,
    entries: ((await response.json()) as { entries: { k: string; seq: number; v: string }[] })
      .entries,
  };
}

/** The committed split: den-edge's rewrite to wire minimum 5, holding the household half and the directory. */
async function commitSplit(edge: Edge, householdKey: string) {
  await ensureSyncPolicy();
  const keys = await keysOf(householdKey);
  const directory = validateStoredProfileDirectory(structuredClone(fixture.migrationBase));
  const ownerKey = directory.profiles[OWNER]!.library.value.key;
  await seed(edge, ownerKey, [
    ...OWNER_ROWS(),
    settings('prefs', PREFS),
    settings('keys', { simkl: KEYS.simkl }),
  ]);
  const { generation } = await entries(edge, householdKey, '4');
  const headers = write(keys, '5', generation);
  const opened = (await (
    await edge.fetch(`/lib/${keys.id}/rewrite`, { method: 'POST', headers })
  ).json()) as { rewrite: string; base: number };
  const rows = await Promise.all(
    [
      settings('household', { 'den.name': { string: 'Home' } }),
      settings('keys', { tmdb: KEYS.tmdb }),
    ].map((row) => seal(keys, row)),
  );
  rows.push(
    await sealPlaintext(keys, 'profiles', fromBase64url(profilesMaterialize(directory).plaintext)),
  );
  const staged = await edge.fetch(`/lib/${keys.id}/rewrite/${opened.rewrite}/rows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writes: rows }),
  });
  expect(staged.status, await staged.clone().text()).toBe(200);
  const committed = await edge.fetch(`/lib/${keys.id}/rewrite/${opened.rewrite}/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base: opened.base, wireMin: 5 }),
  });
  expect(committed.status, await committed.clone().text()).toBe(200);
  return ownerKey;
}

/** Every write this log queued, and every save of what it keeps, has finished. */
async function settled(log: LibraryLog) {
  const internals = log as unknown as { writes: Promise<unknown>; saving: Promise<unknown> };
  for (let round = 0; round < 3; round++) {
    await internals.writes;
    await internals.saving;
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe.skipIf(!available)(
  'a cached household meeting its committed profile split, against the real den-edge',
  { timeout: 60_000 },
  () => {
    it('adopts the split household in two tabs at once, and writes nothing of the old one back', async () => {
      const edge = await startEdge();
      const household = keyOf(41);
      const keys = await keysOf(household);
      const { data, vault } = memoryVault();
      await seed(edge, household, [
        ...OWNER_ROWS(),
        settings('household', { 'den.name': { string: 'Home' } }),
        settings('prefs', PREFS),
        settings('keys', KEYS),
      ]);

      // A tab reads the household whole and keeps it in this browser.
      const before = (await LibraryLog.open(household, edge.fetch, undefined, vault, 4))!;
      await settled(before);
      expect(before.rows().length).toBeGreaterThan(0);

      // An edit made while den-edge was out of reach is kept, unsent.
      const offline = (await LibraryLog.open(
        household,
        (() => Promise.reject(new TypeError('offline'))) as typeof fetch,
        undefined,
        vault,
        4,
      ))!;
      expect(offline.fromCache).toBe(true);
      await offline.write({
        kind: 'rec',
        schema: 2,
        title: { type: 'movie', id: 9 },
        status: { value: 'watchlist', at: at(2000) },
        resume: { value: 0, at: at(2000), viewing: 0 },
        reaction: { value: null, at: at(2000) },
        deleted: { value: false, at: at(2000) },
        dismissed: { value: false, at: at(2000) },
        episodesReset: null,
        addedAt: 2000,
        watchedAt: null,
      });
      await settled(offline);
      expect(offline.pendingActions).toBe(1);
      offline.close();

      const ownerKey = await commitSplit(edge, household);
      const split = await entries(edge, household);
      const owner = await entries(edge, ownerKey, '4');

      // The open wire-4 tab learns the household needs wire 5, and the page reopens it there.
      await before.refresh();
      expect(before.upgradeRequired).toBe(5);
      before.close();

      const batches = () =>
        edge.requests.filter(
          ({ method, path }) => method === 'POST' && path.startsWith(`/lib/${keys.id}/batch`),
        ).length;
      const batchesBefore = batches();
      const tabs = await Promise.all(
        [0, 1].map(
          async () => (await LibraryLog.open(household, edge.fetch, undefined, vault, 5))!,
        ),
      );
      expect(tabs.every((tab) => tab.fromCache)).toBe(true);
      for (let round = 0; round < 3; round++) {
        await Promise.all(tabs.map((tab) => tab.refresh()));
        await Promise.all(tabs.map(settled));
      }

      expect(batches() - batchesBefore, 'batches the reopened tabs sent to the household').toBe(0);
      // The household is exactly what the split committed: nothing of the old household came back.
      const after = await entries(edge, household);
      expect(after.generation).toBe(split.generation);
      expect(after.entries).toEqual(split.entries);
      const names: string[] = [];
      for (const { k, v } of after.entries) {
        const opened = await openEntry(keys, k, v);
        if ('profileDirectory' in opened) {
          names.push('profiles');
          continue;
        }
        expect('row' in opened, `household row ${k} opens`).toBe(true);
        const row = (opened as { row: Row }).row;
        names.push(rowName(row));
        if (row.kind === 'set' && row.name === 'keys')
          expect(Object.keys(row.values)).toEqual(['tmdb']);
      }
      // Every preference is a profile's: the split household holds no `set:prefs`.
      expect(names.sort()).toEqual(['profiles', 'set:household', 'set:keys']);
      // The Owner library is untouched.
      expect((await entries(edge, ownerKey, '4')).entries).toEqual(owner.entries);

      // No work kept for the old household survives: no restore, and not the unsent edit.
      for (const tab of tabs) expect(tab.pendingActions).toBe(0);
      expect(
        [...data.keys()].filter((key) => key.startsWith(`${keys.id}:runtime:pending:`)),
      ).toEqual([]);
      // The tabs hold the split household, not the old rows.
      for (const tab of tabs) {
        expect(tab.profileDirectory()).not.toBeNull();
        expect(tab.title({ type: 'movie', id: 7 })).toBeUndefined();
      }
      // Its membership was registered, under the generation den-edge holds.
      const members = edge.requests.filter(
        ({ method, path }) => method === 'PUT' && path === `/lib/${keys.id}/member`,
      );
      expect(members.some(({ status }) => status < 300)).toBe(true);
    });

    it('writes a split household only its own rows, no prefs, and only the household half of keys', async () => {
      const edge = await startEdge();
      const household = keyOf(43);
      const keys = await keysOf(household);
      await seed(edge, household, [settings('household', { 'den.name': { string: 'Home' } })]);
      await commitSplit(edge, household);
      const log = (await LibraryLog.open(
        household,
        edge.fetch,
        undefined,
        memoryVault().vault,
        5,
      ))!;
      expect(log.profileDirectory()).not.toBeNull();
      const split = await entries(edge, household);

      expect(await log.write(settings('trackers', { trakt: { string: 'token' } }))).toBeNull();
      expect(await log.writeAt(settings('handoff:tv', { x: { bool: true } }) as never, 0)).toBe(
        false,
      );
      expect(await log.writeAt(film(11) as never, 0)).toBe(false);
      expect((await entries(edge, household)).entries).toEqual(split.entries);

      expect(await log.write(settings('prefs', PREFS))).toBeNull();
      const stored = new Map<string, Row>();
      for (const { k, v } of (await entries(edge, household)).entries) {
        const opened = await openEntry(keys, k, v);
        if ('row' in opened) stored.set(rowName(opened.row as Row), opened.row as Row);
      }
      expect(stored.has('set:prefs')).toBe(false);
      expect([...stored.keys()].filter((name) => name.startsWith('set:tr'))).toEqual([]);
    });

    it('recovers an ordinary generation change once, however many tabs hold the library', async () => {
      const edge = await startEdge();
      const household = keyOf(44);
      const keys = await keysOf(household);
      const { vault } = memoryVault();
      const rows = Array.from({ length: 10 }, (_, index) =>
        settings(`note-${index}`, { text: { string: `n${index}` } }),
      );
      await seed(edge, household, rows);
      await settled((await LibraryLog.open(household, edge.fetch, undefined, vault, 4))!);

      // A restore from an empty backup: a new generation that holds none of the rows, still at wire 4.
      const { generation } = await entries(edge, household, '4');
      const headers = write(keys, '4', generation);
      const opened = (await (
        await edge.fetch(`/lib/${keys.id}/rewrite`, { method: 'POST', headers })
      ).json()) as { rewrite: string; base: number };
      const staged = await edge.fetch(`/lib/${keys.id}/rewrite/${opened.rewrite}/rows`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          writes: [await seal(keys, settings('household', { 'den.name': { string: 'Home' } }))],
        }),
      });
      expect(staged.status).toBe(200);
      const committed = await edge.fetch(`/lib/${keys.id}/rewrite/${opened.rewrite}/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ base: opened.base, wireMin: 4 }),
      });
      expect(committed.status, await committed.clone().text()).toBe(200);
      const { head } = (await committed.json()) as { head: number };

      const batches = () =>
        edge.requests.filter(
          ({ method, path }) => method === 'POST' && path.startsWith(`/lib/${keys.id}/batch`),
        ).length;
      const batchesBefore = batches();
      const tabs = await Promise.all(
        [0, 1].map(
          async () => (await LibraryLog.open(household, edge.fetch, undefined, vault, 4))!,
        ),
      );
      for (let round = 0; round < 3; round++) {
        await Promise.all(tabs.map((tab) => tab.refresh()));
        await Promise.all(tabs.map(settled));
      }

      // Every row is back, written once; the second tab finds den-edge already holding what it would write.
      const after = await entries(edge, household, '4');
      expect(after.entries.length).toBe(rows.length + 1);
      expect(Math.max(...after.entries.map(({ seq }) => seq))).toBe(head + rows.length);
      expect(batches() - batchesBefore).toBeLessThanOrEqual(2);
      for (const tab of tabs) expect(tab.pendingActions).toBe(0);
    });

    it('registers a fresh open of an existing library without a generation conflict', async () => {
      const edge = await startEdge();
      const household = keyOf(42);
      const keys = await keysOf(household);
      await seed(edge, household, [settings('household', { 'den.name': { string: 'Home' } })]);

      const log = (await LibraryLog.open(
        household,
        edge.fetch,
        undefined,
        memoryVault().vault,
        4,
      ))!;
      await settled(log);

      const members = edge.requests.filter(
        ({ method, path }) => method === 'PUT' && path === `/lib/${keys.id}/member`,
      );
      expect(members.map(({ status }) => status)).toEqual([200]);
    });
  },
);

describe.skipIf(available)(
  'a cached household meeting its committed profile split (skipped)',
  () => {
    it.skip('needs a built den-edge: cargo build --locked, or set DEN_EDGE_BIN', () => {});
  },
);
