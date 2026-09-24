import { describe, expect, it } from 'vitest';
import { transactions } from './localVault';

/**
 * Just enough of IndexedDB for `transactions`: each `open` makes a connection (or fails, while `failing`), each
 * connection answers `get` from one shared map, and a closed one throws as a browser's does.
 */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const connections: (IDBDatabase & { closed: boolean })[] = [];
  let failing = false;
  const factory = {
    open: () => {
      const req = {} as IDBOpenDBRequest & { result: IDBDatabase; error: DOMException | null };
      queueMicrotask(() => {
        if (failing) {
          req.error = new DOMException('refused', 'UnknownError');
          req.onerror?.(new Event('error'));
          return;
        }
        const database = {
          closed: false,
          close(this: { closed: boolean }) {
            this.closed = true;
          },
          transaction(this: { closed: boolean }) {
            if (this.closed) throw new DOMException('closing', 'InvalidStateError');
            const tx = {} as IDBTransaction;
            const store = {
              get: (key: string) => {
                const request = { result: data.get(key) } as IDBRequest;
                queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                return request;
              },
            };
            Object.assign(tx, { objectStore: () => store });
            return tx;
          },
        } as unknown as IDBDatabase & { closed: boolean };
        connections.push(database);
        req.result = database;
        req.onsuccess?.(new Event('success'));
      });
      return req;
    },
  } as unknown as IDBFactory;
  return {
    data,
    connections,
    factory,
    fail: (value: boolean) => (failing = value),
  };
}

describe('transactions', () => {
  const read = (idb: ReturnType<typeof fakeIndexedDB>) =>
    transactions(idb.factory, 'test', 1, () => undefined, 'kept');

  it('opens again after an open that failed, rather than failing for the life of the page', async () => {
    const idb = fakeIndexedDB();
    idb.data.set('a', 1);
    const run = read(idb);
    idb.fail(true);
    await expect(run('readonly', (kept) => kept.get('a'))).rejects.toThrow('refused');
    idb.fail(false);
    expect(await run('readonly', (kept) => kept.get('a'))).toBe(1);
  });

  it('opens again after the connection is closed, whether it says so or not', async () => {
    const idb = fakeIndexedDB();
    idb.data.set('a', 1);
    const run = read(idb);
    expect(await run('readonly', (kept) => kept.get('a'))).toBe(1);

    // Another tab opened a newer version.
    idb.connections[0]!.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
    expect(idb.connections[0]!.closed).toBe(true);
    expect(await run('readonly', (kept) => kept.get('a'))).toBe(1);
    expect(idb.connections).toHaveLength(2);

    // Closed with no event at all.
    idb.connections[1]!.close();
    expect(await run('readonly', (kept) => kept.get('a'))).toBe(1);
    expect(idb.connections).toHaveLength(3);
  });
});
