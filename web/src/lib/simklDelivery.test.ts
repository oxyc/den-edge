import { beforeAll, expect, it, vi } from 'vitest';
import { initialize } from '../vendor/den-core/index.js';
import type { LibraryLog } from './log';
import { deliverSimklWithClock } from './simklDelivery';
import { rowName, type DocumentRow, type Row, type SettingsRow, type Stamp } from './wire';

beforeAll(() => initialize());

const DEVICE = 'aaaaaaaaaaaaaaaa';
const SAFETY = 'simkl-delivery-safety.v1.42';

const movie = (id: number): Row => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id },
  status: { value: 'watchlist', at: [1000, 0, DEVICE] },
  addedAt: 1000,
});

const trackerRows = (): Row[] => {
  const at: Stamp = [1000, 0, DEVICE];
  return [
    movie(550),
    {
      kind: 'set',
      schema: 2,
      name: 'trackers',
      values: {
        'simkl:42': {
          value: { string: JSON.stringify({ access_token: 'token', connectedAt: at }) },
          at,
        },
      },
    },
    {
      kind: 'set',
      schema: 2,
      name: 'deliver:simkl:42',
      values: {
        since: { value: { string: JSON.stringify([2000, 0, DEVICE]) }, at },
        lease: { value: { strings: ['', '1'] }, at },
      },
    },
  ];
};

function workerLog(rows: Row[], kept: Map<string, unknown>, wireMinimum = 4): LibraryLog {
  const fake = {
    rows: () => rows,
    settings(name: string) {
      return rows.find((row): row is SettingsRow => row.kind === 'set' && row.name === name);
    },
    newestStamp: () => [1000, 0, DEVICE] as Stamp,
    currentGeneration: 'g1',
    observedGeneration: 'g1',
    wireMinimum,
    documents: () =>
      rows.flatMap((row, seq) =>
        'format' in row && row.format === 4 ? [{ seq, document: row as DocumentRow }] : [],
      ),
    unreadable: new Map(),
    newerFraming: new Set(),
    seqOf: () => 0,
    async write(row: Row) {
      const index = rows.findIndex((old) => rowName(old) === rowName(row));
      if (index < 0) rows.push(row);
      else rows[index] = row;
      return row;
    },
    async writeAt(row: Row) {
      return !!(await fake.write(row));
    },
    async keep(name: string, value: unknown) {
      kept.set(name, structuredClone(value));
    },
    async kept<T>(name: string) {
      const value = kept.get(name);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
  };
  return fake as unknown as LibraryLog;
}

function workerClock() {
  let counter = 0;
  return {
    device: DEVICE,
    issue: async (now = 2_000) => [now, counter++, DEVICE] as Stamp,
    historical: async (times: readonly number[]) =>
      times.map((time) => [time, counter++, DEVICE] as Stamp),
    see: async () => undefined,
    current: async () => [2_000, counter, DEVICE] as Stamp,
  };
}

function simklFetch(sends: { count: number }): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
    if (url.includes('/sync/all-items'))
      return new Response(JSON.stringify({ movies: [], shows: [] }));
    if (url.includes('/sync/add-to-list') && init?.method === 'POST') {
      sends.count++;
      return new Response('{}');
    }
    return new Response('{}', { status: 404 });
  };
}

it('shares settle reservations across two worker authorities without localStorage', async () => {
  const rows = trackerRows();
  const kept = new Map<string, unknown>();
  const sends = { count: 0 };
  const fetchImpl = simklFetch(sends);
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('worker has no localStorage');
    },
    setItem: () => {
      throw new Error('worker has no localStorage');
    },
  });
  try {
    expect(
      await deliverSimklWithClock(workerLog(rows, kept), workerClock(), fetchImpl, 600_000),
    ).toBe(true);
    rows.push(movie(551));
    expect(
      await deliverSimklWithClock(workerLog(rows, kept), workerClock(), fetchImpl, 600_000),
    ).toBe(true);

    expect(sends.count).toBe(2);
    const state = kept.get(SAFETY) as {
      orders: Record<string, number>;
      removalsSent: number[];
    };
    expect(state).toEqual({ orders: { 2: 2, 3: 2 }, removalsSent: [] });
    expect(rows.filter((row) => row.kind === 'delivery')).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps its settle epochs across an authority restart and a rolled-back library', async () => {
  const rows = trackerRows();
  const kept = new Map<string, unknown>();
  const sends = { count: 0 };
  const fetchImpl = simklFetch(sends);
  expect(
    await deliverSimklWithClock(workerLog(rows, kept), workerClock(), fetchImpl, 600_000),
  ).toBe(true);
  expect((kept.get(SAFETY) as { orders: Record<string, number> }).orders).toEqual({ 2: 2 });

  for (let index = rows.length - 1; index >= 0; index--)
    if (rows[index]?.kind === 'delivery') rows.splice(index, 1);
  const delivery = rows.find(
    (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
  )!;
  delivery.values.lease = {
    value: { strings: ['', '1'] },
    at: [3000, 0, 'bbbbbbbbbbbbbbbb'],
  };

  expect(
    await deliverSimklWithClock(workerLog(rows, kept), workerClock(), fetchImpl, 600_000),
  ).toBe(true);
  expect((kept.get(SAFETY) as { orders: Record<string, number> }).orders).toEqual({
    2: 2,
    3: 2,
  });
  expect(sends.count).toBe(2);
});

it('keeps a removal reservation before making the external removal request', async () => {
  const at = (time: number): Stamp => [time, 0, DEVICE];
  const rows: Row[] = [
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 550 },
      status: { value: 'watchlist', at: at(1000) },
      addedAt: 1000,
      deleted: { value: true, at: at(3000) },
    },
    {
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    },
    {
      kind: 'set',
      schema: 2,
      name: 'trackers',
      values: {
        'simkl:42': { value: { string: JSON.stringify({ access_token: 'token' }) }, at: at(1000) },
      },
    },
    {
      kind: 'set',
      schema: 2,
      name: 'deliver:simkl:42',
      values: {
        since: { value: { string: JSON.stringify(at(500)) }, at: at(500) },
        lease: { value: { strings: ['', '1'] }, at: at(500) },
        removals: {
          value: { string: JSON.stringify({ approved: at(4000), held: at(4000) }) },
          at: at(4000),
        },
      },
    },
  ];
  const kept = new Map<string, unknown>();
  let removalRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
    if (url.includes('/sync/all-items'))
      return new Response(
        JSON.stringify({
          movies: [
            {
              movie: { ids: { tmdb: 550 } },
              status: 'plantowatch',
              added_to_watchlist_at: '1970-01-01T00:00:01Z',
            },
          ],
        }),
      );
    if (url.includes('api.simkl.com') && init?.method === 'POST') {
      removalRequests++;
      expect((kept.get(SAFETY) as { removalsSent: number[] }).removalsSent).toHaveLength(1);
      return new Response('{}', { status: 503 });
    }
    return new Response('{}', { status: 404 });
  };

  expect(
    await deliverSimklWithClock(workerLog(rows, kept, 4), workerClock(), fetchImpl, 600_000),
  ).toBe(true);
  expect(removalRequests).toBe(1);
  expect((kept.get(SAFETY) as { removalsSent: number[] }).removalsSent).toHaveLength(1);
});
