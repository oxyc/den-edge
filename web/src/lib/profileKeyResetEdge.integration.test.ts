import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { LibraryLog } from './log';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import {
  HttpProfileKeyResetBackend,
  observeResetSource,
  registerMember,
} from './profileKeyResetBackend';
import {
  ProfileKeyResetExecutor,
  type ProfileAdoptionRequest,
  type ProfileResetJournal,
} from './profileKeyResetExecutor';
import { ProfileKeyResetRecovery } from './profileKeyResetRecovery';
import { ProfileKeyResetService, VaultResetAdoption } from './profileKeyResetService';
import { profilesMaterialize } from './profilesCore';
import type { ProfileKidCreateVault } from './profileKidCreateWorker';
import { deriveKeys, fromBase64url, seal, sealPlaintext, type Row } from './wire';

/*
 * The Web adapter against the real den-edge: the binary, started on a free port with the key reset's surface on and the
 * profile migration's off, and the real LibraryLog primitives over HTTP. Nothing in den-edge is faked, so every response shape the adapter
 * relies on, the source digest, the generation on a retirement and the new-library guards are the production ones.
 *
 * It needs a built binary (`cargo build --locked`, or DEN_EDGE_BIN) and is skipped, visibly, without one.
 */

const BINARY = process.env.DEN_EDGE_BIN ?? resolve(__dirname, '../../../target/debug/den-edge');
const available = existsSync(BINARY);

const OWNER = '00112233445566778899aabbccddeeff';
const MINA = '11112222333344445555666677778888';
const LEO = '9999aaaabbbbccccddddeeeeffff0000';
const keyOf = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const RECOVERY = 'fedcba9876543210fedcba9876543210';

interface Edge {
  readonly base: string;
  fetch: typeof fetch;
  stop(): Promise<void>;
}

const running: Edge[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

async function startEdge(extra: Record<string, string> = {}): Promise<Edge> {
  const data = await mkdtemp(join(tmpdir(), 'den-edge-reset-'));
  const child: ChildProcess = spawn(BINARY, [], {
    env: {
      PORT: '0',
      DATA_DIR: data,
      PROFILE_RESET_ENABLED: '1',
      PROFILE_MIGRATION_ENABLED: '0',
      ...extra,
    },
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
    base,
    fetch: (async (input: string, init?: RequestInit) => {
      const response = await fetch(base + input, init);
      if (process.env.DEBUG_EDGE && response.status >= 400)
        console.log(init?.method ?? 'GET', input, response.status, await response.clone().text());
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

const preferences = (name: string) =>
  ({ kind: 'set', schema: 2, name, values: {} }) as unknown as Row;

async function seed(
  edge: Edge,
  key: string,
  wire: 4 | 5,
  rows: Row[],
  directory?: ProfileDirectoryDocument,
) {
  const keys = await deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
  const writes = await Promise.all(rows.map((row) => seal(keys, row)));
  if (directory)
    writes.push(
      await sealPlaintext(
        keys,
        'profiles',
        fromBase64url(profilesMaterialize(directory).plaintext),
      ),
    );
  const response = await edge.fetch(`/lib/${keys.id}/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-den-library-token': keys.token,
      'x-den-wire': String(wire),
      'x-den-wire-min': String(wire),
      'x-den-generation': '0',
    },
    body: JSON.stringify({ writes: writes.map(({ k, v }) => ({ k, base: 0, v })) }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

class MemoryVault implements ProfileKidCreateVault {
  readonly values = new Map<string, unknown>();
  constructor(readonly libraryId = '1'.repeat(32)) {}
  async keepRequired(name: string, value: unknown) {
    this.values.set(name, structuredClone(value));
  }
  async keptRequired<T>(name: string) {
    return this.values.has(name)
      ? { kind: 'value' as const, value: structuredClone(this.values.get(name)) as T }
      : { kind: 'absent' as const };
  }
  async discardKept(name: string) {
    this.values.delete(name);
  }
}

function directory(): ProfileDirectoryDocument {
  return validateStoredProfileDirectory(structuredClone(fixture.migrationBase));
}

/** A household with three profile libraries, each holding one row, on a real den-edge. */
async function world(householdKey: string) {
  const edge = await startEdge();
  const dir = directory();
  await seed(edge, householdKey, 5, [preferences('household')], dir);
  for (const id of [OWNER, MINA, LEO])
    await seed(edge, dir.profiles[id]!.library.value.key, 4, [
      preferences(`profile-${id.slice(0, 4)}`),
    ]);
  const open = (key: string, wire: 4 | 5) =>
    LibraryLog.forReset(key, wire, edge.fetch, undefined, null);
  return { edge, dir, open, householdKey };
}

const status = async (edge: Edge, key: string, wire: 4 | 5) => {
  const keys = await deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
  const response = await edge.fetch(`/lib/${keys.id}/changes?since=0&limit=1`, {
    headers: { 'x-den-library-token': keys.token, 'x-den-wire': String(wire) },
  });
  return response.status;
};

function serviceFor(w: Awaited<ReturnType<typeof world>>, vault = new MemoryVault()) {
  return {
    vault,
    service: new ProfileKeyResetService({
      vault,
      householdKey: w.householdKey,
      device: '0123456789abcdef',
      open: w.open,
      adoption: new VaultResetAdoption(
        {
          libraryId: vault.libraryId,
          keepRequired: vault.keepRequired.bind(vault),
          keptRequired: vault.keptRequired.bind(vault),
          rekeyKept: async () => {},
        } as never,
        async () => ({}) as LibraryLog,
      ),
      gate: async () => true,
      ownerPin: async () => true,
    }),
  };
}

/** Run the executor, with the real backend, until `until` holds of its journal. */
async function stepTo(
  w: Awaited<ReturnType<typeof world>>,
  until: (journal: ProfileResetJournal) => boolean,
) {
  const journal = {
    value: null as ProfileResetJournal | null,
    load: async () => (journal.value ? structuredClone(journal.value) : null),
    persist: async (next: ProfileResetJournal) => void (journal.value = structuredClone(next)),
    clear: async () => void (journal.value = null),
  };
  const adopted: ProfileAdoptionRequest[] = [];
  const executor = new ProfileKeyResetExecutor(
    new HttpProfileKeyResetBackend({
      journal,
      open: w.open,
      adoption: {
        adopt: async (request) => void adopted.push(request),
        isAdopted: async () => adopted.length > 0,
      },
      householdKey: w.householdKey,
      device: '0123456789abcdef',
    }),
  );
  const household = await w.open(w.householdKey, 5);
  await registerMember(household);
  const observed = await observeResetSource(household, 5);
  await executor.start(w.dir, w.householdKey, observed!.source);
  for (let round = 0; round < 100 && !until(journal.value!); round += 1) await executor.resume();
  expect(until(journal.value!)).toBe(true);
  return journal;
}

describe.skipIf(!available)(
  'the compound key reset against the real den-edge',
  { timeout: 60_000 },
  () => {
    it('moves a household and every profile, then waits for the page to install the successor', async () => {
      const w = await world(keyOf(4));
      const { service, vault } = serviceFor(w);
      const successor = keyOf(60);

      // Four old libraries already spent most of this address's new-library budget: the five successors start
      // only because a live reset's declared successors are not counted against it.
      await expect(service.start({ pin: '1234', destinationLibraryKey: successor })).resolves.toBe(
        'install',
      );

      expect(await status(w.edge, keyOf(4), 5)).toBe(410);
      for (const id of [OWNER, MINA, LEO])
        expect(await status(w.edge, w.dir.profiles[id]!.library.value.key, 4)).toBe(410);
      expect(await status(w.edge, successor, 5)).toBe(200);

      // The successor household holds the rotated directory and every household row.
      const snapshot = await (await w.open(successor, 5)).resetSnapshot();
      if (snapshot === null || typeof snapshot === 'string') throw new Error('no successor');
      expect(snapshot.names).toContain('set:household');
      expect(snapshot.directory).not.toBeNull();
      for (const id of [OWNER, MINA, LEO]) {
        const rotated = snapshot.directory!.profiles[id]!.library.value;
        expect(rotated.keyVersion).toBe(w.dir.profiles[id]!.library.value.keyVersion + 1);
        expect(rotated.key).not.toBe(w.dir.profiles[id]!.library.value.key);
        expect(await status(w.edge, rotated.key, 4)).toBe(200);
      }

      // The journal is still the last copy of the old keys until the page installs and confirms.
      expect(vault.values.has('profile-reset/v1/journal')).toBe(true);
      await expect(service.confirm({ destinationLibraryKey: successor })).resolves.toBe('complete');
      expect(vault.values.has('profile-reset/v1/journal')).toBe(false);
    });

    it('stays throttled for every other new library from the same address', async () => {
      const w = await world(keyOf(5));
      // Four seeds counted; the fifth is allowed; the sixth is refused, as before this change.
      await seed(w.edge, keyOf(70), 4, [preferences('x')]);
      const sixth = await deriveKeys(Uint8Array.from(atob(keyOf(71)), (c) => c.charCodeAt(0)));
      const response = await w.edge.fetch(`/lib/${sixth.id}/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-den-library-token': sixth.token,
          'x-den-wire': '4',
          'x-den-wire-min': '4',
          'x-den-generation': '0',
        },
        body: JSON.stringify({ writes: [{ k: 'a'.repeat(64), base: 0, v: 'AAAA' }] }),
      });
      expect(response.status).toBe(429);
    });

    it('rolls back an open reset from a device with no journal', async () => {
      const w = await world(keyOf(6));
      const journal = await stepTo(w, (j) => j.phase === 'locked');
      expect(journal.value).not.toBeNull();

      const recovery = new ProfileKeyResetRecovery({
        journal: { load: async () => null },
        open: w.open,
        householdKey: w.householdKey,
      });
      await expect(recovery.recover({ attempt: RECOVERY, successorKey: null })).resolves.toEqual({
        kind: 'aborted',
      });
      // The old libraries are intact and writable again, and the repeat finds the stored answer.
      for (const id of [OWNER, MINA, LEO])
        expect(await status(w.edge, w.dir.profiles[id]!.library.value.key, 4)).toBe(200);
      await expect(recovery.recover({ attempt: RECOVERY, successorKey: null })).resolves.toEqual({
        kind: 'aborted',
      });
    });

    it('rolls a committed reset back without proof, and finishes it with proof', async () => {
      const proofless = await world(keyOf(7));
      await stepTo(proofless, (j) => j.householdCommitted);
      const open = new ProfileKeyResetRecovery({
        journal: { load: async () => null },
        open: proofless.open,
        householdKey: proofless.householdKey,
      });
      await expect(open.recover({ attempt: RECOVERY, successorKey: null })).resolves.toEqual({
        kind: 'aborted',
      });
      expect(await status(proofless.edge, keyOf(7), 5)).toBe(200);

      const proven = await world(keyOf(8));
      const journal = await stepTo(proven, (j) => j.householdCommitted);
      const successorKey = journal.value!.newHouseholdKey;
      const finishing = new ProfileKeyResetRecovery({
        journal: { load: async () => null },
        open: proven.open,
        householdKey: proven.householdKey,
      });
      const result = await finishing.recover({ attempt: RECOVERY, successorKey });
      expect(result.kind).toBe('retired');
      expect(await status(proven.edge, keyOf(8), 5)).toBe(410);
      for (const id of [OWNER, MINA, LEO])
        expect(await status(proven.edge, proven.dir.profiles[id]!.library.value.key, 4)).toBe(410);
      // The repeat, with the household retired, is answered from its tombstone.
      await expect(finishing.recover({ attempt: RECOVERY, successorKey })).resolves.toMatchObject({
        kind: 'retired',
      });
    });

    it('is blocked, with no effect, once retirement began and no proof is held', async () => {
      const w = await world(keyOf(9));
      await stepTo(w, (j) => j.profiles.some((p) => p.oldRetired));
      const recovery = new ProfileKeyResetRecovery({
        journal: { load: async () => null },
        open: w.open,
        householdKey: w.householdKey,
      });
      await expect(recovery.recover({ attempt: RECOVERY, successorKey: null })).resolves.toEqual({
        kind: 'blocked',
      });
      expect(await status(w.edge, keyOf(9), 5)).toBe(200);
    });

    it('follows PROFILE_MIGRATION_ENABLED when PROFILE_RESET_ENABLED is unset', async () => {
      const observe = async (env: Record<string, string>) => {
        const edge = await startEdge(env);
        await seed(edge, keyOf(10), 5, [preferences('household')], directory());
        const household = await LibraryLog.forReset(keyOf(10), 5, edge.fetch, undefined, null);
        return observeResetSource(household, 5);
      };
      await expect(
        observe({ PROFILE_RESET_ENABLED: '', PROFILE_MIGRATION_ENABLED: '1' }),
      ).resolves.not.toBeNull();
      await expect(
        observe({ PROFILE_RESET_ENABLED: '', PROFILE_MIGRATION_ENABLED: '0' }),
      ).rejects.toMatchObject({ reason: 'library-unavailable' });
    });
  },
);

describe.skipIf(available)('the compound key reset against the real den-edge (skipped)', () => {
  it.skip('needs a built den-edge: cargo build --locked, or set DEN_EDGE_BIN', () => {});
});
