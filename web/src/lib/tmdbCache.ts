// TMDB's answers kept in this browser (IndexedDB), as the TV keeps them on disk: a title's own details for 30 days,
// lists and search for 6 hours — so a reload paints from here and asks TMDB only for what is missing or old. The API
// key is never part of what is kept. An answer up to a week past that is served at once and refreshed behind it, so
// a return visit never waits on TMDB for what it showed last time; an older one TMDB can't refresh is served stale
// rather than not at all, and nothing is kept past TMDB's six-month limit on cached content.

const TMDB = 'https://api.themoviedb.org/3/';

/**
 * The key a device uses when it has none of its own: den-edge lends the household's.
 *
 * It is a sentinel, not a key. Every TMDB URL in the app is built as `api_key=<key>`, so a browser with no
 * library — a visitor on the public name — would otherwise build a call it cannot make and show an empty page.
 * A request carrying this goes to `/tmdb/…` on this origin instead, where den-edge throws it away, substitutes
 * the real key and answers from a cache shared with every other device that asked the same question.
 */
export const TMDB_PROXY_KEY = 'den-proxy';

/** The same question asked of this origin instead of TMDB's, with the sentinel dropped on the way. */
function proxied(url: URL): string {
  if (url.searchParams.get('api_key') !== TMDB_PROXY_KEY) return url.toString();
  const asked = new URL(url);
  asked.searchParams.delete('api_key');
  const origin = globalThis.location?.origin ?? '';
  return `${origin}/tmdb${asked.pathname}${asked.search}`;
}
const DAY = 86_400_000;
/** TMDB's terms cap how long its content may be cached. */
export const RETENTION = 180 * DAY;
/** How long past fresh an answer is still shown at once while it is refreshed. */
export const STALE_FOR = 7 * DAY;

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

/**
 * How long an answer stays fresh — the TV's `tmdbCacheTTL`: a title's own details barely change; lists do.
 *
 * A title's details are kept for as long as TMDB's terms allow, which is also how long den-edge keeps them
 * (`tmdb.rs`): what a film is called, when it came out and who was in it does not change, and asking again
 * every month bought nothing but a wait. Lists and search still move, and keep their hours.
 */
export function freshFor(path: string): number {
  if (
    /\/(credits|external_ids|keywords|videos|combined_credits)$/.test(path) ||
    path.includes('/season/')
  )
    return RETENTION;
  if (/^\/3\/(movie|tv|person)\/\d+$/.test(path)) return RETENTION;
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
  const refreshing = new Set<string>();
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!store || !href.startsWith(TMDB) || (init?.method ?? 'GET') !== 'GET')
      return network(input, init);
    if (!pruned) {
      pruned = true;
      void store.prune(now() - RETENTION).catch(() => undefined);
    }
    const url = new URL(href);
    const key = keyOf(url);
    // What is kept is keyed by the question, so a browser that later gets its own key reads the answers it
    // already has rather than asking again.
    const asked = proxied(url);
    const kept = await store.get(key).catch(() => undefined);
    const fresh = freshFor(url.pathname);
    const age = kept ? now() - kept.fetchedAt : Infinity;
    if (kept && age < fresh) return answer(kept.body);
    if (kept && age < fresh + STALE_FOR) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Not the caller's signal: leaving the page that asked must not cancel what the next visit will read.
        void network(asked, { ...init, signal: undefined })
          .then(async (res) => {
            if (res.ok) await store.put(key, { body: await res.text(), fetchedAt: now() });
          })
          .catch(() => undefined)
          .finally(() => refreshing.delete(key));
      }
      return answer(kept.body);
    }
    try {
      const res = await network(asked, init);
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
      req.onupgradeneeded = () =>
        req.result.createObjectStore('answers').createIndex('fetchedAt', 'fetchedAt');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(
    mode: IDBTransactionMode,
    work: (answers: IDBObjectStore) => IDBRequest<T> | void,
  ) =>
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
