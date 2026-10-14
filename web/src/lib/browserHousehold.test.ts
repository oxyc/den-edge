import { beforeAll, expect, it, vi } from 'vitest';
import {
  commitHousehold,
  householdPlan,
  keptHousehold,
  observeKeptActions,
  planHousehold,
  settledHousehold,
  startHouseholdPlan,
} from './browserHousehold';
import { householdScoped, profileScoped } from './householdScope';
import { ensureSyncPolicy } from './syncLoader';
import type { Row, SettingsRow, Stamp } from './wire';

beforeAll(async () => {
  await ensureSyncPolicy();
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const LOCAL = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const at: Stamp = [1000, 0, '0123456789abcdef'];

it('plans every id and key of the household before anything is asked of den-edge', () => {
  const storage = memoryStorage();
  const plan = planHousehold(LOCAL, storage, () => 42)!;
  expect(plan).toMatchObject({ version: 1, stagingKey: LOCAL, createdAt: 42, started: false });
  expect(new Set([plan.householdKey, plan.ownerKey, LOCAL]).size).toBe(3);
  expect(householdPlan(storage)).toEqual(plan);
  // Started from the library kept now: a reload resumes the same ids.
  const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  const started = startHouseholdPlan(plan, other, storage)!;
  expect(started).toEqual({ ...plan, stagingKey: other, started: true });
  expect(householdPlan(storage)).toEqual(started);
});

it('opens the household only once the library it started from has moved in', () => {
  const storage = memoryStorage();
  const plan = planHousehold(LOCAL, storage)!;
  expect(settledHousehold(LOCAL, storage)).toBeNull();
  expect(commitHousehold(plan, storage)).toBe(true);
  expect(keptHousehold(storage)).toBe(plan.householdKey);
  // Pointed at, but the library kept here still holds what moves: it is opened to finish.
  expect(settledHousehold(LOCAL, storage)).toBeNull();
  // The library is gone: the plan is done, and its removal is all that was left.
  expect(settledHousehold(null, storage)).toBe(plan.householdKey);
  expect(householdPlan(storage)).toBeNull();
});

it('starts the household on a kept action, never on what the page writes by itself', async () => {
  const kept = vi.fn();
  const service = {
    command: vi.fn(async () => ({ version: { generation: 'g', sequence: 1 } })),
  } as unknown as Parameters<typeof observeKeptActions>[0];
  const observed = observeKeptActions(service, kept);
  await observed.command({ kind: 'device.heartbeat', name: 'Browser' });
  await observed.command({ kind: 'retained.home-continue.set', present: true });
  expect(kept).not.toHaveBeenCalled();
  await observed.command({ kind: 'watchlist.add', title: { type: 'movie', id: 1 } });
  expect(kept).toHaveBeenCalledOnce();
});

it('splits a browser’s own rows between the household and its Owner', () => {
  const watch: Row = {
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id: 1 },
    status: { value: 'watchlist', at },
    resume: { value: 0, at, viewing: 0 },
    reaction: { value: null, at },
    deleted: { value: false, at },
    dismissed: { value: false, at },
    episodesReset: null,
    addedAt: 1000,
    watchedAt: null,
  };
  const prefs: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'prefs',
    values: {
      'den.hideAnime': { value: { bool: true }, at },
      'den.region': { value: { string: 'FI' }, at },
    },
  };
  const keys: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'keys',
    values: {
      simkl: { value: { string: 'token' }, at },
      parentalPIN: { value: { string: 'hash' }, at },
    },
  };
  expect(profileScoped(watch)).toBe(watch);
  // Every preference is the profile's: the household takes none of the row.
  expect(profileScoped(prefs)).toEqual(prefs);
  expect(householdScoped(prefs)).toBeNull();
  expect(profileScoped(keys)).toEqual({ ...keys, values: { simkl: keys.values.simkl } });
  expect(householdScoped(keys)).toEqual({
    ...keys,
    values: { parentalPIN: keys.values.parentalPIN },
  });
  expect(profileScoped({ kind: 'set', schema: 2, name: 'plugins', values: {} })).toBeNull();
});
