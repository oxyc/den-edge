// The TVs this browser is paired with (den-spec pairing v1), in localStorage.

import { forgetLibrary } from './localVault';
import { forgetHeroLeadPointers } from './heroLeadPointer';

export interface Link {
  /** The link's credential at den-edge, derived from `linkKey`. */
  inboxKey: string;
  /** The name the TV gave itself in the pairing. */
  name?: string;
  linkedAt?: number;
  /** The library's key, base64, handed over in the pairing. */
  libraryKey: string;
  /** The link's own key, base64: its inbox messages are sealed under a key it derives. */
  linkKey: string;
  /** Stable stamp device id of the host, when its handover included one. */
  deviceId?: string;
  /** The local identity last delivered through this link. Missing makes an upgraded client resend it. */
  sentIdentityName?: string;
  sentIdentityDeviceId?: string;
  /**
   * A library key opened with a recovery code (den-spec recovery-code §8): held with no TV link. Its inbox and link
   * keys are random and reach no TV, so nothing is sent through them.
   */
  recovered?: boolean;
}

/**
 * A device this browser handed its library to. It keeps the library's key from then on, so this is a record of
 * what was given, not a grant that can be taken back: only a new library key cuts a device off.
 */
export interface Shared {
  /** Stable stamp device id of the device that received the library. */
  deviceId?: string;
  name: string;
  at: number;
  /** The library handed over, for reconciling this local record with that library's device list. */
  libraryKey?: string;
  /** Kept until the joiner's sealed device message supplies `deviceId`; absent on legacy records. */
  inboxKey?: string;
  linkKey?: string;
}

const STORAGE_KEY = 'den.links';
const SHARED_KEY = 'den.shared';
const BROWSING_KEY = 'den.browsing';

function isShared(value: unknown): value is Shared {
  const v = value as Partial<Shared> | null;
  return (
    typeof v?.name === 'string' &&
    typeof v.at === 'number' &&
    (v.deviceId === undefined || /^[0-9a-f]{16}$/.test(v.deviceId)) &&
    (v.libraryKey === undefined || typeof v.libraryKey === 'string') &&
    (v.inboxKey === undefined || /^[0-9a-f]{16,}$/i.test(v.inboxKey)) &&
    (v.linkKey === undefined || typeof v.linkKey === 'string')
  );
}

/** A paired link. One made with a six-character code carries no keys, can't reach the library, and pairs again. */
function isLink(value: unknown): value is Link {
  const v = value as Partial<Link> | null;
  return (
    typeof v?.inboxKey === 'string' &&
    /^[0-9a-f]{16,}$/i.test(v.inboxKey) &&
    typeof v.libraryKey === 'string' &&
    typeof v.linkKey === 'string' &&
    (v.deviceId === undefined || /^[0-9a-f]{16}$/.test(v.deviceId)) &&
    (v.sentIdentityName === undefined || typeof v.sentIdentityName === 'string') &&
    (v.sentIdentityDeviceId === undefined || /^[0-9a-f]{16}$/.test(v.sentIdentityDeviceId))
  );
}

/** Storage can throw outright (a private window, blocked site data), so every access is guarded. */
export function readLinks(storage: Storage | undefined = globalThis.localStorage): Link[] {
  return readList(STORAGE_KEY, isLink, storage) ?? [];
}

/** The list kept under `key`; undefined where nothing can be read, and this tab's own copy is all there is. */
function readList<T>(
  key: string,
  valid: (value: unknown) => value is T,
  storage: Storage | undefined = globalThis.localStorage,
): T[] | undefined {
  try {
    if (!storage) return undefined;
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return undefined;
  }
}

/** `fresh`, with each of `current`'s records it holds unchanged kept as the same object, so what holds one finds it. */
function reconcile<T>(current: T[], fresh: T[]): T[] {
  const unchanged = new Map(current.map((item) => [JSON.stringify(item), item]));
  return fresh.map((item) => unchanged.get(JSON.stringify(item)) ?? item);
}

/**
 * `fresh`, with this tab's records storage refused to keep (`unsaved`) over it: each in place of its own record, or
 * added where storage has none.
 */
function overlay<T>(fresh: T[], unsaved: T[], same: (a: T, b: T) => boolean): T[] {
  return [
    ...fresh.map((item) => unsaved.find((kept) => same(kept, item)) ?? item),
    ...unsaved.filter((kept) => !fresh.some((item) => same(kept, item))),
  ];
}

/** `list` without the records `dropped` has its own copy of. */
function without<T>(list: T[], dropped: T[], same: (a: T, b: T) => boolean): T[] {
  return list.filter((item) => !dropped.some((gone) => same(gone, item)));
}

/** The records of `list` that storage does not hold as they are: what a write storage refused left in this tab only. */
function unsavedOf<T>(list: T[], stored: T[]): T[] {
  const kept = new Set(stored.map((item) => JSON.stringify(item)));
  return list.filter((item) => !kept.has(JSON.stringify(item)));
}

/** The same record of a device given the library, whichever copy of it: neither field is ever changed. */
function sameShared(a: Shared, b: Shared): boolean {
  return a === b || (a.at === b.at && a.libraryKey === b.libraryKey);
}

function sameLink(a: Link, b: Link): boolean {
  return a.inboxKey === b.inboxKey;
}

/** False when storage refused it (full, or blocked): the list is then this tab's, for this visit (`unsavedLinks`). */
function writeLinks(list: Link[], storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function readShared(storage: Storage | undefined = globalThis.localStorage): Shared[] {
  return readList(SHARED_KEY, isShared, storage) ?? [];
}

/** As `writeLinks`, for the shared devices (`unsavedShared`). */
function writeShared(
  list: Shared[],
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  try {
    storage?.setItem(SHARED_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Whether this browser has chosen to look around without pairing. */
export function readBrowsing(storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(BROWSING_KEY) === '1';
  } catch {
    return false;
  }
}

function writeBrowsing(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(BROWSING_KEY, '1');
  } catch {
    // Nothing persists in this browser, so the invitation returns next visit. The visit itself is unaffected.
  }
}

const PENDING_RESET_KEY = 'den.keyReset';

/**
 * A key reset under way, or cut short (`keyReset.ts`): the library key it moves from, and the one it moves to. Kept
 * before the new library gets its first row, so a reset that deleted the old library and then lost the tab doesn't
 * lose the library for every device; `settlePendingReset` finishes or undoes it.
 */
export interface PendingReset {
  from: string;
  to: string;
  /** The device that started it: settling may stamp its `set:devices` entry (`LibraryLog.fence`). */
  device: string;
  /**
   * The old library is gone but den-edge didn't say which reset retired it (a `410` naming no successor, from a
   * den-edge before successor tags). Never adopted on its own: `to` is kept, as it may be the only key to the
   * library, until a standing check proves the reset was this one or the person chooses to use it.
   */
  held?: boolean;
}

export function readPendingReset(
  storage: Storage | undefined = globalThis.localStorage,
): PendingReset | null {
  try {
    const value = JSON.parse(storage?.getItem(PENDING_RESET_KEY) ?? 'null') as unknown;
    if (value && typeof value === 'object') {
      const { from, to, device, held } = value as Record<string, unknown>;
      if (typeof from === 'string' && typeof to === 'string' && typeof device === 'string')
        return { from, to, device, ...(held === true ? { held: true } : {}) };
    }
  } catch {
    /* Nothing readable is kept: no reset is pending. */
  }
  return null;
}

/** Keep `pending`, or clear it with null. False when it couldn't be kept, and a reset must then not start. */
export function writePendingReset(
  pending: PendingReset | null,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  try {
    if (pending) storage!.setItem(PENDING_RESET_KEY, JSON.stringify(pending));
    else storage?.removeItem(PENDING_RESET_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The links and shared devices, as every tab of this browser keeps them. Each change starts from what storage holds
 * now, and a change made in another tab is taken up as it lands (`storage`). Each tab used to write its own copy from
 * when it loaded, so a TV paired in one tab was dropped by the next change another tab made, and gone on reload.
 */
export class Links {
  list = $state<Link[]>(readLinks());
  /** The devices this browser gave its library to. */
  shared = $state<Shared[]>(readShared());
  /**
   * Set once the visitor dismisses the invitation to pair, and remembered: the invitation belongs to a first
   * visit, not to every load. Pairing stays reachable from Settings afterwards, so dismissing costs nothing.
   */
  browsing = $state<boolean>(readBrowsing());
  /** The TV a link was forgotten for because it reset its library key, until this browser links again. */
  moved = $state<string | null>(null);
  /** This tab reset the library key (`rekey`), so Settings can say what that means once the library reopens. */
  keyReset = $state(false);
  /**
   * The link this tab has open (`current`), by its inbox key. Another tab making a different link current changes
   * what the next load opens, not this tab: the app is keyed on the current link, so pairing a TV in one tab
   * restarted every other tab, a film playing in it included. Only removing this link moves this tab off it.
   */
  private opened = $state<string | undefined>(this.list[0]?.inboxKey);
  /**
   * Records this tab changed that storage refused to keep (full, or blocked). Each change rereads storage first, so
   * without them a TV paired while storage was full was dropped by the next change, in the same visit.
   */
  private unsavedLinks: Link[] = [];
  private unsavedShared: Shared[] = [];
  /** And the records this tab removed that storage still holds, which a reread would otherwise bring back. */
  private goneLinks: Link[] = [];
  private goneShared: Shared[] = [];

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', (event) => {
      if (event.key === null || [STORAGE_KEY, SHARED_KEY, BROWSING_KEY].includes(event.key))
        this.reread();
    });
  }

  /** Take up what storage holds now, which another tab may have changed, with what this tab couldn't keep there. */
  private reread(): void {
    const list = readList(STORAGE_KEY, isLink);
    if (list)
      this.list = reconcile(
        this.list,
        overlay(without(list, this.goneLinks, sameLink), this.unsavedLinks, sameLink),
      );
    const shared = readList(SHARED_KEY, isShared);
    if (shared)
      this.shared = reconcile(
        this.shared,
        overlay(without(shared, this.goneShared, sameShared), this.unsavedShared, sameShared),
      );
    if (readBrowsing()) this.browsing = true;
    this.settle();
  }

  /** A tab whose open link is gone opens the first one left. */
  private settle(): void {
    if (!this.list.some((link) => link.inboxKey === this.opened))
      this.opened = this.list[0]?.inboxKey;
  }

  private saveLinks(): void {
    const stored = writeLinks(this.list) ? this.list : readLinks();
    this.unsavedLinks = unsavedOf(this.list, stored);
    this.goneLinks = without(stored, this.list, sameLink);
  }

  private saveShared(): void {
    const stored = writeShared(this.shared) ? this.shared : readShared();
    this.unsavedShared = unsavedOf(this.shared, stored);
    this.goneShared = without(stored, this.shared, sameShared);
  }

  get current(): Link | undefined {
    return this.list.find((link) => link.inboxKey === this.opened) ?? this.list[0];
  }

  add(
    inboxKey: string,
    details: { name?: string; libraryKey: string; linkKey: string; deviceId?: string },
    now = Date.now(),
  ): void {
    this.reread();
    if (this.list.some((l) => l.inboxKey === inboxKey)) return;
    const name =
      details.name ?? (this.list.length ? `Apple TV ${this.list.length + 1}` : 'Apple TV');
    this.list = [
      ...this.list,
      {
        inboxKey,
        name,
        linkedAt: now,
        libraryKey: details.libraryKey,
        linkKey: details.linkKey,
        deviceId: details.deviceId,
      },
    ];
    this.moved = null;
    this.settle();
    this.saveLinks();
  }

  /**
   * Keep a library key opened with a recovery code, as a link with no TV behind it, and open it from now on. A library
   * already held is opened, not added twice.
   */
  addRecovered(libraryKey: string): void {
    this.reread();
    const held = this.list.find((link) => link.libraryKey === libraryKey);
    if (held) return this.makeCurrent(held.inboxKey);
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const inboxKey = Array.from(random(24), (b) => b.toString(16).padStart(2, '0')).join('');
    this.list = [
      ...this.list,
      {
        inboxKey,
        name: 'a recovery code',
        linkedAt: Date.now(),
        libraryKey,
        linkKey: btoa(String.fromCharCode(...random(32))),
        recovered: true,
      },
    ];
    this.moved = null;
    this.saveLinks();
    this.makeCurrent(inboxKey);
  }

  /** Open `inboxKey`'s library from now on: the link first, so it's the one the app starts with. */
  makeCurrent(inboxKey: string): void {
    this.reread();
    const chosen = this.list.find((l) => l.inboxKey === inboxKey);
    if (!chosen) return;
    this.opened = inboxKey;
    if (this.list[0] === chosen) return;
    this.list = [chosen, ...this.list.filter((l) => l !== chosen)];
    this.saveLinks();
  }

  /** Look around without pairing. */
  browse(): void {
    this.browsing = true;
    writeBrowsing();
  }

  /** Remember a device this browser paired and handed the library to. */
  share(
    name: string,
    libraryKey: string,
    pairing?: { inboxKey: string; linkKey: string },
    now = Date.now(),
  ): Shared {
    const entry: Shared = { name, at: now, libraryKey, ...pairing };
    this.reread();
    this.shared = [...this.shared, entry];
    this.saveShared();
    return entry;
  }

  identifyShared(entry: Shared, name: string, deviceId?: string): void {
    if (deviceId !== undefined && !/^[0-9a-f]{16}$/.test(deviceId)) return;
    this.reread();
    const kept = this.shared.find((s) => sameShared(s, entry));
    if (!kept) return;
    for (const record of kept === entry ? [kept] : [kept, entry]) {
      record.name = name;
      if (deviceId) record.deviceId = deviceId;
    }
    this.shared = [...this.shared];
    this.saveShared();
  }

  identityDelivered(entry: Link, name: string, deviceId: string): void {
    if (!/^[0-9a-f]{16}$/.test(deviceId)) return;
    this.reread();
    const kept = this.list.find((l) => l.inboxKey === entry.inboxKey);
    if (!kept) return;
    for (const record of kept === entry ? [kept] : [kept, entry]) {
      record.sentIdentityName = name;
      record.sentIdentityDeviceId = deviceId;
    }
    this.list = [...this.list];
    this.saveLinks();
  }

  /** Drop that record. The device keeps the library it was given; this only stops listing it. */
  forgetShared(entry: Shared): void {
    this.reread();
    this.shared = this.shared.filter((s) => !sameShared(s, entry));
    this.unsavedShared = this.unsavedShared.filter((s) => !sameShared(s, entry));
    this.saveShared();
  }

  remove(inboxKey: string): void {
    this.reread();
    const gone = this.list.find((l) => l.inboxKey === inboxKey);
    this.list = this.list.filter((l) => l.inboxKey !== inboxKey);
    this.unsavedLinks = this.unsavedLinks.filter((l) => l.inboxKey !== inboxKey);
    this.settle();
    this.saveLinks();
    // What this browser kept of the library goes with the last link that reaches it.
    if (gone && !this.list.some((l) => l.libraryKey === gone.libraryKey)) {
      forgetHeroLeadPointers(gone.libraryKey);
      void forgetLibrary(gone.libraryKey).catch((error: unknown) =>
        console.warn('den: the kept library could not be dropped', error),
      );
    }
  }

  /**
   * The TV reset its library key and dropped this browser: its keys reach nothing, so it pairs again. Not a link this
   * browser is moving, or has moved, to a new key itself (`rekey`, `PendingReset`): the old library's `410` is then
   * its own reset.
   */
  forgetMoved(link: Link): void {
    this.reread();
    const kept = this.list.find((l) => l.inboxKey === link.inboxKey);
    if (kept && kept.libraryKey !== link.libraryKey) return;
    if (readPendingReset()?.from === link.libraryKey) return;
    this.remove(link.inboxKey);
    this.moved = link.name ?? 'Your Apple TV';
  }

  /**
   * A key reset finished: every link to the library opens it under `to` from now on, and the reset is no longer
   * pending. What this browser kept of it under `from` goes, and so do its records of the devices it gave `from` to:
   * the reset cut them off. The app reopens the library under the new key.
   */
  rekey(from: string, to: string): void {
    this.reread();
    this.list = this.list.map((l) => (l.libraryKey === from ? { ...l, libraryKey: to } : l));
    this.shared = this.shared.filter((s) => s.libraryKey !== from);
    this.keyReset = true;
    this.saveLinks();
    this.saveShared();
    writePendingReset(null);
    forgetHeroLeadPointers(from);
    void forgetLibrary(from).catch((error: unknown) =>
      console.warn('den: the kept library could not be dropped', error),
    );
  }
}

export const links = new Links();
