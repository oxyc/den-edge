// The TVs this browser is paired with (den-spec pairing v1), in localStorage.

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
}

/**
 * A device this browser handed its library to. It keeps the library's key from then on, so this is a record of
 * what was given, not a grant that can be taken back: only a new library key cuts a device off.
 */
export interface Shared {
  name: string;
  at: number;
}

const STORAGE_KEY = 'den.links';
const SHARED_KEY = 'den.shared';

function isShared(value: unknown): value is Shared {
  const v = value as Partial<Shared> | null;
  return typeof v?.name === 'string' && typeof v.at === 'number';
}

/** A paired link. One made with a six-character code carries no keys, can't reach the library, and pairs again. */
function isLink(value: unknown): value is Link {
  const v = value as Partial<Link> | null;
  return (
    typeof v?.inboxKey === 'string' &&
    /^[0-9a-f]{16,}$/i.test(v.inboxKey) &&
    typeof v.libraryKey === 'string' &&
    typeof v.linkKey === 'string'
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

class Links {
  list = $state<Link[]>(readLinks());
  /** The devices this browser gave its library to. */
  shared = $state<Shared[]>(readShared());
  /** The TV a link was forgotten for because it reset its library key, until this browser links again. */
  moved = $state<string | null>(null);

  get current(): Link | undefined {
    return this.list[0];
  }

  add(inboxKey: string, details: { name?: string; libraryKey: string; linkKey: string }, now = Date.now()): void {
    if (this.list.some((l) => l.inboxKey === inboxKey)) return;
    const name = details.name ?? (this.list.length ? `Apple TV ${this.list.length + 1}` : 'Apple TV');
    this.list = [...this.list, { inboxKey, name, linkedAt: now, libraryKey: details.libraryKey, linkKey: details.linkKey }];
    this.moved = null;
    writeLinks(this.list);
  }

  /** Remember a device this browser paired and handed the library to. */
  share(name: string, now = Date.now()): void {
    this.shared = [...this.shared, { name, at: now }];
    writeShared(this.shared);
  }

  /** Drop that record. The device keeps the library it was given; this only stops listing it. */
  forgetShared(entry: Shared): void {
    this.shared = this.shared.filter((s) => s !== entry);
    writeShared(this.shared);
  }

  remove(inboxKey: string): void {
    this.list = this.list.filter((l) => l.inboxKey !== inboxKey);
    writeLinks(this.list);
  }

  /** The TV reset its library key and dropped this browser: its keys reach nothing, so it pairs again. */
  forgetMoved(link: Link): void {
    this.remove(link.inboxKey);
    this.moved = link.name ?? 'Your Apple TV';
  }
}

export const links = new Links();
