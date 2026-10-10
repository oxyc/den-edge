import { describe, expect, it } from 'vitest';
import type { Link, Shared } from '../lib/links.svelte';
import type { DeviceEntry } from './values';
import {
  deviceStatus,
  hasOtherDevices,
  libraryName,
  linkedDeviceRows,
  syncedDeviceRows,
} from './linkedDevices';

const device = (id: string, name: string, kind: 'tv' | 'browser', seen = 10): DeviceEntry => ({
  id,
  name,
  kind,
  seen,
  pending: [],
  facade: [],
  delivers: [],
  waiting: {},
  connectedAt: {},
  handoff: {},
});
const link = (inboxKey: string, name: string, libraryKey = 'current', deviceId?: string): Link => ({
  inboxKey,
  name,
  linkedAt: 5,
  libraryKey,
  linkKey: `key-${inboxKey}`,
  deviceId,
});
const shared = (name: string, libraryKey?: string, at = 5, deviceId?: string): Shared => ({
  name,
  at,
  libraryKey,
  deviceId,
});

describe('linked device presentation', () => {
  it('merges current-library records by stable id and keeps every action source', () => {
    const tv = device('tv-1', 'Living Room', 'tv');
    const phone = device('phone-1', 'Alice’s iPhone', 'browser');
    const tvLink = link('inbox-1', 'Renamed TV', 'current', 'tv-1');
    const handoff = shared('Old phone name', 'current', 5, 'phone-1');

    expect(linkedDeviceRows([tv, phone], [tvLink], [handoff], 'current')).toEqual([
      {
        id: 'device:tv-1',
        name: 'Living Room',
        kind: 'tv',
        device: tv,
        links: [tvLink],
        shared: [],
      },
      {
        id: 'device:phone-1',
        name: 'Alice’s iPhone',
        kind: 'browser',
        device: phone,
        links: [],
        shared: [handoff],
      },
    ]);
  });

  it('keeps legacy records separate even when their editable name is unique', () => {
    const first = device('tv-1', 'Apple TV', 'tv');
    const second = device('tv-2', 'Apple TV', 'tv');
    const ambiguous = link('inbox-1', 'Apple TV');
    const elsewhere = link('inbox-2', 'Bedroom', 'other');
    const rows = linkedDeviceRows([first, second], [ambiguous, elsewhere], [], 'current');

    expect(rows.map((row) => row.id)).toEqual([
      'device:tv-1',
      'device:tv-2',
      'link:inbox-1',
      'link:inbox-2',
    ]);
    expect(rows.slice(0, 2).every((row) => row.links.length === 0)).toBe(true);
  });

  it('does not present a browser-local library link as another synced device', () => {
    const tv = device('tv-1', 'Apple TV', 'tv');
    const legacyLink = link('inbox-1', 'Apple TV');

    expect(syncedDeviceRows([tv], [legacyLink], [], 'current')).toEqual([
      {
        id: 'device:tv-1',
        name: 'Apple TV',
        kind: 'tv',
        device: tv,
        links: [],
        shared: [],
      },
    ]);
  });

  it('never attaches a stable id to another library or a pending new pairing by name', () => {
    const phone = device('phone-1', 'Phone', 'browser');
    const elsewhere = shared('Phone', 'other', 5, 'phone-1');
    const pending = { ...shared('Phone', 'current'), inboxKey: 'abcdef0123456789', linkKey: 'key' };
    expect(
      linkedDeviceRows([phone], [], [elsewhere, pending], 'current').map((row) => row.id),
    ).toEqual(['device:phone-1', 'shared:other:phone-1', 'shared:abcdef0123456789']);
  });

  it('keeps same-named link and handoff observations distinct rather than inventing one identity', () => {
    const tv = device('tv-1', 'Den', 'tv');
    const tvLink = link('inbox-1', 'Den');
    const handoff = shared('Den', 'current');
    const rows = linkedDeviceRows([tv], [tvLink], [handoff], 'current');

    expect(rows.map((row) => row.id)).toEqual([
      'device:tv-1',
      'link:inbox-1',
      'shared:current:5:den:0',
    ]);
  });

  it('never promotes a legacy label to identity after a same-named device checks in', () => {
    const checkedIn = device('phone-1', 'Phone', 'browser', 20);
    const handoff = shared('Phone', undefined, 10);
    expect(linkedDeviceRows([checkedIn], [], [handoff], 'current').map((row) => row.id)).toEqual([
      'device:phone-1',
      'shared:legacy:10:phone:0',
    ]);
  });

  it('keeps the same device handed different libraries as separately actionable rows', () => {
    const first = shared('Phone', 'first', 5, 'phone-1');
    const second = shared('Phone', 'second', 6, 'phone-1');
    expect(linkedDeviceRows([], [], [first, second], 'current').map((row) => row.id)).toEqual([
      'shared:first:phone-1',
      'shared:second:phone-1',
    ]);
  });
});

describe('device status line', () => {
  const day = (at: number) => `day ${at}`;
  const statusOf = (
    devices: DeviceEntry[],
    records: Shared[] = [],
    selfId = 'self',
    current = 'current',
  ) =>
    syncedDeviceRows(devices, [], records, current).map((row) =>
      deviceStatus(row, selfId, current, day),
    );

  it('says what a listed device is and when it was seen, this browser by name', () => {
    expect(
      statusOf([
        device('self', 'Mac', 'browser', 9),
        device('tv-1', 'Living Room', 'tv', 7),
        device('phone-1', 'Phone', 'browser', 0),
      ]),
    ).toEqual(['This browser · seen day 9', 'Apple TV · seen day 7', 'Browser']);
  });

  it('says nothing of the record of giving it the library once the device lists itself', () => {
    expect(
      statusOf(
        [device('phone-1', 'Phone', 'browser', 9)],
        [shared('Phone', 'current', 5, 'phone-1')],
      ),
    ).toEqual(['Browser · seen day 9']);
  });

  it('dates a device given the library that has not listed itself, naming another library as such', () => {
    expect(
      statusOf(
        [],
        [shared('Phone', 'current', 5), shared('Laptop', 'other', 6), shared('Old', undefined, 7)],
      ),
    ).toEqual(['added day 5', 'added to another library day 6', 'added day 7']);
  });
});

describe('other devices in the open library', () => {
  const others = (devices: DeviceEntry[], records: Shared[] = []) =>
    hasOtherDevices(syncedDeviceRows(devices, [], records, 'current'), 'self', 'current');

  it('is false for a library only this browser has listed itself in', () => {
    expect(others([])).toBe(false);
    expect(others([device('self', 'Mac', 'browser')])).toBe(false);
  });

  it('is true once another device is listed or has been handed the library', () => {
    expect(others([device('self', 'Mac', 'browser'), device('tv-1', 'TV', 'tv')])).toBe(true);
    expect(others([], [shared('Phone', 'current')])).toBe(true);
  });

  it('ignores devices handed some other library', () => {
    expect(others([device('self', 'Mac', 'browser')], [shared('Laptop', 'other', 5, 'l-1')])).toBe(
      false,
    );
  });
});

describe('saved library name', () => {
  it('calls the open library "Your library" and any other "Another library", never the TV it came through', () => {
    expect(libraryName(link('inbox-1', 'Apple TV', 'current'), 'current')).toBe('Your library');
    expect(libraryName(link('inbox-2', 'Apple TV', 'other'), 'current')).toBe('Another library');
  });
});
