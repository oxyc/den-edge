import { describe, expect, it } from 'vitest';
import type { Link, Shared } from '../lib/links.svelte';
import type { DeviceEntry } from './values';
import { linkedDeviceRows } from './linkedDevices';

const device = (id: string, name: string, kind: 'tv' | 'browser', seen = 10): DeviceEntry => ({
  id,
  name,
  kind,
  seen,
  pending: [],
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

  it('keeps the conservative legacy fallback for unique names only', () => {
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

  it('never attaches a stable id to another library or a pending new pairing by name', () => {
    const phone = device('phone-1', 'Phone', 'browser');
    const elsewhere = shared('Phone', 'other', 5, 'phone-1');
    const pending = { ...shared('Phone', 'current'), inboxKey: 'abcdef0123456789', linkKey: 'key' };
    expect(
      linkedDeviceRows([phone], [], [elsewhere, pending], 'current').map((row) => row.id),
    ).toEqual(['device:phone-1', 'shared:phone-1', 'shared:abcdef0123456789']);
  });

  it('keeps same-named link and handoff observations distinct rather than inventing one identity', () => {
    const tv = device('tv-1', 'Den', 'tv');
    const tvLink = link('inbox-1', 'Den');
    const handoff = shared('Den', 'current');
    const rows = linkedDeviceRows([tv], [tvLink], [handoff], 'current');

    expect(rows.map((row) => row.id)).toEqual(['device:tv-1', 'link:inbox-1', 'shared:5:den']);
  });

  it('reconciles a legacy handoff only after that uniquely named device has checked in', () => {
    const checkedIn = device('phone-1', 'Phone', 'browser', 20);
    const handoff = shared('Phone', undefined, 10);
    expect(linkedDeviceRows([checkedIn], [], [handoff], 'current')).toHaveLength(1);

    const stale = device('phone-1', 'Phone', 'browser', 5);
    expect(linkedDeviceRows([stale], [], [handoff], 'current').map((row) => row.id)).toEqual([
      'device:phone-1',
      'shared:10:phone',
    ]);
  });
});
