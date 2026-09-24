// The TVs this browser is paired with (den-spec pairing v1), in localStorage.

import { forgetLibrary } from './localVault';

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
    if (list) this.list = reconcile(this.list, overlay(list, this.unsavedLinks, sameLink));
    const shared = readList(SHARED_KEY, isShared);
    if (shared)
      this.shared = reconcile(this.shared, overlay(shared, this.unsavedShared, sameShared));
    if (readBrowsing()) this.browsing = true;
    this.settle();
  }

  /** A tab whose open link is gone opens the first one left. */
  private settle(): void {
    if (!this.list.some((link) => link.inboxKey === this.opened))
      this.opened = this.list[0]?.inboxKey;
  }

  private saveLinks(): void {
    this.unsavedLinks = writeLinks(this.list) ? [] : unsavedOf(this.list, readLinks());
  }

  private saveShared(): void {
    this.unsavedShared = writeShared(this.shared) ? [] : unsavedOf(this.shared, readShared());
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
    if (gone && !this.list.some((l) => l.libraryKey === gone.libraryKey))
      void forgetLibrary(gone.libraryKey).catch((error: unknown) =>
        console.warn('den: the kept library could not be dropped', error),
      );
  }

  /** The TV reset its library key and dropped this browser: its keys reach nothing, so it pairs again. */
  forgetMoved(link: Link): void {
    this.remove(link.inboxKey);
    this.moved = link.name ?? 'Your Apple TV';
  }
}

export const links = new Links();
