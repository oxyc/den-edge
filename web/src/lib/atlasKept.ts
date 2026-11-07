// Atlas's browse answers kept in this browser (IndexedDB), for when den-edge cannot be reached: the box or its uplink
// down, and Cloudflare holding no copy of its own (with one household's traffic it often holds none). A screen then
// opens on the rows, charts and billboard this browser last saw rather than a wall of failed rows. Only a failure
// reads what is kept: while atlas answers, every answer is the live one and is kept in place of the last.
//
// Only the first page of what a screen opens on is kept, never a search or a filter, which would churn the store a
// keystroke at a time, and only for a profile without a content policy (`ContentAuthority`): a Kid's answers stay
// live-only.

import { keptAnswerServed, providerAnswered } from './keptAnswers';
import { indexedKept, type Kept } from './tmdbCache';

const DAY = 86_400_000;
/** How long a kept answer may stand in. Atlas's answers move with its dataset, at most daily. */
export const RETENTION = 30 * DAY;
/** The most answers kept: a row or chart page is some kilobytes, so the store stays at a few megabytes. */
export const MOST_KEPT = 300;
const PRUNE_BATCH = 50;
/** A tab kept open prunes again after this many answers kept, not only once per Worker. */
const PRUNE_EVERY = 100;

export interface KeptAtlasAnswer {
  body: string;
  /** Atlas's `X-Den-Policy`, which the reader checks against the policy it asked under. */
  policy: string | null;
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
 * A row's later pages: a screen opens on the first, and a row scrolled far along (rows page on without end) would
 * otherwise push every other screen's first page out of the store.
 */
const LATER_PAGE = /[?&]skip=(?!0(?:&|$))/;

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
  let keptSince: number | undefined;
  const prune = () => {
    keptSince = 0;
    void store.prune(now() - RETENTION, MOST_KEPT, PRUNE_BATCH).catch(() => undefined);
  };
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'GET' || !KEPT_ROUTE.test(href.split(/[?#]/)[0]!) || LATER_PAGE.test(href))
      return network(input, init);
    if (keptSince === undefined) prune();
    const kept = async (failed: () => Response | Promise<Response>): Promise<Response> => {
      const answer = await store.get(href).catch(() => undefined);
      if (!answer || now() - answer.fetchedAt >= RETENTION) return failed();
      keptAnswerServed('atlas');
      const headers = new Headers({
        'content-type': 'application/json',
        'x-den-kept': String(answer.fetchedAt),
      });
      if (answer.policy) headers.set('x-den-policy', answer.policy);
      return new Response(answer.body, { status: 200, headers });
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
      const policy = response.headers.get('x-den-policy');
      void response
        .clone()
        .text()
        .then((body) => store.put(href, { body, policy, fetchedAt: now() }))
        .then(() => {
          if (keptSince !== undefined && ++keptSince >= PRUNE_EVERY) prune();
        })
        .catch(() => undefined);
    }
    return response;
  };
}
