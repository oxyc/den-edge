import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  linkedTv,
  Links,
  readLinks,
  readPendingReset,
  readShared,
  writePendingReset,
} from './links.svelte';

const KEYS = { libraryKey: 'bGli', linkKey: 'bGluaw==' };

let kept: Map<string, string>;
let win: EventTarget;

beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  });
  win = new EventTarget();
  vi.stubGlobal('window', win);
});

afterEach(() => vi.unstubAllGlobals());

it('offers Play on TV only for a real paired receiver', () => {
  const paired = { inboxKey: 'a'.repeat(16), ...KEYS, name: 'Living room' };
  expect(linkedTv(paired, [])).toBe(paired);
  expect(linkedTv({ ...paired, recovered: true }, [])).toBeUndefined();
  expect(linkedTv({ ...paired, recovered: true, guest: true }, [])).toBeUndefined();
  expect(linkedTv({ ...paired, guest: true }, [])).toBeUndefined();
  expect(linkedTv(null, [])).toBeUndefined();
});

/** A browser that joined another browser sent "Play on TV" to that browser's inbox, which no TV drains. */
it('is not a TV when the link was made by joining a browser', () => {
  const host = '0123456789abcdef';
  const viaBrowser = { inboxKey: 'a'.repeat(16), ...KEYS, name: 'Mac - Oskar', deviceId: host };
  expect(linkedTv(viaBrowser, [{ id: host, kind: 'browser' }])).toBeUndefined();
  expect(linkedTv(viaBrowser, [{ id: 'fedcba9876543210', kind: 'tv' }])).toBeUndefined();
  expect(linkedTv(viaBrowser, undefined), 'device list not read yet').toBeUndefined();
  const viaTv = { ...viaBrowser, name: 'Apple TV' };
  expect(linkedTv(viaTv, [{ id: host, kind: 'tv' }])).toBe(viaTv);
});

/** Another tab's change: written to the storage both share, and announced to this one as a browser does. */
function elsewhere(change: (other: Links) => void) {
  const other = new Links();
  change(other);
  for (const key of ['den.links', 'den.shared'])
    win.dispatchEvent(Object.assign(new Event('storage'), { key }));
}

it('keeps a TV paired in another tab when this tab changes its links', () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  const stale = new Links(); // Opened before the next pairing, and told nothing of it.
  const other = new Links();
  other.add('b'.repeat(16), { ...KEYS, name: 'Bedroom' });
  stale.makeCurrent('b'.repeat(16));
  stale.remove('c'.repeat(16));
  expect(readLinks().map((link) => link.name)).toEqual(['Bedroom', 'Living room']);
});

it('takes up a change another tab made, and keeps its own records the same objects', () => {
  const tab = new Links();
  const first = tab.share('Phone', 'bGli', undefined, 1);
  elsewhere((other) => other.share('Tablet', 'bGli', undefined, 2));
  expect(tab.shared.map((entry) => entry.name)).toEqual(['Phone', 'Tablet']);
  expect(tab.shared[0]).toBe(first);
});

it('names and forgets a shared device another tab has reread, found by the record rather than the object', () => {
  const tab = new Links();
  const phone = tab.share('Phone', 'bGli', undefined, 1);
  elsewhere((other) => other.identifyShared(other.shared[0]!, 'Sam’s phone', '0123456789abcdef'));
  // `phone` is the copy this tab had: it still reaches the record.
  tab.identifyShared(phone, 'Sam’s iPhone');
  expect(readShared().map((entry) => [entry.name, entry.deviceId])).toEqual([
    ['Sam’s iPhone', '0123456789abcdef'],
  ]);
  tab.forgetShared(phone);
  expect(readShared()).toEqual([]);
});

/** Each change rereads storage first: a TV paired while storage was full was dropped by the next change. */
it('keeps a link storage refused to keep, through the next change', () => {
  const full = (key: string, value: string) => {
    if (key === 'den.links') throw new DOMException('full', 'QuotaExceededError');
    kept.set(key, value);
  };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: full,
    removeItem: (key: string) => void kept.delete(key),
  });
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  tab.add('b'.repeat(16), { ...KEYS, name: 'Bedroom' });
  expect(tab.list.map((link) => link.name)).toEqual(['Living room', 'Bedroom']);
  expect(tab.current?.name).toBe('Living room');
  tab.remove('b'.repeat(16));
  elsewhere(() => undefined);
  expect(tab.list.map((link) => link.name)).toEqual(['Living room']);
});

/** The app is keyed on the current link: pairing in one tab restarted every other tab, a film playing included. */
it("keeps this tab's current link when another tab makes a different one current", () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  elsewhere((other) => {
    other.add('b'.repeat(16), { ...KEYS, name: 'Bedroom' });
    other.makeCurrent('b'.repeat(16));
  });
  expect(tab.list.map((link) => link.name)).toEqual(['Bedroom', 'Living room']);
  expect(tab.current?.name, 'still open here').toBe('Living room');
  // A change this tab makes keeps the other tab's choice for the next load.
  tab.identityDelivered(tab.current!, 'Phone', '0123456789abcdef');
  expect(readLinks()[0]?.name).toBe('Bedroom');
  expect(new Links().current?.name).toBe('Bedroom');
  // Gone from under this tab, it opens the one left.
  elsewhere((other) => other.remove('a'.repeat(16)));
  expect(tab.current?.name).toBe('Bedroom');
});

/** A removal storage refused to keep came back with the next reread, as a refused addition once went missing. */
it('keeps a link removed while storage was full removed, through the next change', () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  tab.add('b'.repeat(16), { ...KEYS, name: 'Bedroom' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === 'den.links') throw new DOMException('full', 'QuotaExceededError');
      kept.set(key, value);
    },
    removeItem: (key: string) => void kept.delete(key),
  });
  tab.remove('b'.repeat(16));
  elsewhere(() => undefined);
  expect(tab.list.map((link) => link.name)).toEqual(['Living room']);
  tab.makeCurrent('a'.repeat(16));
  expect(tab.list.map((link) => link.name)).toEqual(['Living room']);
});

it("a key reset moves every link to the library onto the new key, and the old library's 410 drops none", () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  tab.add('b'.repeat(16), { ...KEYS, name: 'Bedroom' });
  tab.add('c'.repeat(16), { libraryKey: 'b3RoZXI=', linkKey: 'x', name: 'Cabin' });
  const before = tab.list[0]!;
  tab.rekey(KEYS.libraryKey, 'bmV3');
  expect(readLinks().map((link) => link.libraryKey)).toEqual(['bmV3', 'bmV3', 'b3RoZXI=']);
  expect(tab.keyReset).toBe(true);
  // The session still open on the old key hears `410 library_moved`: its own reset, not another device's.
  tab.forgetMoved(before);
  expect(tab.list.map((link) => link.name)).toEqual(['Living room', 'Bedroom', 'Cabin']);
  expect(tab.moved).toBeNull();
  // A link another device's reset cut off is still forgotten.
  tab.forgetMoved(tab.list[2]!);
  expect(tab.list.map((link) => link.name)).toEqual(['Living room', 'Bedroom']);
});

it('a compound reset keeps the pending marker through the install and drops it only when released', () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  const marker = { from: KEYS.libraryKey, to: 'bmV3', device: '0123456789abcdef', compound: true };
  expect(writePendingReset(marker)).toBe(true);
  expect(readPendingReset()).toEqual(marker);

  tab.rekey(KEYS.libraryKey, 'bmV3', true);
  expect(readLinks().map((link) => link.libraryKey)).toEqual(['bmV3']);
  // Installed, but the reset is not over: the marker is what finds the worker's journal after a reload.
  expect(readPendingReset()).toEqual(marker);

  tab.releaseRekeyed(KEYS.libraryKey);
  expect(readPendingReset()).toBeNull();
});

it('a legacy marker has no compound flag, and an ordinary rekey still clears it', () => {
  const tab = new Links();
  tab.add('a'.repeat(16), { ...KEYS, name: 'Living room' });
  writePendingReset({ from: KEYS.libraryKey, to: 'bmV3', device: '0123456789abcdef' });
  expect(readPendingReset()).toEqual({
    from: KEYS.libraryKey,
    to: 'bmV3',
    device: '0123456789abcdef',
  });
  tab.rekey(KEYS.libraryKey, 'bmV3');
  expect(readPendingReset()).toBeNull();
});
