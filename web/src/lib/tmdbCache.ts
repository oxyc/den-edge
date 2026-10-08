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
/** A missing TMDB record can appear later, so remember it for hours rather than as settled title metadata. */
const ABSENT_FOR = DAY / 4;
const ABSENT_BODY = '{"error":"not_found"}';
/** TMDB's terms cap how long its content may be cached. */
export const RETENTION = 180 * DAY;
/**
 * How long a request no single caller owns may take: one shared by several callers (`sharingFlights`), or a refresh
 * behind a kept answer. Without it, one that never answered was joined by every later caller of the same question,
 * which stayed unanswered — a title without its name or poster — until a reload.
 */
const SHARED_MS = 20_000;
/**
 * Keep a completed answer across the short handoff from the shared request to IndexedDB. A trace measured identical
 * detail requests 671–849 ms apart; with a delayed store, the completed flight is removed before its write is
 * readable and the visit asks again. This is deliberately brief: IndexedDB remains the durable cache and another
 * tab's newer answer is observed after the handoff.
 */
export const ANSWER_HANDOFF_MS = 30_000;
/** A bounded working set for that handoff; one library page can prewarm several rows at once. */
export const MOST_HANDOFF_ANSWERS = 64;
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
export const PRUNE_BATCH = 20;
/** How long a prune waits between batches, and after the first TMDB question of the page before it starts. */
export const PRUNE_PAUSE_MS = 1_000;
/** An idle callback eventually runs even on a continuously busy page or in a throttled background tab. */
const PRUNE_IDLE_TIMEOUT_MS = 5_000;
/** A tab kept open prunes again after this many answers kept, not only once per page load. */
export const PRUNE_EVERY = 200;
/** How long past fresh an answer is still shown at once while it is refreshed. */
export const STALE_FOR = 7 * DAY;

export interface Entry {
  body: string;
  fetchedAt: number;
  /** Checked as it was kept (`keepable`), so it is not parsed again on every read. */
  checked?: true;
  /** A relay-confirmed missing TMDB record, not a provider/configuration failure. */
  status?: 404;
}

export interface Store {
  get(key: string): Promise<Entry | undefined>;
  put(key: string, entry: Entry): Promise<void>;
  /**
   * Drop what was fetched before `cutoff`, and the oldest beyond the `most` newest: at most `batch` of them, oldest
   * first. Returns how many it dropped; a full batch means more may be left.
   */
  prune(cutoff: number, most: number, batch: number): Promise<number>;
  clear(): Promise<void>;
}

export interface TmdbThrottle {
  retryMs: number;
}

const throttleListeners = new Set<(throttle: TmdbThrottle) => void>();
let throttleUntil = 0;

/**
 * Hear a provider refusal even when a usable cached answer hides it from the current card. Other speculative
 * lookups on the page must still observe TMDB's requested rest instead of continuing to spend its budget.
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

/** TMDB says 429 directly; den-edge deliberately translates that provider refusal to a cacheable-safe 503. */
function throttled(res: Response): boolean {
  return res.status === 429 || (res.status === 503 && res.headers.has('retry-after'));
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
function keepable(body: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as { success?: unknown }).success !== false ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Only den-edge's exact missing-record answer is safe to remember as absent. */
function absentBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      (parsed as { error?: unknown }).error === 'not_found'
    );
  } catch {
    return false;
  }
}

/** Whether this is den-edge saying the TMDB record itself is missing, rather than an outage or disabled proxy. */
export async function tmdbMissing(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  try {
    return absentBody(await res.clone().text());
  } catch {
    return false;
  }
}

/**
 * Answers already parsed on their way through here (`keepable`), so their reader does not parse them again: a
 * title's details are tens of kilobytes, parsed on the main thread while its page waits for them. Every caller of a
 * shared question is handed the same object, so it is read, never changed.
 */
const parsedAnswers = new WeakMap<Response, object>();

/** A successful answer whose inert string body can be copied without teeing a Response stream. */
const reusableAnswers = new WeakMap<Response, { body: string; parsed?: object }>();

interface HandoffAnswer {
  entry: Entry;
  parsed?: object;
  until: number;
  /** The wide title-page question: preserve it when background naming/lookups fill this small cache. */
  interactiveDetail: boolean;
}

/** Each persistent store has its own short-lived answers; injected stores and sessions cannot lend one another. */
const handoffAnswers = new WeakMap<Store, Map<string, HandoffAnswer>>();

function answersFor(store: Store): Map<string, HandoffAnswer> {
  let answers = handoffAnswers.get(store);
  if (!answers) {
    answers = new Map();
    handoffAnswers.set(store, answers);
  }
  return answers;
}

/** A Detail screen's one wide question, as distinct from shelf naming and Scout's external-id lookup. */
function isInteractiveDetail(key: string): boolean {
  const url = new URL(key);
  if (!/^\/3\/(movie|tv)\/\d+$/.test(url.pathname)) return false;
  const appends = new Set((url.searchParams.get('append_to_response') ?? '').split(','));
  return appends.has('recommendations') && appends.has('videos');
}

/** A TMDB answer's JSON: the object it was checked as, where it was, or the body parsed now. */
export function tmdbJson(res: Response): Promise<unknown> {
  const parsed = parsedAnswers.get(res);
  return parsed ? Promise.resolve(parsed) : res.json();
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

function answer(body: string, parsed?: object): Response {
  const res = new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  reusableAnswers.set(res, { body, parsed });
  if (parsed) parsedAnswers.set(res, parsed);
  return res;
}

function absent(): Response {
  return new Response(ABSENT_BODY, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/** `fetch`, keeping TMDB's GET answers in `store`; everything else goes straight to the network. */
export function cachingFetch(
  store: Store | null,
  network: typeof fetch = relayFetch,
  now: () => number = Date.now,
): typeof fetch {
  const handoff = store ? answersFor(store) : null;
  const remember = (key: string, entry: Entry, parsed?: object) => {
    if (!handoff) return;
    handoff.delete(key);
    handoff.set(key, {
      entry,
      parsed,
      until: now() + ANSWER_HANDOFF_MS,
      interactiveDetail: isInteractiveDetail(key),
    });
    while (handoff.size > MOST_HANDOFF_ANSWERS) {
      // A page can admit more than 64 shelf-naming and availability questions during this 30-second handoff.
      // Prefer dropping the oldest background answer so the just-opened Detail does not ask the same wide,
      // rate-limit-expensive question again a few hundred milliseconds later. The map stays strictly bounded;
      // if it contains only interactive details, ordinary LRU eviction still applies.
      const background = [...handoff].find(([, answer]) => !answer.interactiveDetail)?.[0];
      const drop = background ?? handoff.keys().next().value;
      if (drop === undefined) break;
      handoff.delete(drop);
    }
  };
  const recall = (key: string): HandoffAnswer | undefined => {
    const found = handoff?.get(key);
    if (!found) return undefined;
    const at = now();
    if (at >= found.until || at - found.entry.fetchedAt >= RETENTION) {
      handoff!.delete(key);
      return undefined;
    }
    // A hit becomes the newest entry in this small LRU.
    handoff!.delete(key);
    handoff!.set(key, found);
    return found;
  };
  /** Answers kept since the last prune started; undefined until the first one has. */
  let keptSince: number | undefined;
  let pruning = false;
  const pauseForHousekeeping = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (typeof globalThis.requestIdleCallback === 'function')
          globalThis.requestIdleCallback(() => resolve(), { timeout: PRUNE_IDLE_TIMEOUT_MS });
        else resolve();
      }, PRUNE_PAUSE_MS);
    });
  const exclusively = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    let locks: LockManager | undefined;
    try {
      locks = globalThis.navigator?.locks;
    } catch {
      // A restricted browser can expose navigator but refuse one of its capabilities.
    }
    if (!locks) return work();
    return locks.request('den-tmdb-cache-prune', { ifAvailable: true }, (lock) =>
      lock ? work() : undefined,
    );
  };
  /**
   * Prune in short transactions, each after both a pause and an idle opportunity. Reads are never queued behind a
   * six-month backlog, and an origin-wide lock keeps retained tabs from doing the same startup scan concurrently.
   */
  const prune = () => {
    if (!store || pruning) return;
    pruning = true;
    keptSince = 0;
    void (async () => {
      let dropped: number;
      do {
        await pauseForHousekeeping();
        const result = await exclusively(() =>
          store.prune(now() - RETENTION, MOST_KEPT, PRUNE_BATCH),
        );
        // Another tab is doing this origin's same housekeeping. Its IndexedDB transaction is sufficient.
        if (result === undefined) return;
        dropped = result;
      } while (dropped >= PRUNE_BATCH);
    })()
      .catch(() => undefined)
      .finally(() => (pruning = false));
  };
  const keep = async (key: string, entry: Entry, parsed?: object) => {
    // Publish synchronously before the first await: a settled flight is removed in this same microtask turn.
    remember(key, entry, parsed);
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
    const entry = (res: Response, body: string, parsed: object | undefined): Entry | undefined => {
      const fetchedAt = fetchedAtOf(res, lent, now());
      return parsed && now() - fetchedAt < RETENTION
        ? { body, fetchedAt, checked: true }
        : undefined;
    };
    const remembered = recall(key);
    const stored = remembered?.entry ?? (await store.get(key).catch(() => undefined));
    if (stored?.status === 404 && now() - stored.fetchedAt < ABSENT_FOR) return absent();
    // Anything unusable is treated as absent, which also heals what an earlier version kept. So is anything
    // past TMDB's six months, whatever happens next: not shown stale, and not shown when the network is down.
    const kept =
      stored &&
      stored.status !== 404 &&
      (stored.checked || keepable(stored.body)) &&
      now() - stored.fetchedAt < RETENTION
        ? stored
        : undefined;
    // What was kept decides how long it stays fresh, not the question alone: a series still airing is a list.
    const fresh = freshFor(url.pathname, kept?.body, url.searchParams.get('append_to_response'));
    const age = kept ? now() - kept.fetchedAt : Infinity;
    const keptParsed = kept && kept === remembered?.entry ? remembered.parsed : undefined;
    if (kept && age < fresh) return answer(kept.body, keptParsed);
    if (kept && age < fresh + STALE_FOR) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Not the caller's signal: leaving the page that asked must not cancel what the next visit will read.
        void network(asked, { ...init, signal: AbortSignal.timeout(SHARED_MS) })
          .then(async (res) => {
            if (!res.ok) return;
            const body = await res.text();
            const parsed = keepable(body);
            const refreshed = entry(res, body, parsed);
            if (refreshed) await keep(key, refreshed, parsed);
          })
          .catch(() => undefined)
          .finally(() => refreshing.delete(key));
      }
      return answer(kept.body, keptParsed);
    }
    try {
      const res = await network(asked, init);
      if (!res.ok) {
        if (throttled(res)) announceThrottle(res);
        if (await tmdbMissing(res)) {
          // Publish to the bounded handoff before IndexedDB settles, as successful answers do. The same six-hour
          // lifetime as den-edge avoids repeated origin RTTs and failed-resource console entries without hiding a
          // disabled proxy, rate limit, outage, or arbitrary 404.
          void keep(key, { body: ABSENT_BODY, fetchedAt: now(), status: 404 }).catch(
            () => undefined,
          );
        }
        // A refusal to answer now, like den-edge or TMDB failing, is no reason to drop the answer already kept.
        if (kept && (res.status >= 500 || res.status === 429)) return answer(kept.body, keptParsed);
        return res;
      }
      const body = await res.text();
      const parsed = keepable(body);
      const fetched = entry(res, body, parsed);
      // What it says about its titles den-edge kept as it fetched it (`src/title_metadata.rs`).
      if (fetched) void keep(key, fetched, parsed).catch(() => undefined);
      return answer(body, parsed);
    } catch (error) {
      if (kept) return answer(kept.body, keptParsed);
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
          // Only its index key and primary key decide what is deleted. A value cursor structured-cloned every
          // retained JSON body merely to ignore it; this key cursor keeps those bodies out of the main thread.
          const cursor = answers.index('fetchedAt').openKeyCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at || dropped >= batch || (over <= 0 && (at.key as number) >= cutoff)) return;
            // `openKeyCursor` deliberately avoids cloning the answer body, but its cursor is key-only and the
            // IndexedDB spec forbids `IDBCursor.delete()` on it. Delete through the object store with the cursor's
            // primary key instead; this stays key-only while working in Chromium, WebKit and standards-compliant
            // implementations.
            answers.delete(at.primaryKey);
            dropped++;
            over--;
            at.continue();
          };
        };
      });
      return dropped;
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
    let owns = false;
    if (!flight) {
      owns = true;
      flight = inner(href, { ...init, signal: AbortSignal.timeout(SHARED_MS) });
      flying.set(key, flight);
      const done = () => flying.delete(key);
      flight.then(done, done);
    }
    // `Response.clone()` tees and copies the body stream. Answers made by `cachingFetch` already have their inert
    // string and parsed object, so the owner can read the original and joiners can reconstruct an equivalent answer.
    // An arbitrary injected fetch has no such representation and retains ordinary fetch-copy semantics.
    return awaitedBy(flight, init?.signal).then((res) => {
      const reusable = reusableAnswers.get(res);
      if (reusable) return owns ? res : answer(reusable.body, reusable.parsed);
      const copy = res.clone();
      const parsed = parsedAnswers.get(res);
      if (parsed) parsedAnswers.set(copy, parsed);
      return copy;
    });
  };
}

const store = indexedStore();

/** `fetch`, with TMDB's answers kept in this browser. */
export const tmdbFetch = sharingFlights(cachingFetch(store));

/** Forget every kept answer: the TMDB key was removed. */
export async function clearTmdbCache(): Promise<void> {
  if (store) handoffAnswers.get(store)?.clear();
  await store?.clear().catch(() => undefined);
}
