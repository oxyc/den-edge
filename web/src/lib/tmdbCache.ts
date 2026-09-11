// TMDB's answers kept in this browser (IndexedDB), as the TV keeps them on disk: a title's own details for 30 days,
// lists and search for 6 hours — so a reload paints from here and asks TMDB only for what is missing or old. The API
// key is never part of what is kept. An answer TMDB can't refresh is served stale rather than not at all, and
// nothing is kept past TMDB's six-month limit on cached content.

const TMDB = 'https://api.themoviedb.org/3/';
const DAY = 86_400_000;
/** TMDB's terms cap how long its content may be cached. */
export const RETENTION = 180 * DAY;

export interface Entry {
  body: string;
  fetchedAt: number;
}

export interface Store {
  get(key: string): Promise<Entry | undefined>;
  put(key: string, entry: Entry): Promise<void>;
  /** Drop what was fetched before `cutoff`. */
  prune(cutoff: number): Promise<void>;
  clear(): Promise<void>;
}

/** How long an answer stays fresh — the TV's `tmdbCacheTTL`: a title's own details barely change; lists do. */
export function freshFor(path: string): number {
  if (/\/(credits|external_ids|keywords|videos|combined_credits)$/.test(path) || path.includes('/season/')) return 30 * DAY;
  if (/^\/3\/(movie|tv|person)\/\d+$/.test(path)) return 30 * DAY;
  return DAY / 4;
}

/** The URL without its key, parameters in order: what an answer is kept under. */
function keyOf(url: URL): string {
  const kept = new URL(url);
  kept.searchParams.delete('api_key');
  kept.searchParams.sort();
  return kept.toString();
}

function answer(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** `fetch`, keeping TMDB's GET answers in `store`; everything else goes straight to the network. */
export function cachingFetch(
  store: Store | null,
  network: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): typeof fetch {
  let pruned = false;
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!store || !href.startsWith(TMDB) || (init?.method ?? 'GET') !== 'GET') return network(input, init);
    if (!pruned) {
      pruned = true;
      void store.prune(now() - RETENTION).catch(() => undefined);
    }
    const url = new URL(href);
    const key = keyOf(url);
    const kept = await store.get(key).catch(() => undefined);
    if (kept && now() - kept.fetchedAt < freshFor(url.pathname)) return answer(kept.body);
    try {
      const res = await network(input, init);
      if (!res.ok) return kept && res.status >= 500 ? answer(kept.body) : res;
      const body = await res.text();
      void store.put(key, { body, fetchedAt: now() }).catch(() => undefined);
      return answer(body);
    } catch (error) {
      if (kept) return answer(kept.body);
      throw error;
    }
  };
}

/** This browser's IndexedDB, or null where there is none or it is refused (a private window, blocked site data). */
function indexedStore(): Store | null {
  let factory: IDBFactory;
  try {
    factory = globalThis.indexedDB;
    if (!factory) return null;
  } catch {
    return null;
  }
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = factory.open('den-tmdb', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('answers').createIndex('fetchedAt', 'fetchedAt');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, work: (answers: IDBObjectStore) => IDBRequest<T> | void) =>
    open().then(
      (database) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = database.transaction('answers', mode);
          const req = work(tx.objectStore('answers'));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  return {
    get: (key) => run('readonly', (answers) => answers.get(key) as IDBRequest<Entry | undefined>),
    put: async (key, entry) => {
      await run('readwrite', (answers) => answers.put(entry, key));
    },
    prune: async (cutoff) => {
      await run('readwrite', (answers) => {
        const cursor = answers.index('fetchedAt').openCursor(IDBKeyRange.upperBound(cutoff, true));
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          cursor.result.delete();
          cursor.result.continue();
        };
      });
    },
    clear: async () => {
      await run('readwrite', (answers) => answers.clear());
    },
  };
}

const store = indexedStore();

/** `fetch`, with TMDB's answers kept in this browser. */
export const tmdbFetch = cachingFetch(store);

/** Forget every kept answer: the TMDB key was removed. */
export async function clearTmdbCache(): Promise<void> {
  await store?.clear().catch(() => undefined);
}
