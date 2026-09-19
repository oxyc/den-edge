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
    (v.deviceId === undefined || /^[0-9a-f]{16}$/.test(v.deviceId))
  );
}

/** Storage can throw outright (a private window, blocked site data), so every access is guarded. */
export function readLinks(storage: Storage | undefined = globalThis.localStorage): Link[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isLink) : [];
  } catch {
    return [];
  }
}

function writeLinks(list: Link[], storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Nothing persists in this browser; the link still works for this visit.
  }
}

export function readShared(storage: Storage | undefined = globalThis.localStorage): Shared[] {
  try {
    const raw = storage?.getItem(SHARED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isShared) : [];
  } catch {
    return [];
  }
}

function writeShared(list: Shared[], storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SHARED_KEY, JSON.stringify(list));
  } catch {
    // Nothing persists in this browser; the list is this visit's.
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

class Links {
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

  get current(): Link | undefined {
    return this.list[0];
  }

  add(
    inboxKey: string,
    details: { name?: string; libraryKey: string; linkKey: string; deviceId?: string },
    now = Date.now(),
  ): void {
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
    writeLinks(this.list);
  }

  /** Open `inboxKey`'s library from now on: the link first, so it's the one the app starts with. */
  makeCurrent(inboxKey: string): void {
    const chosen = this.list.find((l) => l.inboxKey === inboxKey);
    if (!chosen || this.list[0] === chosen) return;
    this.list = [chosen, ...this.list.filter((l) => l !== chosen)];
    writeLinks(this.list);
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
    this.shared = [...this.shared, entry];
    writeShared(this.shared);
    return entry;
  }

  identifyShared(entry: Shared, deviceId: string, name = entry.name): void {
    if (!/^[0-9a-f]{16}$/.test(deviceId) || !this.shared.includes(entry)) return;
    entry.deviceId = deviceId;
    entry.name = name;
    this.shared = [...this.shared];
    writeShared(this.shared);
  }

  identifyLink(entry: Link, deviceId: string): void {
    if (!/^[0-9a-f]{16}$/.test(deviceId) || !this.list.includes(entry)) return;
    entry.deviceId = deviceId;
    this.list = [...this.list];
    writeLinks(this.list);
  }

  /** Drop that record. The device keeps the library it was given; this only stops listing it. */
  forgetShared(entry: Shared): void {
    this.shared = this.shared.filter((s) => s !== entry);
    writeShared(this.shared);
  }

  remove(inboxKey: string): void {
    const gone = this.list.find((l) => l.inboxKey === inboxKey);
    this.list = this.list.filter((l) => l.inboxKey !== inboxKey);
    writeLinks(this.list);
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
