import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedVault, StorageTimeoutError, transactions } from './localVault';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Just enough of IndexedDB for `transactions`: each `open` makes a connection (or fails, while `failing`), each
 * connection answers `get` from one shared map, and a closed one throws as a browser's does.
 */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const connections: (IDBDatabase & { closed: boolean })[] = [];
  const madeTransactions: IDBTransaction[] = [];
  let failing = false;
  let stallingTransactions = false;
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
            let pending = 0;
            let completionQueued = false;
            const complete = () => {
              if (pending || completionQueued || stallingTransactions) return;
              completionQueued = true;
              queueMicrotask(() => {
                completionQueued = false;
                if (!pending) tx.oncomplete?.(new Event('complete'));
              });
            };
            const request = <T>(result: T) => {
              pending += 1;
              const req = { result } as IDBRequest<T>;
              queueMicrotask(() => {
                req.onsuccess?.(new Event('success'));
                pending -= 1;
                complete();
              });
              return req;
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
            Object.assign(tx, { objectStore: () => store, abort: vi.fn() });
            madeTransactions.push(tx);
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
    transactions: madeTransactions,
    factory,
    fail: (value: boolean) => (failing = value),
    stallTransactions: (value: boolean) => (stallingTransactions = value),
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

  it('bounds an IndexedDB open that never answers and opens afresh on the next call', async () => {
    vi.useFakeTimers();
    const requests: IDBOpenDBRequest[] = [];
    const factory = {
      open: vi.fn(() => {
        const request = {} as IDBOpenDBRequest;
        requests.push(request);
        return request;
      }),
    } as unknown as IDBFactory;
    const run = transactions(factory, 'test', 1, () => undefined, 'kept', {
      openMs: 20,
      transactionMs: 20,
    });

    const first = run('readonly', () => undefined);
    const failed = expect(first).rejects.toMatchObject({
      name: 'StorageTimeoutError',
      phase: 'open',
    });
    await vi.advanceTimersByTimeAsync(20);
    await failed;

    const lateDatabase = { close: vi.fn() } as unknown as IDBDatabase;
    Object.defineProperty(requests[0], 'result', { value: lateDatabase });
    requests[0]!.onsuccess?.(new Event('success'));
    expect(lateDatabase.close).toHaveBeenCalledOnce();

    const second = run('readonly', () => undefined);
    expect(factory.open).toHaveBeenCalledTimes(2);
    const secondFailed = expect(second).rejects.toMatchObject({ phase: 'open' });
    await vi.advanceTimersByTimeAsync(20);
    await secondFailed;
  });

  it('bounds a stalled transaction, closes its connection, and reports the transaction phase', async () => {
    vi.useFakeTimers();
    const idb = fakeIndexedDB();
    idb.stallTransactions(true);
    const run = transactions(idb.factory, 'test', 1, () => undefined, 'kept', {
      openMs: 20,
      transactionMs: 20,
    });

    const reading = run('readonly', (kept) => kept.get('a'));
    let resolved = false;
    const outcome = reading.then(
      () => {
        resolved = true;
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(20);
    await expect(outcome).resolves.toEqual(new StorageTimeoutError('transaction'));
    expect(idb.connections[0]!.closed).toBe(true);
    expect(idb.transactions[0]!.abort).toHaveBeenCalledOnce();

    // A late browser completion cannot turn the already-failed operation into success.
    idb.transactions[0]!.oncomplete?.(new Event('complete'));
    await Promise.resolve();
    expect(resolved).toBe(false);
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

    expect(await vault.update?.('lib:meta', (current) => bytes(current![0]! + 1))).toEqual(
      bytes(5),
    );
    expect(await vault.get('lib:meta')).toEqual(bytes(5));

    await vault.remove('lib:pending:');
    expect(await vault.entries('lib:pending:')).toEqual([]);
    expect(await vault.get('lib:meta')).toEqual(bytes(5));
  });
});
