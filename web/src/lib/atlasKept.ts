// Atlas's browse answers kept in this browser (IndexedDB), for when den-edge cannot be reached: the box or its uplink
// down, and Cloudflare holding no copy of its own (with one household's traffic it often holds none). A screen then
// opens on the rows, charts and billboard this browser last saw rather than a wall of failed rows. Only a failure
// reads what is kept: while atlas answers, every answer is the live one and is kept in place of the last.
//
// Only what a screen opens on is kept (a row to `KEPT_DEPTH`), never a search or a filter, which would churn the store a
// keystroke at a time, and only for a profile without a content policy (`ContentAuthority`): a Kid's answers stay
// live-only.

import { keptAnswerServed, providerAnswered, providerUnreachable } from './keptAnswers';
import { indexedKept, type Kept } from './tmdbCache';

const DAY = 86_400_000;
/** How long a kept answer may stand in. Atlas's answers move with its dataset, at most daily. */
export const RETENTION = 30 * DAY;
/**
 * The most answers kept: a row page is ~4.4 KB and a title record ~3 KB (measured), so the store stays near 2.6 MB.
 * Twice the first pages' 300, since a row keeps its next page as well: a wide screen asks for it at once (the row's
 * end is within the two row-widths `BrowseRow` reads ahead), so each row a screen opens on is two answers.
 */
export const MOST_KEPT = 600;
/** One prune per Worker drops at most this many: a session keeps only first pages, so it cannot outgrow it far. */
const PRUNE_BATCH = 100;

/** Only an unrestricted profile's answers are kept, and those carry no `X-Den-Policy` to check. */
export interface KeptAtlasAnswer {
  body: string;
  fetchedAt: number;
}

/** This browser's IndexedDB, or null where there is none or it is refused (a private window, blocked site data). */
function indexedStore(): Kept<KeptAtlasAnswer> | null {
  try {
    const factory = globalThis.indexedDB;
    return factory ? indexedKept<KeptAtlasAnswer>(factory, 'den-atlas-kept', 'answers') : null;
  } catch {
    return null;
  }
}

const defaultStore = indexedStore();

/** The routes a screen opens on: Home's rows and billboard, a service's charts, a title's record, the catalogues. */
const KEPT_ROUTE =
  /\/(?:index\/row\/[\w-]+\.json|index\/title\/(?:movie|series)\/\d+\.json|recommend\/[\w/-]+\.json|catalog\/(?:movie|series)\/[^/]+\/country=[\w-]+\.json|manifest\.json)$/;
/**
 * Where a row stops being kept: its first five pages (120 titles), so a kept row scrolls on as far as it was seen
 * rather than ending at its first page. A row scrolled further (rows page on without end) would otherwise push every
 * other screen's pages out of the store.
 */
const KEPT_DEPTH = 120;
const deep = (href: string) => Number(/[?&]skip=(\d+)/.exec(href)?.[1] ?? 0) >= KEPT_DEPTH;

/**
 * `network`, with atlas's answers to `KEPT_ROUTE` GETs kept in `store`, and handed out in place of a failed request (a
 * network error or a 5xx) for `RETENTION`. A kept answer carries `X-Den-Kept` with when it was fetched.
 */
export function keepingAtlasFetch(
  network: typeof fetch,
  store: Kept<KeptAtlasAnswer> | null = defaultStore,
  now: () => number = Date.now,
): typeof fetch {
  if (!store) return network;
  let pruned = false;
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'GET' || !KEPT_ROUTE.test(href.split(/[?#]/)[0]!) || deep(href))
      return network(input, init);
    if (!pruned) {
      pruned = true;
      void store.prune(now() - RETENTION, MOST_KEPT, PRUNE_BATCH).catch(() => undefined);
    }
    const kept = async (failed: () => Response | Promise<Response>): Promise<Response> => {
      const answer = await store.get(href).catch(() => undefined);
      if (!answer || now() - answer.fetchedAt >= RETENTION) {
        providerUnreachable();
        return failed();
      }
      keptAnswerServed('atlas');
      return new Response(answer.body, {
        headers: { 'content-type': 'application/json', 'x-den-kept': String(answer.fetchedAt) },
      });
    };
    let response: Response;
    try {
      response = await network(input, init);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      return kept(() => Promise.reject(error));
    }
    if (response.status >= 500) return kept(() => response);
    if (response.ok && response.headers.get('content-type')?.includes('json')) {
      providerAnswered('atlas');
      void response
        .clone()
        .text()
        .then((body) => store.put(href, { body, fetchedAt: now() }))
        .catch(() => undefined);
    }
    return response;
  };
}
