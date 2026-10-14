import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../src/vendor/den-core/profiles-v1.json';
import { validateStoredProfileDirectory } from '../src/lib/profileDirectory';
import { profilesMaterialize } from '../src/lib/profileMigrationCore';
import {
  deriveKeys,
  fromBase64url,
  openMigrationRow,
  seal,
  sealPlaintext,
  type DocumentRow,
  type LibraryKeys,
  type Row,
  type SettingsRow,
  type Stamp,
} from '../src/lib/wire';

/*
 * The household repair end to end: the real den-edge binary, a profile-aware household and its Owner library as the
 * split leaves them, the Owner-only rows a stale browser wrote back into the household, and the repair command run as
 * an operator runs it. Needs a built binary (`cargo build --locked`, or DEN_EDGE_BIN); skipped, visibly, without one.
 */

const BINARY = process.env.DEN_EDGE_BIN ?? resolve(__dirname, '../../target/debug/den-edge');
const available = existsSync(BINARY);
const SCRIPT = resolve(__dirname, 'repair-household.mjs');
const KID = '11112222333344445555666677778888';
const run = promisify(execFile);

const at = (t: number): Stamp => [t, 0, 'a1b2c3d4e5f60718'];
const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const settings = (name: string, values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name,
  values,
});
const film = (id: number, fields: Record<string, unknown> = {}): DocumentRow => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id },
  status: { value: 'watchlist', at: at(1000) },
  addedAt: 1000,
  ...fields,
});

interface Edge {
  base: string;
  stop(): Promise<void>;
}
const running: Edge[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function startEdge(): Promise<Edge> {
  const data = await mkdtemp(join(tmpdir(), 'den-edge-repair-'));
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
  const edge = {
    base,
    stop: async () => {
      child.kill();
      await rm(data, { recursive: true, force: true });
    },
  };
  running.push(edge);
  return edge;
}

const keysOf = (key: string) => deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));

/** Every stored row, by `k`, as den-edge holds it. */
async function stored(edge: Edge, keys: LibraryKeys, wire: number) {
  const response = await fetch(`${edge.base}/lib/${keys.id}/changes?since=0&limit=1000`, {
    headers: { 'x-den-library-token': keys.token, 'x-den-wire': String(wire) },
  });
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    head: number;
    entries: { k: string; v: string; seq: number }[];
  };
  return {
    head: page.head,
    generation: response.headers.get('x-den-generation') ?? '0',
    rows: new Map(page.entries.map((entry) => [entry.k, entry])),
  };
}

/** Compare-and-set writes at the seq each row is stored at: a write-back, as a browser sends one. */
async function write(edge: Edge, key: string, wire: number, sealed: { k: string; v: string }[]) {
  const keys = await keysOf(key);
  const { rows, generation } = await stored(edge, keys, wire).catch(() => ({
    rows: new Map<string, { seq: number }>(),
    generation: '0',
  }));
  const response = await fetch(`${edge.base}/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': keys.token,
      'x-den-wire': String(wire),
      'x-den-wire-min': String(wire),
      'x-den-generation': generation,
    },
    body: JSON.stringify({
      writes: sealed.map(({ k, v }) => ({ k, base: rows.get(k)?.seq ?? 0, v })),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const batch = (await response.json()) as { conflicts: unknown[] };
  expect(batch.conflicts).toEqual([]);
}

const sealAll = async (key: string, rows: Row[]) => {
  const keys = await keysOf(key);
  return Promise.all(rows.map((row) => seal(keys, row)));
};

/** Each stored row opened, by name; the Kid approvals row by its own name. */
async function opened(edge: Edge, key: string, wire: number) {
  const keys = await keysOf(key);
  const { head, rows } = await stored(edge, keys, wire);
  const byName = new Map<string, Record<string, unknown>>();
  for (const { k, v } of rows.values()) {
    const row = await openMigrationRow(keys, k, v);
    if (row.status === 'document') byName.set(row.name, row.document);
    else if (row.status === 'row') byName.set(row.name ?? `unnamed:${k}`, row.row);
  }
  return { head, byName, keys: [...rows.keys()] };
}

const directory = validateStoredProfileDirectory(structuredClone(fixture.migrationBase));
const OWNER_KEY = directory.profiles[directory.owner]!.library.value.key;

const ownerPrefs = settings('prefs', { 'den.hideAnime': { value: { bool: true }, at: at(500) } });
const householdPrefs = settings('prefs', {
  'den.regionOverride': { value: { string: 'FI' }, at: at(600) },
});
const trackers = settings('trackers', { 'simkl.user': { value: { string: 'u' }, at: at(700) } });

/** The household and Owner library as the split leaves them, then the stale browser's write-back. */
async function polluted(householdKey: string) {
  const edge = await startEdge();
  const keys = await keysOf(householdKey);
  const approvals = await sealPlaintext(
    keys,
    `kid-title-approvals:${KID}`,
    new Uint8Array([
      0,
      ...deflateRawSync(
        JSON.stringify({
          format: 4,
          kind: 'kid-title-approvals',
          schema: 1,
          kid: KID,
          approvals: { 'movie:550': { value: 'allow', at: at(10) } },
        }),
      ),
    ]),
  );
  const profiles = await sealPlaintext(
    keys,
    'profiles',
    fromBase64url(profilesMaterialize(directory).plaintext),
  );
  await write(edge, householdKey, 5, [
    ...(await sealAll(householdKey, [
      householdPrefs,
      settings('keys', { tmdb: { value: { string: 'household-tmdb' }, at: at(600) } }),
      settings('devices', { 'tv.seen': { value: { int: 1 }, at: at(600) } }),
    ])),
    approvals,
    profiles,
  ]);
  await write(
    edge,
    OWNER_KEY,
    4,
    await sealAll(OWNER_KEY, [
      film(1),
      film(2),
      trackers,
      ownerPrefs,
      settings('keys', { simkl: { value: { string: 'owner-simkl' }, at: at(600) } }),
    ]),
  );

  // The stale browser held the pre-split library: the same titles (one with a later reaction the Owner never got),
  // the Owner's trackers, an assistant journal, a hand-off, and preferences and keys still whole.
  await write(
    edge,
    householdKey,
    5,
    await sealAll(householdKey, [
      film(1),
      film(2, { reaction: { value: 'love', at: at(2000) } }),
      trackers,
      settings('assistant-applied', { 'grant.1': { value: { bool: true }, at: at(800) } }),
      settings(`handoff:${KID}`, { 'tv.at': { value: { int: 5 }, at: at(800) } }),
      settings('prefs', { ...householdPrefs.values, ...ownerPrefs.values }),
      settings('keys', {
        tmdb: { value: { string: 'household-tmdb' }, at: at(600) },
        simkl: { value: { string: 'owner-simkl' }, at: at(600) },
      }),
    ]),
  );
  return { edge, approvals, profiles };
}

async function repair(edge: Edge, householdKey: string, ...flags: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'den-repair-keys-'));
  try {
    const file = join(dir, 'household.key');
    await writeFile(file, `${householdKey}\n`, { mode: 0o600 });
    const { stdout } = await run(
      process.execPath,
      [SCRIPT, '--edge', edge.base, '--key-file', file, ...flags],
      { cwd: resolve(__dirname, '..') },
    );
    const result = /^result: (.*)$/m.exec(stdout)?.[1];
    expect(result, stdout).toBeTruthy();
    return { stdout, report: JSON.parse(result!) as Record<string, unknown> };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!available)(
  'the household repair against the real den-edge',
  { timeout: 120_000 },
  () => {
    it('secures the Owner, strips the Owner rows from the household, and is a no-op the second time', async () => {
      const householdKey = keyOf(41);
      const { edge, approvals, profiles } = await polluted(householdKey);
      const ownerBefore = await opened(edge, OWNER_KEY, 4);
      const householdBefore = await opened(edge, householdKey, 5);

      // The dry run, the default, reports and writes nothing.
      const dry = await repair(edge, householdKey);
      expect(dry.report).toMatchObject({
        outcome: 'dry-run',
        ownerRows: {
          'title:': 2,
          'set:trackers': 1,
          'set:assistant-applied': 1,
          'set:handoff:*': 1,
          'set:prefs': 1,
          'set:keys': 1,
        },
        ownerKeys: { 'set:prefs': ['den.hideAnime'], 'set:keys': ['simkl'] },
        // title 2's reaction and the assistant journal and hand-off the Owner never had.
        ownerWrites: 3,
      });
      expect(dry.stdout).not.toContain('owner-simkl');
      expect((await opened(edge, householdKey, 5)).head).toBe(householdBefore.head);
      expect((await opened(edge, OWNER_KEY, 4)).head).toBe(ownerBefore.head);

      const applied = await repair(edge, householdKey, '--apply');
      expect(applied.report).toMatchObject({
        outcome: 'repaired',
        ownerWrites: 3,
        before: { ownerRows: 7 },
        after: { ownerRows: 0 },
      });

      // The Owner gained exactly what only the household held, and lost nothing.
      const owner = await opened(edge, OWNER_KEY, 4);
      expect(owner.head).toBe(ownerBefore.head + 3);
      expect(owner.byName.get('title:movie:2')).toMatchObject({ reaction: { value: 'love' } });
      expect(owner.byName.has('set:assistant-applied')).toBe(true);
      expect(owner.byName.has(`set:handoff:${KID}`)).toBe(true);
      expect(owner.byName.get('set:keys')).toMatchObject({ values: { simkl: {} } });

      // The household keeps every household row, the directory and the approvals, and no Owner row or key.
      const household = await opened(edge, householdKey, 5);
      expect([...household.byName.keys()].filter((n) => /^(title|season|dlv):/.test(n))).toEqual(
        [],
      );
      for (const name of ['set:trackers', 'set:assistant-applied', `set:handoff:${KID}`])
        expect(household.byName.has(name)).toBe(false);
      expect(Object.keys((household.byName.get('set:prefs') as SettingsRow).values)).toEqual([
        'den.regionOverride',
      ]);
      expect(Object.keys((household.byName.get('set:keys') as SettingsRow).values)).toEqual([
        'tmdb',
      ]);
      expect(household.byName.has('set:devices')).toBe(true);
      // The directory and the approvals are kept byte for byte.
      const raw = (await stored(edge, await keysOf(householdKey), 5)).rows;
      expect(raw.get(approvals.k)?.v).toBe(approvals.v);
      expect(raw.get(profiles.k)?.v).toBe(profiles.v);
      expect(household.keys).toHaveLength(5);
      const capability = await fetch(
        `${edge.base}/lib/${(await keysOf(householdKey)).id}/profile-capability`,
        {
          headers: {
            'x-den-library-token': (await keysOf(householdKey)).token,
            'x-den-wire': '5',
          },
        },
      );
      expect(((await capability.json()) as { wireMin: number }).wireMin).toBe(5);

      // A second run finds nothing and changes nothing.
      const again = await repair(edge, householdKey, '--apply');
      expect(again.report).toMatchObject({ outcome: 'clean', ownerWrites: 0 });
      expect((await opened(edge, householdKey, 5)).head).toBe(household.head);
      expect((await opened(edge, OWNER_KEY, 4)).head).toBe(owner.head);
    });

    it('refuses a household with no profiles directory, whose Owner rows are its own', async () => {
      const edge = await startEdge();
      const key = keyOf(42);
      await write(edge, key, 5, await sealAll(key, [film(1), trackers]));
      await expect(repair(edge, key, '--apply')).rejects.toThrow(/no profiles directory/);
      expect((await opened(edge, key, 5)).byName.has('title:movie:1')).toBe(true);
    });
  },
);

describe.skipIf(available)('the household repair against the real den-edge (skipped)', () => {
  it.skip('needs a built den-edge: cargo build --locked, or set DEN_EDGE_BIN', () => {});
});
