import { deriveLibraryId } from './wire';
import type { Vault, VaultChange } from './localVault';

const rawLibraryKey = (libraryKey: string): Uint8Array<ArrayBuffer> => {
  const raw = Uint8Array.from(atob(libraryKey), (character) => character.charCodeAt(0));
  if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== libraryKey) {
    raw.fill(0);
    throw new Error('Library key is not canonical');
  }
  return raw;
};

export async function libraryCacheId(libraryKey: string): Promise<string> {
  const raw = rawLibraryKey(libraryKey);
  try {
    return await deriveLibraryId(raw);
  } finally {
    raw.fill(0);
  }
}

export const libraryRetirementLock = (id: string): string => `den.library.${id}.retirement`;
export const libraryGenerationKey = (id: string): string => `retirement-generation:${id}`;

export const libraryStorageGeneration = async (
  vault: Vault,
  id: string,
): Promise<string | undefined> => {
  const value = await vault.get(libraryGenerationKey(id));
  if (!value) return undefined;
  const generation = new TextDecoder().decode(value);
  return /^[0-9a-f-]{36}$/.test(generation) ? generation : undefined;
};

/** Give one online library generation a physical namespace without changing its den-edge identity. */
export async function libraryGenerationVault(vault: Vault, id: string): Promise<Vault> {
  const generation = await libraryStorageGeneration(vault, id);
  if (!generation) return vault;
  const logical = `${id}:`;
  const physical = `${id}@${generation}:`;
  const key = (value: string) =>
    value.startsWith(logical) ? physical + value.slice(logical.length) : value;
  const unkey = (value: string) =>
    value.startsWith(physical) ? logical + value.slice(physical.length) : value;
  const changes = (values: readonly VaultChange[]): VaultChange[] =>
    values.map((change) => ({ ...change, key: key(change.key) }));
  return {
    get: (value) => vault.get(key(value)),
    ...(vault.getMany ? { getMany: (values) => vault.getMany!(values.map(key)) } : {}),
    entries: async (prefix) =>
      (await vault.entries(key(prefix))).map(([found, value]) => [unkey(found), value]),
    ...(vault.page
      ? {
          page: async (prefix: string, after: string | undefined, limit: number) =>
            (await vault.page!(key(prefix), after && key(after), limit)).map(([found, value]) => [
              unkey(found),
              value,
            ]),
        }
      : {}),
    put: (value, bytes) => vault.put(key(value), bytes),
    ...(vault.update
      ? {
          update: (value: string, updater: (current: Uint8Array | undefined) => Uint8Array) =>
            vault.update!(key(value), updater),
        }
      : {}),
    delete: (value) => vault.delete(key(value)),
    remove: (prefix) => vault.remove(key(prefix)),
    ...(vault.commit
      ? { commit: (values: readonly VaultChange[]) => vault.commit!(changes(values)) }
      : {}),
    ...(vault.compareAndCommit
      ? {
          compareAndCommit: (
            value: string,
            expected: Uint8Array | undefined,
            values: readonly VaultChange[],
          ) => vault.compareAndCommit!(key(value), expected, changes(values)),
        }
      : {}),
  };
}

/**
 * Hold this library's storage generation while a real Worker can still read or write it. Worker termination releases
 * a Web Lock even when the page cannot run graceful teardown; engines without Web Locks use dedicated Workers, whose
 * termination is the corresponding fence.
 */
export async function holdLibraryRetirementLease(libraryKey: string): Promise<() => void> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return () => {};
  const id = await libraryCacheId(libraryKey);
  return new Promise<() => void>((held, rejected) => {
    void locks
      .request(
        libraryRetirementLock(id),
        { mode: 'shared' },
        () => new Promise<void>((release) => held(release)),
      )
      .catch(rejected);
  });
}
