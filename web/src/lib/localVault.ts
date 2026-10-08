// What this browser keeps of a library between visits, in IndexedDB: its record log as last read and the last Home it
// showed, so a return visit starts from them instead of from nothing. The log seals every value under a key only the
// library key derives (`LibraryLog.keep`), so nothing here is more readable than it is on den-edge.

import { deriveKeys } from './wire';

export interface Vault {
  get(key: string): Promise<Uint8Array | undefined>;
  /** Every key/value pair whose key starts with `prefix`, in IndexedDB key order. */
  entries(prefix: string): Promise<Array<[key: string, value: Uint8Array]>>;
  put(key: string, value: Uint8Array): Promise<void>;
  /** Atomically replace one value from its current value. `updater` runs synchronously inside a write transaction. */
  update?(
    key: string,
    updater: (current: Uint8Array | undefined) => Uint8Array,
  ): Promise<Uint8Array>;
  /** Drop exactly `key`; unlike `remove`, longer keys with this prefix remain. */
  delete(key: string): Promise<void>;
  /** Drop every value whose key starts with `prefix`. */
  remove(prefix: string): Promise<void>;
}

/** A transaction on one object store, with the request `work` makes in it: its result once the transaction is done. */
export type Transact = <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | (() => T) | void,
) => Promise<T | undefined>;

/**
 * Transactions on the object store `store` of the database `name`, over one connection opened on first use and
 * opened again when it is lost. A connection that failed to open, that the browser closed (`close`), or that another
 * tab's newer version asked to be closed (`versionchange`) was kept for the life of the page, and every read and
 * write after it failed until a reload.
 */
export function transactions(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
  store: string,
): Transact {
  let db: Promise<IDBDatabase> | undefined;
  const connect = () => {
    if (db) return db;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name, version);
      req.onupgradeneeded = () => upgrade(req.result);
      req.onsuccess = () => {
        const database = req.result;
        database.onclose = () => {
          if (db === opening) db = undefined;
        };
        database.onversionchange = () => {
          database.close();
          if (db === opening) db = undefined;
        };
        resolve(database);
      };
      req.onerror = () => reject(req.error);
    });
    db = opening;
    opening.catch(() => {
      if (db === opening) db = undefined;
    });
    return opening;
  };
  const once = <T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T> | (() => T) | void,
  ) =>
    new Promise<T | undefined>((resolve, reject) => {
      const tx = database.transaction(store, mode);
      const result = work(tx.objectStore(store));
      tx.oncomplete = () => {
        try {
          resolve(typeof result === 'function' ? result() : result ? result.result : undefined);
        } catch (error) {
          reject(error);
        }
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  return async (mode, work) => {
    const opening = connect();
    const database = await opening;
    try {
      return await once(database, mode, work);
    } catch (error) {
      // A connection closed under it without saying so: opened again, and tried once more.
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
      if (db === opening) db = undefined;
      return once(await connect(), mode, work);
    }
  };
}

const prefixRange = (prefix: string) =>
  IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff));

/** A vault on `factory`; injectable so its ordering and deletion contract can be exercised without a browser. */
export function indexedVault(factory: IDBFactory): Vault {
  const run = transactions(
    factory,
    'den-library',
    1,
    (database) => database.createObjectStore('kept'),
    'kept',
  );
  return {
    get: (key) => run('readonly', (kept) => kept.get(key) as IDBRequest<Uint8Array | undefined>),
    entries: async (prefix) => {
      const found = await run('readonly', (kept) => {
        const range = prefixRange(prefix);
        const keys = kept.getAllKeys(range);
        const values = kept.getAll(range) as IDBRequest<Uint8Array[]>;
        // Both requests belong to this transaction, so their ordered results describe one snapshot.
        return () =>
          keys.result.flatMap((key, index) =>
            typeof key === 'string' && values.result[index]
              ? [[key, values.result[index]!] as [string, Uint8Array]]
              : [],
          );
      });
      return found ?? [];
    },
    put: async (key, value) => {
      await run('readwrite', (kept) => kept.put(value, key));
    },
    update: async (key, updater) => {
      const updated = await run('readwrite', (kept) => {
        const read = kept.get(key) as IDBRequest<Uint8Array | undefined>;
        let next: Uint8Array;
        read.onsuccess = () => {
          next = updater(read.result);
          // Returning the object read is an explicit no-op; it need not dirty the object store.
          if (next !== read.result) kept.put(next, key);
        };
        return () => next!;
      });
      return updated!;
    },
    delete: async (key) => {
      await run('readwrite', (kept) => kept.delete(key));
    },
    remove: async (prefix) => {
      await run('readwrite', (kept) => kept.delete(prefixRange(prefix)));
    },
  };
}

/** This browser's IndexedDB, or null where there is none or it is refused (a private window, blocked site data). */
function browserVault(): Vault | null {
  let factory: IDBFactory;
  try {
    factory = globalThis.indexedDB;
    if (!factory) return null;
  } catch {
    return null;
  }
  return indexedVault(factory);
}

export const libraryVault = browserVault();

/** Drop what this browser kept of the library `libraryKey` opens: the link to it is gone. */
export async function forgetLibrary(libraryKey: string, vault = libraryVault): Promise<void> {
  if (!vault) return;
  const { id } = await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0)));
  await vault.remove(`${id}:`);
}
