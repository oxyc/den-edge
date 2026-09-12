// What this browser keeps of a library between visits, in IndexedDB: its record log as last read and the last Home it
// showed, so a return visit starts from them instead of from nothing. The log seals every value under a key only the
// library key derives (`LibraryLog.keep`), so nothing here is more readable than it is on den-edge.

import { deriveKeys } from './wire';

export interface Vault {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  /** Drop every value whose key starts with `prefix`. */
  remove(prefix: string): Promise<void>;
}

/** This browser's IndexedDB, or null where there is none or it is refused (a private window, blocked site data). */
function indexedVault(): Vault | null {
  let factory: IDBFactory;
  try {
    factory = globalThis.indexedDB;
    if (!factory) return null;
  } catch {
    return null;
  }
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = factory.open('den-library', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kept');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, work: (kept: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const tx = database.transaction('kept', mode);
          const req = work(tx.objectStore('kept'));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  return {
    get: (key) => run('readonly', (kept) => kept.get(key) as IDBRequest<Uint8Array | undefined>),
    put: async (key, value) => {
      await run('readwrite', (kept) => kept.put(value, key));
    },
    remove: async (prefix) => {
      const range = IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff));
      await run('readwrite', (kept) => kept.delete(range));
    },
  };
}

export const libraryVault = indexedVault();

/** Drop what this browser kept of the library `libraryKey` opens: the link to it is gone. */
export async function forgetLibrary(libraryKey: string, vault = libraryVault): Promise<void> {
  if (!vault) return;
  const { id } = await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0)));
  await vault.remove(`${id}:`);
}
