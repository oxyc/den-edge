// The TVs this browser is linked to — the same list, under the same key, as the companion page at /app,
// which shares this origin: a browser linked on either is linked on both. localStorage for now; the library
// store (IndexedDB) replaces it when the record log's client lands.

export interface Link {
  inboxKey: string;
  /** A paired TV names itself; the companion page names each TV; a six-character link made here is "Apple TV". */
  name?: string;
  /** Set by links made here; the companion page's own links don't record it. */
  linkedAt?: number;
  /** The library's key, base64, when the TV handed it over in pairing (den-spec pairing v1). A link made with a
   * six-character code finds it in the TV's backup instead. */
  libraryKey?: string;
  /** The link's own key, base64, from pairing: its inbox messages are sealed under a key it derives. */
  linkKey?: string;
}

const STORAGE_KEY = 'den.links';
/** The companion page's older single link, which it migrates into the list on its next open. */
const LEGACY_KEY = 'den.inboxKey';

function isLink(value: unknown): value is Link {
  const v = value as Partial<Link> | null;
  return typeof v?.inboxKey === 'string' && /^[0-9a-f]{16,}$/i.test(v.inboxKey);
}

/** Storage can throw outright (a private window, blocked site data), so every access is guarded. */
export function readLinks(storage: Storage | undefined = globalThis.localStorage): Link[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter(isLink) : [];
    const legacy = storage?.getItem(LEGACY_KEY);
    if (legacy && isLink({ inboxKey: legacy }) && !list.some((l) => l.inboxKey === legacy)) {
      list.push({ inboxKey: legacy, name: 'Apple TV' });
    }
    return list;
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

class Links {
  list = $state<Link[]>(readLinks());

  get current(): Link | undefined {
    return this.list[0];
  }

  add(inboxKey: string, details: { name?: string; libraryKey?: string; linkKey?: string } = {}, now = Date.now()): void {
    if (this.list.some((l) => l.inboxKey === inboxKey)) return;
    const name = details.name ?? (this.list.length ? `Apple TV ${this.list.length + 1}` : 'Apple TV');
    const link: Link = { inboxKey, name, linkedAt: now };
    if (details.libraryKey) link.libraryKey = details.libraryKey;
    if (details.linkKey) link.linkKey = details.linkKey;
    this.list = [...this.list, link];
    writeLinks(this.list);
  }

  remove(inboxKey: string): void {
    this.list = this.list.filter((l) => l.inboxKey !== inboxKey);
    writeLinks(this.list);
  }
}

export const links = new Links();
