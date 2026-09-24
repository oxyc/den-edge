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

/** A transaction on one object store, with the request `work` makes in it: its result once the transaction is done. */
export type Transact = <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void,
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
    work: (store: IDBObjectStore) => IDBRequest<T> | void,
  ) =>
    new Promise<T | undefined>((resolve, reject) => {
      const tx = database.transaction(store, mode);
      const req = work(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
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

/** This browser's IndexedDB, or null where there is none or it is refused (a private window, blocked site data). */
function indexedVault(): Vault | null {
  let factory: IDBFactory;
  try {
    factory = globalThis.indexedDB;
    if (!factory) return null;
  } catch {
    return null;
  }
  const run = transactions(
    factory,
    'den-library',
    1,
    (database) => database.createObjectStore('kept'),
    'kept',
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
