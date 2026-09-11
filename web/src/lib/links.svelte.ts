// The TVs this browser is linked to. localStorage for now; the library store (IndexedDB) replaces it when
// the record log's client lands.

export interface Link {
  inboxKey: string;
  linkedAt: number;
}

const STORAGE_KEY = 'den.web.links';

function isLink(value: unknown): value is Link {
  const v = value as Partial<Link> | null;
  return typeof v?.inboxKey === 'string' && typeof v.linkedAt === 'number';
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

class Links {
  list = $state<Link[]>(readLinks());

  get current(): Link | undefined {
    return this.list[0];
  }

  add(inboxKey: string, now = Date.now()): void {
    if (this.list.some((l) => l.inboxKey === inboxKey)) return;
    this.list = [...this.list, { inboxKey, linkedAt: now }];
    writeLinks(this.list);
  }

  remove(inboxKey: string): void {
    this.list = this.list.filter((l) => l.inboxKey !== inboxKey);
    writeLinks(this.list);
  }
}

export const links = new Links();
