import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LibraryRetirements } from './libraryRetirement.svelte';
import { holdLibraryRetirementLease, libraryGenerationVault } from './libraryRetirementLease';
import type { Vault } from './localVault';

const libraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const utf8 = new TextEncoder();

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function vault() {
  const values = new Map<string, Uint8Array>();
  let refuseRetirement = false;
  const implementation: Vault = {
    get: async (key) => values.get(key),
    entries: async (prefix) =>
      [...values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)),
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
    remove: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    retire: async (prefix, receipt, expected) => {
      if (refuseRetirement) throw new DOMException('refused', 'UnknownError');
      const current = values.get(receipt);
      if (
        !current ||
        current.byteLength !== expected.byteLength ||
        !current.every((byte, index) => byte === expected[index])
      )
        return false;
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
      values.delete(receipt);
      return true;
    },
    update: async (key, updater) => {
      const next = updater(values.get(key));
      values.set(key, next);
      return next;
    },
  };
  return {
    implementation,
    values,
    refuse: (value: boolean) => (refuseRetirement = value),
  };
}

function locks() {
  const tails = new Map<string, Promise<unknown>>();
  let requested = 0;
  const manager = {
    request: (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown> | unknown,
    ) => {
      requested++;
      const run = (tails.get(name) ?? Promise.resolve()).then(() =>
        callback({ name, mode: options.mode ?? 'exclusive' } as unknown as Lock),
      );
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  } as unknown as LockManager;
  return { manager, requested: () => requested };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('navigator', {});
});

afterEach(() => vi.unstubAllGlobals());

it('keeps a credential-free receipt, deletes one exact prefix, and durably reads it back', async () => {
  const kept = vault();
  const retirements = new LibraryRetirements(kept.implementation);
  const receipt = await retirements.prepare(libraryKey);
  expect(receipt).not.toBeNull();
  expect(JSON.stringify(receipt)).not.toContain(libraryKey);
  kept.values.set(`${receipt!.id}:history`, utf8.encode('old'));
  kept.values.set(`${receipt!.id}-other:history`, utf8.encode('unrelated'));
  kept.values.set('local:history', utf8.encode('local'));

  retirements.start(receipt);
  await vi.waitFor(() => expect(retirements.pending).toEqual([]));
  expect(kept.values.has(`${receipt!.id}:history`)).toBe(false);
  expect(kept.values.has(`${receipt!.id}-other:history`)).toBe(true);
  expect(kept.values.has('local:history')).toBe(true);
  expect(localStorage.getItem('den.libraryRetirements')).toBeNull();

  const relinked = await libraryGenerationVault(kept.implementation, receipt!.id);
  await relinked.put(`${receipt!.id}:history`, utf8.encode('fresh'));
  expect(kept.values.has(`${receipt!.id}:history`)).toBe(false);
  expect(kept.values.has(`${receipt!.id}@${receipt!.token}:history`)).toBe(true);
  expect(await relinked.entries(`${receipt!.id}:`)).toEqual([
    [`${receipt!.id}:history`, utf8.encode('fresh')],
  ]);
});

it('survives a failed cleanup and reload, then an explicit retry settles the same receipt', async () => {
  const kept = vault();
  kept.refuse(true);
  const first = new LibraryRetirements(kept.implementation);
  const receipt = await first.prepare(libraryKey);
  kept.values.set(`${receipt!.id}:history`, utf8.encode('old'));
  first.start(receipt);
  await vi.waitFor(() => expect(first.pending[0]?.failure).toBe('storage'));

  // A reload reconstructs the credential-free receipt from durable storage, including its visible failure.
  const reloaded = new LibraryRetirements(kept.implementation);
  await reloaded.refresh(false);
  expect(reloaded.pending).toEqual([
    expect.objectContaining({ id: receipt!.id, failure: 'storage' }),
  ]);
  kept.refuse(false);
  reloaded.retry();
  await vi.waitFor(() => expect(reloaded.pending).toEqual([]));
  expect(kept.values.has(`${receipt!.id}:history`)).toBe(false);
});

it('waits for the old Worker lease and makes an immediate relink wait behind cleanup', async () => {
  const queue = locks();
  vi.stubGlobal('navigator', { locks: queue.manager });
  const kept = vault();
  const oldRelease = await holdLibraryRetirementLease(libraryKey);
  const retirements = new LibraryRetirements(kept.implementation);
  const receipt = await retirements.prepare(libraryKey);
  kept.values.set(`${receipt!.id}:history`, utf8.encode('old'));
  retirements.start(receipt);
  // Old shared lease, generation-prepare lock, then the queued retirement exclusive.
  await vi.waitFor(() => expect(queue.requested()).toBe(3));

  let relinked = false;
  const relink = holdLibraryRetirementLease(libraryKey).then((release) => {
    relinked = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(retirements.pending).toHaveLength(1);
  expect(relinked).toBe(false);

  oldRelease();
  await vi.waitFor(() => expect(retirements.pending).toEqual([]));
  expect(kept.values.has(`${receipt!.id}:history`)).toBe(false);
  const relinkRelease = await relink;
  expect(relinked).toBe(true);
  relinkRelease();
});

it('does not let a superseded completion clear the newer retirement receipt', async () => {
  const kept = vault();
  const retirements = new LibraryRetirements(kept.implementation);
  const stale = await retirements.prepare(libraryKey);
  const current = await retirements.prepare(libraryKey);
  expect(current!.token).not.toBe(stale!.token);
  kept.values.set(`${current!.prefix}history`, utf8.encode('old'));

  retirements.start(stale);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(retirements.pending).toEqual([current]);
  expect(kept.values.has(`${current!.prefix}history`)).toBe(true);
  expect(new TextDecoder().decode(kept.values.get(`retirement-generation:${current!.id}`))).toBe(
    current!.token,
  );

  retirements.start(current);
  await vi.waitFor(() => expect(retirements.pending).toEqual([]));
  expect(kept.values.has(`${current!.prefix}history`)).toBe(false);
});
