import { expect, it } from 'vitest';
import { keptSomething, unaccounted } from './localLibraryMove';
import type { EpisodeRow, Row, SettingsRow, Stamp, TitleRow, WatchRow } from './wire';

const ZERO: Stamp = [0, 0, ''];
const at = (ms: number): Stamp => [ms, 0, 'aaaaaaaaaaaaaaaa'];

const title = (id: number, fields: Partial<TitleRow> = {}): TitleRow => ({
  kind: 'rec',
  schema: 2,
  title: { type: 'movie', id },
  status: { value: 'watchlist', at: at(1000) },
  resume: { value: 0, at: ZERO, viewing: 0 },
  reaction: { value: null, at: ZERO },
  deleted: { value: false, at: ZERO },
  dismissed: { value: false, at: ZERO },
  episodesReset: null,
  addedAt: 1000,
  watchedAt: null,
  ...fields,
});

const episode = (number: number, value: number, when: number): EpisodeRow => ({
  kind: 'ep',
  schema: 2,
  title: { type: 'tv', id: 7 },
  season: 1,
  episode: number,
  progress: { value, at: at(when), viewing: 1 },
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

it('accounts for every title, episode and setting den-edge holds as written', () => {
  const rows: Row[] = [
    title(1),
    title(2, {
      status: { value: 'watched', at: at(2000) },
      reaction: { value: 'love', at: at(2000) },
    }),
    episode(1, 1, 3000),
    episode(2, 0.5, 3100),
    prefs({ 'den.watchRegion': { value: { string: 'FI' }, at: at(500) } }),
  ];
  expect(unaccounted(rows, rows)).toEqual([]);
});

it('names what den-edge lacks or holds an older version of', () => {
  const rows: Row[] = [
    title(1),
    title(2, { reaction: { value: 'like', at: at(2000) } }),
    episode(2, 0.5, 3100),
    prefs({ 'den.watchRegion': { value: { string: 'FI' }, at: at(500) } }),
  ];
  const held: Row[] = [
    title(2, { reaction: { value: null, at: at(1500) } }),
    episode(2, 0.2, 3000),
    prefs({}),
  ];
  expect(unaccounted(rows, held).sort()).toEqual(
    ['episode:tv:7:1:2', 'rec:movie:1', 'rec:movie:2', 'set:prefs'].sort(),
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

it('reads an episode kept as a v2 row against the season den-edge holds', () => {
  const watched: WatchRow = {
    kind: 'wat',
    schema: 3,
    title: { type: 'tv', id: 7 },
    season: 1,
    block: 0,
    seasonReset: null,
    entries: {
      '2': {
        imported: false,
        progress: { value: 0.5, at: at(3100), viewing: 1 },
        plays: {},
        cleared: null,
      },
    },
  };
  expect(unaccounted([episode(2, 0.5, 3100)], [watched])).toEqual([]);
  expect(unaccounted([episode(3, 0.5, 3100)], [watched])).toEqual(['episode:tv:7:1:3']);
});
