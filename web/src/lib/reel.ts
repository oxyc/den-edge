// den-reel's trailers: the plain MP4 the TV plays behind its hero, rather than YouTube's embed with its own
// furniture, its own autoplay rules and its own error card.
//
// Both the lookup and the video go through this origin, which den-edge relays to reel's LAN address (as it
// does `/scout` and `/atlas`). reel names its own play URLs by whatever address it was asked at — the LAN one,
// behind the relay — so the origin is swapped for the relay's own mount. What the signature covers is the
// video and the install that asked for it, not the host, so it survives the swap.
//
// Anywhere but this origin there is no address to swap in that a browser off the tailnet can resolve: reel's
// public name is behind Cloudflare Access, which a page has no service token for. Hence the relay, and only
// where the page is not served by den-edge does it fall back to reel's own addresses.

import type { MediaType } from './library';
import { relayFetch } from './relayFetch';
import type { Entry, Routes } from './routes';

/** reel's first address this page can load a video from: never plaintext on an https page, never behind Access. */
function reachable(
  entries: Entry[],
  secure = globalThis.location?.protocol !== 'http:',
): string | null {
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    return entry.url.replace(/\/$/, '');
  }
  return null;
}

/**
 * Where this page loads a trailer's bytes from.
 *
 * The relay's own mount whenever reel was found on this origin — same-origin, so no CORS, no Access token
 * and `media-src 'self'` covers it. `base` may carry an install's config (`/reel/<cfg>`); a play URL is
 * signed rather than configured, so only the mount travels.
 */
function mediaBase(
  base: string,
  entries: Entry[],
  secure = globalThis.location?.protocol !== 'http:',
): string | null {
  if (base.startsWith('/')) return `/${base.split('/')[1]}`;
  return reachable(entries, secure);
}

/**
 * What reel is told about a title.
 *
 * A tmdb id is the one it can use outright — asked by an imdb id, it spends a lookup turning it into the
 * tmdb id we already had. Naming BOTH spares it every later conversion too, since the sources it falls
 * back on are keyed differently from each other. And a title with no imdb id can reach it at all this way,
 * where before it simply went without a trailer.
 */
export interface TitleIds {
  tmdb?: number;
  imdb?: string;
}

/** Where reel is asked about this title: the id it prefers, and the other one as a companion. */
function metaURL(
  base: string,
  type: MediaType,
  ids: TitleIds,
  prewarm: 'full' | 'direct',
): string | null {
  // Never encoded: reel matches `tmdb:` on the raw path, so a percent-encoded colon would not be seen.
  const id =
    ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb ? encodeURIComponent(ids.imdb) : null;
  if (!id) return null;
  const params = new URLSearchParams();
  if (prewarm === 'direct') params.set('prewarm', 'direct');
  if (ids.tmdb !== undefined && ids.imdb) params.set('imdb', ids.imdb);
  const query = params.toString();
  return `${base}/meta/${type === 'tv' ? 'series' : 'movie'}/${id}.json${query ? `?${query}` : ''}`;
}

/**
 * What a press already resolved, so the page it opens does not ask again.
 *
 * `warmOnIntent` runs this same lookup on pointerdown, ~150ms before the click lands — and the detail
 * page then threw that away and repeated it, with `cache: 'no-cache'` forcing a revalidation, before
 * it could name a single source. That round trip was the first thing between opening a title and its
 * trailer starting. Five minutes: long enough to cover the press and a look around the page, short
 * enough that reel's own answer still governs.
 *
 * The forced revalidation is gone too, so the browser's own cache can answer a later visit outright
 * instead of a conditional request preceding every trailer. That is safe because reel tells the two
 * cases apart itself rather than leaving it to the page: an answer carrying links is sent with a
 * `max-age`, while an EMPTY links list — "no trailer resolved yet" — is sent `no-store`, so a miss is
 * never pinned and the next visit asks again. Checked in den-reel's own source and its test, not
 * assumed: `addon.rs` builds both, and a test asserts `no-store` on empty links.
 */
const warmed = new Map<string, { urls: string[]; at: number }>();
const WARM_TTL_MS = 5 * 60_000;

/**
 * What the remembered URLs are only true for.
 *
 * The origin belongs in it: these are finished play URLs, pointing at whichever of reel's addresses
 * the page could reach when they were built. Remembering them by title alone would hand a page that
 * has since moved — discovery answering, a LAN address giving way to the public one — URLs for a
 * host it can no longer fetch from.
 */
function warmKey(origin: string, base: string, type: MediaType, ids: TitleIds): string | null {
  const id = ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb;
  return id ? `${origin}|${base}|${type}|${id}` : null;
}

/** Forget it. Tests ask the same title twice and mean it both times. */
export function forgetWarmedTrailers(): void {
  warmed.clear();
}

/** Ordered, distinct candidates. A removed or portrait first video must not hide every other trailer. */
export async function trailerURLs(
  base: string,
  type: MediaType,
  ids: TitleIds,
  routes: Routes,
  {
    fetchImpl = relayFetch,
    secure = globalThis.location?.protocol !== 'http:',
    signal,
    prewarm = 'full',
  }: {
    fetchImpl?: typeof fetch;
    secure?: boolean;
    signal?: AbortSignal;
    /**
     * What reel should get ready. `direct` asks it to resolve YouTube's URLs and skip downloading
     * the file — right for a surface that will play those URLs, and wrong for one that falls back
     * to `/play`, which would then be cold exactly when it is needed.
     */
    prewarm?: 'full' | 'direct';
  } = {},
): Promise<string[]> {
  const origin = mediaBase(base, routes.reel ?? [], secure);
  if (!origin) return [];
  // What the press already resolved, if it is still good: the page that press opened can name its
  // source on its first render rather than after a round trip.
  const key = warmKey(origin, base, type, ids);
  const already = key ? warmed.get(key) : undefined;
  if (already && Date.now() - already.at < WARM_TTL_MS) return already.urls;
  const asked = metaURL(base, type, ids, prewarm);
  if (!asked) return [];
  try {
    const res = await fetchImpl(asked, { signal });
    if (!res.ok) return [];
    const body = await res.json();
    if (!Array.isArray(body?.meta?.links)) return [];
    const urls: string[] = [];
    for (const candidate of body.meta.links) {
      if (typeof candidate?.trailers !== 'string') continue;
      try {
        const link = new URL(candidate.trailers);
        if (!['http:', 'https:'].includes(link.protocol)) continue;
        // A PUBLIC_BASE_URL may already include a /reel mount. Only the signed play path travels.
        const play = link.pathname.match(/\/play\/[^/]+$/)?.[0];
        if (!play) continue;
        const url = `${origin}${play}${link.search}`;
        if (!urls.includes(url)) urls.push(url);
      } catch {
        /* One malformed link does not discard the remaining candidates. */
      }
    }
    // Only a real answer is remembered. An empty list is usually reel saying "not yet" — a resolve
    // still running, an upstream that faulted — and pinning that for five minutes would leave the
    // page with no trailer long after one existed.
    if (key && urls.length) warmed.set(key, { urls, at: Date.now() });
    return urls;
  } catch {
    return [];
  }
}

/**
 * The `/hls/<id>.m3u8` sibling of a play URL: reel's copy of YouTube's own HLS master.
 *
 * What every browser plays, by one of two routes. Where the page drives hls.js, this is the only
 * master it can read at all — googlevideo answers MSE's segment fetches with no CORS header — so
 * reel rewrites every URI in it to come back through reel.
 *
 * `native` is the other route, for a bare `<video>`: reel leaves the URIs on googlevideo, which a
 * media element may fetch cross-origin, so the segments still come straight from Google and only
 * the playlist crosses the homelab. It is worth that one request for what reel does to the master
 * on the way past — it puts the best variant first. YouTube's own order is not a ladder (240p is
 * listed first, the 144p rungs sit below 1080p), and a native player opens on whichever variant it
 * reads first, so every trailer on iOS started at 426x240 and spent its ninety seconds climbing.
 */
export function hlsURL(playURL: string, native = false): string | null {
  const url = sibling(playURL, 'hls', 'm3u8');
  if (!url || !native) return url;
  return `${url}${url.includes('?') ? '&' : '?'}native=1`;
}

/**
 * Is this URL an HLS playlist?
 *
 * Read from the PATH. reel signs its play links, so a playlist URL ends `…m3u8?s=<tag>`, and asking
 * whether the whole URL ends in `.m3u8` answered no for every signed one of them.
 */
export function isPlaylist(url: string): boolean {
  return /\.m3u8$/.test(url.split(/[?#]/)[0] ?? '');
}

/**
 * One of a play URL's siblings, query and all: `/play/<id>.mp4` → `/<route>/<id>.<extension>`.
 *
 * Derived from the play URL rather than asked for separately, because the signature reel demands is
 * over the video and the install — not the path — so the tag `/meta` already handed us is the tag
 * these want. That also keeps the whole thing to one `/meta` round-trip.
 */
function sibling(playURL: string, route: string, extension: string): string | null {
  try {
    // Relative against this page, since a play URL through the relay is a path on this origin. The stand-in
    // base is only there so a path still parses where there is no page (tests, a worker); a relative URL
    // comes back relative, so it never leaves this function.
    const url = new URL(playURL, globalThis.location?.href ?? 'http://relative.invalid');
    const id = url.pathname.match(/\/play\/([A-Za-z0-9_-]{11})\.mp4$/)?.[1];
    if (!id) return null;
    url.pathname = url.pathname.replace(/\/play\/[^/]+$/, `/${route}/${id}.${extension}`);
    // A path in stays a path out, so a relayed lookup is asked for on this origin rather than at
    // whatever address the page happens to be served from.
    return /^[a-z][a-z0-9+.-]*:/i.test(playURL) ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** What decides whether a bare `<video>` is given the playlist, or hls.js is. */
export interface HlsSupport {
  /** What a `<video>` says it can do with an HLS master. */
  claims: () => string;
  /** Apple's own WebKit: Safari everywhere, and every browser on iOS. */
  apple: boolean;
  /** MediaSource, which is what hls.js needs. ManagedMediaSource counts — hls.js drives that too. */
  mse: boolean;
}

function support(): HlsSupport {
  return {
    claims: () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
    // Frozen by spec at "Apple Computer, Inc." in WebKit, and "Google Inc." in every Chromium.
    apple: globalThis.navigator?.vendor === 'Apple Computer, Inc.',
    mse: 'MediaSource' in globalThis || 'ManagedMediaSource' in globalThis,
  };
}

/** Whether hls.js has a MediaSource to drive at all. `ManagedMediaSource` counts; iOS gives that one. */
export function mediaSource(env: HlsSupport = support()): boolean {
  return env.mse;
}

/**
 * Should this browser be handed an HLS master to play by itself?
 *
 * The element's own claim is no longer enough. Chrome 151 answers "maybe" — it does have a native
 * HLS player — and then, given a master, fetches the playlists and never asks for a segment: the
 * trailer sits at readyState 0, paused, with no data and no error to fall back on. So the claim is
 * believed where it has always worked, Apple's WebKit, or where there is no MediaSource to run
 * hls.js with instead, which is the one case a bare element is all there is.
 */
export function nativeHls(env: HlsSupport = support()): boolean {
  try {
    if (env.claims() === '') return false;
    return env.apple || !env.mse;
  } catch {
    return false;
  }
}

/** Browse billboards use the first candidate; detail playback can advance through the full list. */
export async function trailerURL(
  base: string,
  type: MediaType,
  ids: TitleIds,
  routes: Routes,
  options: {
    fetchImpl?: typeof fetch;
    secure?: boolean;
    signal?: AbortSignal;
    prewarm?: 'full' | 'direct';
  } = {},
): Promise<string | null> {
  return (await trailerURLs(base, type, ids, routes, options))[0] ?? null;
}
