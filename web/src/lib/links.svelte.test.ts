import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Links, readLinks, readShared } from './links.svelte';

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
