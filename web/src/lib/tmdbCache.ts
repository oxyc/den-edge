// TMDB's answers kept in this browser (IndexedDB), as the TV keeps them on disk: a title's own settled details for
// six months, and an airing series, anything that moves with a title, lists and search for 6 hours (`freshFor`) — so
// a reload paints from here and asks TMDB only for what is missing or old. The API key is never part of what is
// kept. An answer up to a week past that is served at once and refreshed behind it, so a return visit never waits on
// TMDB for what it showed last time; an older one TMDB can't refresh is served stale rather than not at all, and
// nothing is kept past TMDB's six-month limit on cached content.

import { transactions } from './localVault';
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
/**
 * How long a request no single caller owns may take: one shared by several callers (`sharingFlights`), or a refresh
 * behind a kept answer. Without it, one that never answered was joined by every later caller of the same question,
 * which stayed unanswered — a title without its name or poster — until a reload.
 */
const SHARED_MS = 20_000;
/**
 * The most answers kept. Age alone (`RETENTION`) let the store grow with every title and page ever browsed for six
 * months; past this the oldest go first. An answer is some kilobytes to tens of kilobytes (estimated, not
 * measured), so this bounds the store to some tens of megabytes.
 */
export const MOST_KEPT = 2_000;
/**
 * How many answers one prune drops at most before it lets other reads and writes of the store go ahead: a prune is
 * one read-write transaction, and every read of the store waits behind it. The first prune after the cap came in
 * had a backlog of up to six months of answers to drop.
 */
export const PRUNE_BATCH = 100;
/** How long a prune waits between batches, and after the first TMDB question of the page before it starts. */
export const PRUNE_PAUSE_MS = 1_000;
/** A tab kept open prunes again after this many answers kept, not only once per page load. */
export const PRUNE_EVERY = 200;
/** How long past fresh an answer is still shown at once while it is refreshed. */
export const STALE_FOR = 7 * DAY;

export interface Entry {
  body: string;
  fetchedAt: number;
  /** Checked as it was kept (`keepable`), so it is not parsed again on every read. */
  checked?: true;
}

export interface Store {
  get(key: string): Promise<Entry | undefined>;
  put(key: string, entry: Entry): Promise<void>;
  /**
   * Drop what was fetched before `cutoff`, and the oldest beyond the `most` newest: at most `batch` of them, oldest
   * first. True when it dropped that many, and more may be left.
   */
  prune(cutoff: number, most: number, batch: number): Promise<boolean>;
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
 * every month bought nothing but a wait. Lists and search still move, and keep their hours — and so does a title
 * whose `appends` (`append_to_response`) carry one of them: where it streams (`watch/providers`), what is like it
 * (`recommendations`) and its trailers (`videos`) move like any list, as den-edge keeps them (`tmdb.rs` `MOVING`).
 * The detail page asks for them, and was kept for six months.
 */
export function freshFor(path: string, body?: string, appends?: string | null): number {
  if (/\/(credits|external_ids|keywords|combined_credits)$/.test(path) || path.includes('/season/'))
    return RETENTION;
  if (/^\/3\/(movie|tv|person)\/\d+$/.test(path))
    return unfinished(path, body) || moving(appends) ? DAY / 4 : RETENTION;
  return DAY / 4;
}

/** What a title's record can carry along (`append_to_response`) that settles as the record itself does. */
const SETTLED = new Set([
  'credits',
  'aggregate_credits',
  'combined_credits',
  'external_ids',
  'keywords',
  'images',
  'release_dates',
  'content_ratings',
]);

/** Does `appends` ask for anything that moves, as a list does? */
function moving(appends: string | null | undefined): boolean {
  return (appends ?? '').split(',').some((append) => append.trim() && !SETTLED.has(append.trim()));
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
  /** Answers kept since the last prune started; undefined until the first one has. */
  let keptSince: number | undefined;
  let pruning = false;
  /** Prune in batches (`PRUNE_BATCH`), each after a pause, so reads of the store are not held behind all of it. */
  const prune = () => {
    if (!store || pruning) return;
    pruning = true;
    keptSince = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, PRUNE_PAUSE_MS));
    void (async () => {
      do await pause();
      while (await store.prune(now() - RETENTION, MOST_KEPT, PRUNE_BATCH));
    })()
      .catch(() => undefined)
      .finally(() => (pruning = false));
  };
  const keep = async (key: string, entry: Entry) => {
    await store?.put(key, entry);
    if (keptSince !== undefined && ++keptSince >= PRUNE_EVERY) prune();
  };
  const refreshing = new Set<string>();
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!store || !href.startsWith(TMDB) || (init?.method ?? 'GET') !== 'GET')
      return network(input, init);
    if (keptSince === undefined) prune();
    const url = new URL(href);
    const key = keyOf(url);
    // What is kept is keyed by the question, so a browser that later gets its own key reads the answers it
    // already has rather than asking again.
    const asked = proxied(url);
    const lent = url.searchParams.get('api_key') === TMDB_PROXY_KEY;
    const entry = (res: Response, body: string): Entry | undefined => {
      const fetchedAt = fetchedAtOf(res, lent, now());
      return keepable(body) && now() - fetchedAt < RETENTION
        ? { body, fetchedAt, checked: true }
        : undefined;
    };
    const stored = await store.get(key).catch(() => undefined);
    // Anything unusable is treated as absent, which also heals what an earlier version kept. So is anything
    // past TMDB's six months, whatever happens next: not shown stale, and not shown when the network is down.
    const kept =
      stored && (stored.checked || keepable(stored.body)) && now() - stored.fetchedAt < RETENTION
        ? stored
        : undefined;
    // What was kept decides how long it stays fresh, not the question alone: a series still airing is a list.
    const fresh = freshFor(url.pathname, kept?.body, url.searchParams.get('append_to_response'));
    const age = kept ? now() - kept.fetchedAt : Infinity;
    if (kept && age < fresh) return answer(kept.body);
    if (kept && age < fresh + STALE_FOR) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Not the caller's signal: leaving the page that asked must not cancel what the next visit will read.
        void network(asked, { ...init, signal: AbortSignal.timeout(SHARED_MS) })
          .then(async (res) => {
            if (!res.ok) return;
            const refreshed = entry(res, await res.text());
            if (refreshed) await keep(key, refreshed);
          })
          .catch(() => undefined)
          .finally(() => refreshing.delete(key));
      }
      return answer(kept.body);
    }
    try {
      const res = await network(asked, init);
      if (!res.ok) {
        // A refusal to answer now, like den-edge or TMDB failing, is no reason to drop the answer already kept.
        if (kept && (res.status >= 500 || res.status === 429)) return answer(kept.body);
        if (res.status === 429) announceThrottle(res);
        return res;
      }
      const body = await res.text();
      const fetched = entry(res, body);
      // What it says about its titles den-edge kept as it fetched it (`src/title_metadata.rs`).
      if (fetched) void keep(key, fetched).catch(() => undefined);
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
  const run = transactions(
    factory,
    'den-tmdb',
    1,
    (database) => database.createObjectStore('answers').createIndex('fetchedAt', 'fetchedAt'),
    'answers',
  );
  return {
    get: (key) => run('readonly', (answers) => answers.get(key) as IDBRequest<Entry | undefined>),
    put: async (key, entry) => {
      await run('readwrite', (answers) => answers.put(entry, key));
    },
    prune: async (cutoff, most, batch) => {
      let dropped = 0;
      await run('readwrite', (answers) => {
        dropped = 0;
        const count = answers.count();
        count.onsuccess = () => {
          let over = count.result - most;
          // Oldest first: past the cutoff, or beyond the newest `most`.
          const cursor = answers.index('fetchedAt').openCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at || dropped >= batch || (over <= 0 && (at.key as number) >= cutoff)) return;
            at.delete();
            dropped++;
            over--;
            at.continue();
          };
        };
      });
      return dropped >= batch;
    },
    clear: async () => {
      await run('readwrite', (answers) => answers.clear());
    },
  };
}

/** The caller's own wait, ended by the caller's own signal; the shared request behind it carries on. */
function awaitedBy<T>(shared: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/**
 * `fetch`, where a TMDB question already on its way is joined rather than asked again.
 *
 * A service page asks the same title's details from several places at once — a chart's missing poster, the hero's
 * backdrop, the same title on two charts — and before this each one went to the network while the store was still
 * empty. The shared request carries no caller's signal, so one caller giving up does not fail the others; each
 * caller still stops waiting when its own signal says so. It carries its own limit (`SHARED_MS`) instead.
 */
export function sharingFlights(inner: typeof fetch): typeof fetch {
  const flying = new Map<string, Promise<Response>>();
  return (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(TMDB) || (init?.method ?? 'GET') !== 'GET') return inner(input, init);
    const key = keyOf(new URL(href));
    let flight = flying.get(key);
    if (!flight) {
      flight = inner(href, { ...init, signal: AbortSignal.timeout(SHARED_MS) });
      flying.set(key, flight);
      const done = () => flying.delete(key);
      flight.then(done, done);
    }
    // Every caller reads its own copy of the body; the original is never read, so each clone can be.
    return awaitedBy(flight, init?.signal).then((res) => res.clone());
  };
}

const store = indexedStore();

/** `fetch`, with TMDB's answers kept in this browser. */
export const tmdbFetch = sharingFlights(cachingFetch(store));

/** Forget every kept answer: the TMDB key was removed. */
export async function clearTmdbCache(): Promise<void> {
  await store?.clear().catch(() => undefined);
}
