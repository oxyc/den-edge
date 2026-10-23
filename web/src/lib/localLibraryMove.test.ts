import { expect, it } from 'vitest';
import { keptSomething, unaccounted } from './localLibraryMove';
import type { DocumentRow, Row, SettingsRow, Stamp } from './wire';

const at = (ms: number): Stamp => [ms, 0, 'aaaaaaaaaaaaaaaa'];

const title = (id: number, fields: Record<string, unknown> = {}): DocumentRow => ({
  kind: 'title',
  format: 4,
  title: { type: 'movie', id },
  status: { value: 'watchlist', at: at(1000) },
  addedAt: 1000,
  ...fields,
});

const prefs = (values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name: 'prefs',
  values,
});

it('counts as kept anything but what the page writes by itself', () => {
  const devices: SettingsRow = { kind: 'set', schema: 2, name: 'devices', values: {} };
  expect(keptSomething([])).toBe(false);
  expect(keptSomething([devices])).toBe(false);
  expect(keptSomething([devices, title(1)])).toBe(true);
  expect(keptSomething([prefs({})])).toBe(true);
});

it('accounts for every document and setting den-edge holds as written', () => {
  const rows: Row[] = [
    title(1),
    title(2, {
      status: { value: 'watched', at: at(2000) },
      reaction: { value: 'love', at: at(2000) },
    }),
    prefs({ 'den.watchRegion': { value: { string: 'FI' }, at: at(500) } }),
  ];
  expect(unaccounted(rows, rows)).toEqual([]);
});

it('names what den-edge lacks or holds an older version of', () => {
  const rows: Row[] = [
    title(1),
    title(2, { reaction: { value: 'like', at: at(2000) } }),
    prefs({ 'den.watchRegion': { value: { string: 'FI' }, at: at(500) } }),
  ];
  const held: Row[] = [title(2, { reaction: { value: null, at: at(1500) } }), prefs({})];
  expect(unaccounted(rows, held).sort()).toEqual(
    ['title:movie:1', 'title:movie:2', 'set:prefs'].sort(),
  );
});

it('takes a newer write on den-edge as standing for an older one kept here', () => {
  const rows: Row[] = [
    title(1),
    prefs({ 'den.watchRegion': { value: { string: 'FI' }, at: at(500) } }),
  ];
  const held: Row[] = [
    title(1, { status: { value: 'watched', at: at(9000) } }),
    prefs({ 'den.watchRegion': { value: { string: 'SE' }, at: at(900) } }),
  ];
  expect(unaccounted(rows, held)).toEqual([]);
});
