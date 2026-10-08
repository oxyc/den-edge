import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedVault, transactions } from './localVault';

afterEach(() => vi.unstubAllGlobals());

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
            let completionQueued = false;
            const request = <T>(result: T) => {
              if (!completionQueued) {
                completionQueued = true;
                queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
              }
              return { result } as IDBRequest<T>;
            };
            const selected = (range?: IDBKeyRange | IDBValidKey) =>
              [...data]
                .filter(([key]) => {
                  if (!range || typeof range === 'string')
                    return range === undefined || key === range;
                  const bounds = range as IDBKeyRange;
                  return key >= String(bounds.lower) && key <= String(bounds.upper);
                })
                .sort(([a], [b]) => a.localeCompare(b));
            const store = {
              get: (key: string) => request(data.get(key)),
              getAllKeys: (range: IDBKeyRange) => request(selected(range).map(([key]) => key)),
              getAll: (range: IDBKeyRange) => request(selected(range).map(([, value]) => value)),
              put: (value: unknown, key: string) => {
                data.set(key, value);
                return request(key);
              },
              delete: (key: IDBKeyRange | IDBValidKey) => {
                for (const [found] of selected(key)) data.delete(found);
                return request(undefined);
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

  it('returns a compound result after its requests commit and rejects a result that cannot be formed', async () => {
    const idb = fakeIndexedDB();
    idb.data.set('a', 1);
    const run = read(idb);
    expect(
      await run('readonly', (kept) => {
        const value = kept.get('a');
        return () => value.result;
      }),
    ).toBe(1);
    await expect(
      run('readonly', (kept) => {
        kept.get('a');
        return () => {
          throw new Error('unreadable result');
        };
      }),
    ).rejects.toThrow('unreadable result');
  });
});

describe('indexedVault', () => {
  it('scans one prefix in key order, deletes one exact key, and removes a whole prefix', async () => {
    const idb = fakeIndexedDB();
    vi.stubGlobal('IDBKeyRange', {
      bound: (lower: IDBValidKey, upper: IDBValidKey) => ({ lower, upper }),
    });
    const vault = indexedVault(idb.factory);
    const bytes = (value: number) => new Uint8Array([value]);

    // Deliberately not key order: IndexedDB's ordered scan is part of the adapter contract.
    await vault.put('lib:pending:b', bytes(2));
    await vault.put('lib:pending:a', bytes(1));
    await vault.put('lib:pending:a:longer', bytes(3));
    await vault.put('lib:meta', bytes(4));

    expect(await vault.entries('lib:pending:')).toEqual([
      ['lib:pending:a', bytes(1)],
      ['lib:pending:a:longer', bytes(3)],
      ['lib:pending:b', bytes(2)],
    ]);

    await vault.delete('lib:pending:a');
    expect(await vault.entries('lib:pending:a')).toEqual([['lib:pending:a:longer', bytes(3)]]);

    await vault.remove('lib:pending:');
    expect(await vault.entries('lib:pending:')).toEqual([]);
    expect(await vault.get('lib:meta')).toEqual(bytes(4));
  });
});
