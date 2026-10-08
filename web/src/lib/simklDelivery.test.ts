import { beforeAll, expect, it } from 'vitest';
import { initialize } from '../vendor/den-core/index.js';
import type { LibraryLog } from './log';
import { deliverSimklWithClock } from './simklDelivery';
import { rowName, type Row, type SettingsRow, type Stamp } from './wire';

beforeAll(() => initialize());

it('a switched v2 Simkl library sends missing work once and keeps its receipt', async () => {
  const at: Stamp = [1000, 0, 'aaaaaaaaaaaaaaaa'];
  const rows: Row[] = [
    {
      kind: 'rec',
      schema: 2,
      title: { type: 'movie', id: 550 },
      status: { value: 'watchlist', at },
      resume: { value: 0, viewing: 0, at },
      reaction: { value: null, at: [0, 0, ''] },
      deleted: { value: false, at: [0, 0, ''] },
      dismissed: { value: false, at: [0, 0, ''] },
      episodesReset: null,
      addedAt: 1000,
      watchedAt: null,
    },
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
        since: { value: { string: JSON.stringify([2000, 0, 'aaaaaaaaaaaaaaaa']) }, at },
        lease: { value: { strings: ['', '1'] }, at },
      },
    },
  ];
  const fake = {
    rows: () => rows,
    settings(name: string) {
      return rows.find((row): row is SettingsRow => row.kind === 'set' && row.name === name);
    },
    newestStamp: () => at,
    // A generation this page has already watched, so its first pass may take an empty lease at once.
    currentGeneration: 'g1',
    observedGeneration: 'g1',
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
  } as unknown as LibraryLog;
  let sends = 0;
  let counter = 0;
  const clock = {
    device: 'aaaaaaaaaaaaaaaa',
    issue: async (now = 2_000) => [now, counter++, 'aaaaaaaaaaaaaaaa'] as Stamp,
    historical: async (times: readonly number[]) =>
      times.map((time) => [time, counter++, 'aaaaaaaaaaaaaaaa'] as Stamp),
    see: async () => undefined,
    current: async () => [2_000, counter, 'aaaaaaaaaaaaaaaa'] as Stamp,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
    if (url.includes('/sync/all-items'))
      return new Response(JSON.stringify({ movies: [], shows: [] }));
    if (url.includes('/sync/add-to-list') && init?.method === 'POST') {
      sends++;
      return new Response('{}');
    }
    return new Response('{}', { status: 404 });
  };

  expect(await deliverSimklWithClock(fake, clock, fetchImpl, 600_000)).toBe(true);
  expect(sends).toBe(1);
  expect(rows.some((row) => row.kind === 'snt')).toBe(true);
  expect(await deliverSimklWithClock(fake, clock, fetchImpl, 600_000)).toBe(true);
  expect(sends).toBe(1);
});
