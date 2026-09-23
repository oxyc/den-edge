// TMDB's answers kept in this browser (IndexedDB), as the TV keeps them on disk: a title's own details for 30 days,
// lists and search for 6 hours — so a reload paints from here and asks TMDB only for what is missing or old. The API
// key is never part of what is kept. An answer up to a week past that is served at once and refreshed behind it, so
// a return visit never waits on TMDB for what it showed last time; an older one TMDB can't refresh is served stale
// rather than not at all, and nothing is kept past TMDB's six-month limit on cached content.

import { relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';

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

/**
 * The same question asked of this origin instead of TMDB's, with the key dropped on the way.
 *
 * Every browser goes through den-edge, not only one that borrows the key. den-edge throws away whatever key it is
 * sent, answers from a cache keyed by the question alone, and keeps it for as long as TMDB's terms allow — so a
 * household's second device, and a visitor, are answered from what the first device already asked, and a title is
 * fetched from TMDB once rather than once per browser. A configured key is still the key den-edge uses upstream; it
 * simply stops being spent separately by each device that holds it.
 */
function proxied(url: URL): string {
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

export interface TmdbThrottle {
  retryMs: number;
}

const throttleListeners = new Set<(throttle: TmdbThrottle) => void>();
let throttleUntil = 0;

/**
 * Hear only refusals that leave a page without a usable cached answer.
 *
 * The deadline is retained as well as broadcast. A page can ask for TMDB while Svelte is still mounting the
 * root listener, and several concurrent questions can be refused with different waits. A late listener gets
 * the wait still in force, while a shorter later refusal cannot clear a longer one early.
 */
export function onTmdbThrottle(listener: (throttle: TmdbThrottle) => void): () => void {
  throttleListeners.add(listener);
  const retryMs = throttleUntil - Date.now();
  if (retryMs > 0) listener({ retryMs });
  return () => throttleListeners.delete(listener);
}

function announceThrottle(res: Response): void {
  const now = Date.now();
  const proposedUntil = now + retryAfterMs(res, 60_000, () => now);
  if (proposedUntil <= throttleUntil) return;
  throttleUntil = proposedUntil;
  const throttle = { retryMs: throttleUntil - now };
  for (const listener of throttleListeners) listener(throttle);
}

/**
 * How long an answer stays fresh — the TV's `tmdbCacheTTL`: a title's own details barely change; lists do.
 *
 * A title's details are kept for as long as TMDB's terms allow, which is also how long den-edge keeps them
 * (`tmdb.rs`): what a film is called, when it came out and who was in it does not change, and asking again
 * every month bought nothing but a wait. Lists and search still move, and keep their hours.
 */
export function freshFor(path: string, body?: string): number {
  if (
    /\/(credits|external_ids|keywords|videos|combined_credits)$/.test(path) ||
    path.includes('/season/')
  )
    return RETENTION;
  if (/^\/3\/(movie|tv|person)\/\d+$/.test(path))
    return unfinished(path, body) ? DAY / 4 : RETENTION;
  return DAY / 4;
}

/** Only these are over. Returning, in production and planned are not, whatever is scheduled right now. */
const OVER = /"status":\s*"(Ended|Canceled)"/;

/**
 * Does this answer describe a series that can still change?
 *
 * A series that is not over is the one record TMDB answers that does not settle, and `continueWatching` reads a
 * series' shape to decide which episode is next — so kept for six months, Den goes on believing the season ended
 * months ago and withholds the episode that aired on Friday. The status decides it and not the next episode: a
 * series between seasons has none scheduled and is not finished, and the day its next season is announced is the
 * day this has to notice. den-edge reads the same field for the same reason (`tmdb.rs`), so both sides forget it
 * at the same age.
 */
function unfinished(path: string, body: string | undefined): boolean {
  if (!body || !/^\/3\/tv\/\d+$/.test(path)) return false;
  return !OVER.test(body);
}

/** The URL without its key, parameters in order: what an answer is kept under. */
function keyOf(url: URL): string {
  const kept = new URL(url);
  kept.searchParams.delete('api_key');
  kept.searchParams.sort();
  return kept.toString();
}

/**
 * Is this body one of TMDB's answers, rather than something standing where one should be?
 *
 * An error envelope (`success: false`), a proxy's own refusal, a page of HTML from a dev server: all of them
 * arrive as a 200 and none of them names a title. A title's details are kept for months, so without this one
 * such answer stands for months — the page saying it cannot load a film that TMDB serves perfectly well, and
 * no amount of reloading asking again.
 */
function keepable(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as { success?: unknown }).success !== false;
  } catch {
    return false;
  }
}

/**
 * When an answer was fetched from TMDB. For one lent through den-edge that is its `Last-Modified` — the day
 * den-edge kept it, which may be months before it reached this browser, and TMDB's six months count from then.
 * TMDB's own `Last-Modified` says nothing about that, so a direct answer counts from now.
 */
function fetchedAtOf(res: Response, lent: boolean, now: number): number {
  const said = lent ? Date.parse(res.headers.get('last-modified') ?? '') : NaN;
  return Number.isNaN(said) ? now : Math.min(said, now);
}

function answer(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** `fetch`, keeping TMDB's GET answers in `store`; everything else goes straight to the network. */
export function cachingFetch(
  store: Store | null,
  network: typeof fetch = relayFetch,
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
    const lent = url.searchParams.get('api_key') === TMDB_PROXY_KEY;
    const entry = (res: Response, body: string): Entry | undefined => {
      const fetchedAt = fetchedAtOf(res, lent, now());
      return keepable(body) && now() - fetchedAt < RETENTION ? { body, fetchedAt } : undefined;
    };
    const stored = await store.get(key).catch(() => undefined);
    // Anything unusable is treated as absent, which also heals what an earlier version kept. So is anything
    // past TMDB's six months, whatever happens next: not shown stale, and not shown when the network is down.
    const kept =
      stored && keepable(stored.body) && now() - stored.fetchedAt < RETENTION ? stored : undefined;
    // What was kept decides how long it stays fresh, not the question alone: a series still airing is a list.
    const fresh = freshFor(url.pathname, kept?.body);
    const age = kept ? now() - kept.fetchedAt : Infinity;
    if (kept && age < fresh) return answer(kept.body);
    if (kept && age < fresh + STALE_FOR) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Not the caller's signal: leaving the page that asked must not cancel what the next visit will read.
        void network(asked, { ...init, signal: undefined })
          .then(async (res) => {
            if (!res.ok) return;
            const refreshed = entry(res, await res.text());
            if (refreshed) await store.put(key, refreshed);
          })
          .catch(() => undefined)
          .finally(() => refreshing.delete(key));
      }
      return answer(kept.body);
    }
    try {
      const res = await network(asked, init);
      if (!res.ok) {
        if (res.status === 429) announceThrottle(res);
        return kept && res.status >= 500 ? answer(kept.body) : res;
      }
      const body = await res.text();
      const fetched = entry(res, body);
      // What it says about its titles den-edge kept as it fetched it (`src/title_metadata.rs`).
      if (fetched) void store.put(key, fetched).catch(() => undefined);
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
