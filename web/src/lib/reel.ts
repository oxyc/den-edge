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
  height?: number,
): string | null {
  // Never encoded: reel matches `tmdb:` on the raw path, so a percent-encoded colon would not be seen.
  const id =
    ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb ? encodeURIComponent(ids.imdb) : null;
  if (!id) return null;
  const params = new URLSearchParams();
  if (prewarm === 'direct') params.set('prewarm', 'direct');
  // reel keeps a separate resolve per height step, so the warm-up has to name the same one the page
  // will go on to ask for — otherwise the request that matters pays a cold resolve anyway.
  if (height) params.set('height', String(height));
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
const warmed = new Map<string, { found: TrailerCandidate[]; at: number }>();
const WARM_TTL_MS = 5 * 60_000;

/**
 * What the remembered URLs are only true for.
 *
 * The origin belongs in it: these are finished play URLs, pointing at whichever of reel's addresses
 * the page could reach when they were built. Remembering them by title alone would hand a page that
 * has since moved — discovery answering, a LAN address giving way to the public one — URLs for a
 * host it can no longer fetch from.
 */
function warmKey(
  origin: string,
  base: string,
  type: MediaType,
  ids: TitleIds,
  height?: number,
): string | null {
  const id = ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb;
  return id ? `${origin}|${base}|${type}|${id}|${height ?? ''}` : null;
}

/** Forget it. Tests ask the same title twice and mean it both times. */
export function forgetWarmedTrailers(): void {
  warmed.clear();
}

/** One trailer reel offered for a title. */
export interface TrailerCandidate {
  /** reel's `/play/<id>.mp4?s=…`: the download, and what every pre-`/sources` path was derived from. */
  play: string;
  /**
   * `/sources/<id>.json?s=…`, where reel says what to play on a given surface — null on an answer from
   * a reel older than 0.29.0, which is the signal to derive it from `play` the way we always did.
   */
  sources: string | null;
}

/**
 * One of reel's own URLs, moved onto the address this page can actually reach.
 *
 * reel names its links by whatever address it was asked at, which is the LAN one behind the relay. What
 * its signature covers is the video and the install rather than the host, so the path and query travel
 * and the origin is replaced. `tail` is the shape being kept, so a link naming anything else is refused
 * rather than rewritten into a path that does not exist.
 */
function onOrigin(raw: unknown, origin: string, tail: RegExp): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const link = new URL(raw);
    if (!['http:', 'https:'].includes(link.protocol)) return null;
    const path = link.pathname.match(tail)?.[0];
    return path ? `${origin}${path}${link.search}` : null;
  } catch {
    // One malformed link does not discard the remaining candidates.
    return null;
  }
}

/**
 * Ordered, distinct play URLs: what every surface asked for before `/sources`, and the fallback after.
 *
 * Kept as its own function so each surface moves to `/sources` on its own, rather than all of them
 * moving in the commit that changes what reel is asked.
 */
export async function trailerURLs(
  base: string,
  type: MediaType,
  ids: TitleIds,
  routes: Routes,
  options: Parameters<typeof trailerCandidates>[4] = {},
): Promise<string[]> {
  return (await trailerCandidates(base, type, ids, routes, options)).map((found) => found.play);
}

/** Ordered, distinct candidates. A removed or portrait first video must not hide every other trailer. */
export async function trailerCandidates(
  base: string,
  type: MediaType,
  ids: TitleIds,
  routes: Routes,
  {
    fetchImpl = relayFetch,
    secure = globalThis.location?.protocol !== 'http:',
    signal,
    prewarm = 'full',
    height,
  }: {
    fetchImpl?: typeof fetch;
    secure?: boolean;
    signal?: AbortSignal;
    /**
     * The rung this surface will go on to ask for. reel keeps one resolve per height step, so naming
     * it here is what makes the warm-up warm the entry that is actually used.
     */
    height?: number;
    /**
     * What reel should get ready. `direct` asks it to resolve YouTube's URLs and skip downloading
     * the file — right for a surface that will play those URLs, and wrong for one that falls back
     * to `/play`, which would then be cold exactly when it is needed.
     */
    prewarm?: 'full' | 'direct';
  } = {},
): Promise<TrailerCandidate[]> {
  const origin = mediaBase(base, routes.reel ?? [], secure);
  if (!origin) return [];
  // What the press already resolved, if it is still good: the page that press opened can name its
  // source on its first render rather than after a round trip.
  const key = warmKey(origin, base, type, ids, height);
  const already = key ? warmed.get(key) : undefined;
  if (already && Date.now() - already.at < WARM_TTL_MS) return already.found;
  const asked = metaURL(base, type, ids, prewarm, height);
  if (!asked) return [];
  try {
    const res = await fetchImpl(asked, { signal });
    if (!res.ok) return [];
    const body = await res.json();
    if (!Array.isArray(body?.meta?.links)) return [];
    const found: TrailerCandidate[] = [];
    for (const candidate of body.meta.links) {
      const play = onOrigin(candidate?.trailers, origin, /\/play\/[^/]+$/);
      if (!play) continue;
      if (found.some((had) => had.play === play)) continue;
      // reel names this from 0.29.0. Older answers carry none, and a surface then derives what it
      // plays from the play URL, exactly as every version before /sources did.
      found.push({ play, sources: onOrigin(candidate?.sources, origin, /\/sources\/[^/]+$/) });
    }
    // Only a real answer is remembered. An empty list is usually reel saying "not yet" — a resolve
    // still running, an upstream that faulted — and pinning that for five minutes would leave the
    // page with no trailer long after one existed.
    if (key && found.length) warmed.set(key, { found, at: Date.now() });
    return found;
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
 * The `/direct/<id>.json` sibling of a play URL: the googlevideo URLs themselves.
 *
 * Signed by the same tag as every other sibling, because reel signs over the video and the install
 * rather than the path — so the tag `/meta` already handed us is the one this wants.
 */
export function directURL(playURL: string): string | null {
  return sibling(playURL, 'direct', 'json');
}

/**
 * The `/progressive/<id>.mp4` sibling of a play URL: the same trailer with its index in FRONT.
 *
 * YouTube's own file is fragmented — an empty sample table, a `sidx`, then twenty-eight `moof`/`mdat`
 * pairs — so a player that wants to start at the beginning has to visit every fragment first to learn
 * what is in them. Safari does exactly that, measured: twenty-six range requests opened and abandoned
 * across a 32 MB file before it would play, 2.4s to metadata and 4.9s to `canplay`, where Chrome took
 * 811ms. reel reads that index once and serves a normal MP4 with a real `moov` at the front, mapping
 * each byte range back to Google's file.
 *
 * `height` asks reel for a smaller rung. Worth it where the bytes cross the homelab — which they do
 * here, since a rewritten index means every offset differs from Google's and something has to
 * translate — and not worth it on a surface someone is actually watching.
 */
export function progressiveURL(playURL: string, height?: number): string | null {
  const url = sibling(playURL, 'progressive', 'mp4');
  if (!url || !height) return url;
  return `${url}${url.includes('?') ? '&' : '?'}height=${height}`;
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

/**
 * What a surface is: whether sound can ever be asked for on it, not how closely it is being watched.
 *
 * `silent` never gains sound — Home's billboard, muted behind a scrim. `audible` may be asked for sound at
 * any moment with no navigation, which is the detail hero: it starts muted and a press unmutes it in place.
 *
 * The distinction decides the source, and getting it wrong is expensive in both directions. A silent surface
 * can take reel's ordered file, which is several times sooner to a frame. An audible one cannot, unless that
 * file carries audio, or sound costs a reload and a seek at the moment someone reaches for the volume.
 */
export type Surface = 'silent' | 'audible';

/** Whether this browser hands a playlist to the element or drives hls.js, which changes what reel offers. */
export type Player = 'native' | 'hls.js';

/** Where the picture actually is inside the frame, as fractions; `null` until reel has measured it. */
export interface Crop {
  letterboxed: boolean;
  aspect: number;
  /** `[x, y, w, h]` of the content within the frame. */
  rect: [number, number, number, number];
}

/**
 * One thing reel can play for this trailer. `kind` is the ONLY thing that says how to play `url`.
 *
 * Reading it off the path is what the old helpers did, and a minted URL has no path to read: it is
 * `/m/<blob>` whatever it serves. A missing or wrong `kind` hands a playlist to a bare element.
 */
export interface Source {
  kind: 'mp4' | 'hls';
  url: string;
  audio: boolean;
  height: number | null;
}

/** reel's answer for one trailer on one surface: ordered best-first, and what it knows about the picture. */
export interface Sources {
  sources: Source[];
  crop?: Crop | null;
  /** Epoch seconds after which the minted URLs stop working; a 410 means ask again. */
  expires?: number;
}

/**
 * Ask reel what to play, and by asking, have it made ready.
 *
 * This replaces deriving sibling paths from a play URL. reel chooses per surface and player from its own
 * measurements — which are the ones that matter, since the same URL is 232 ms warm and 5131 ms cold — and
 * the request itself does the warming: it waits for the resolve its first entry plays from, and for the
 * index when that entry needs one. So there is no separate prewarm to remember, and nothing to keep in
 * step with what the surface later asks for.
 */
export async function fetchSources(
  sources: string,
  {
    surface,
    player,
    playable,
    fetchImpl = relayFetch,
    signal,
  }: {
    surface: Surface;
    player: Player;
    /** This browser's codec report, which reel filters its variants by. */
    playable?: unknown;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<Sources | null> {
  try {
    const url = new URL(sources, globalThis.location?.href ?? 'http://relative.invalid');
    url.searchParams.set('surface', surface);
    url.searchParams.set('player', player);
    // In the query rather than the header: den-edge's relay forwards only the range and conditional
    // headers, so `X-Den-Playable` never crosses it. reel reads both and the header wins where it arrives.
    if (playable) url.searchParams.set('playable', JSON.stringify(playable));
    const asked = /^[a-z][a-z0-9+.-]*:/i.test(sources)
      ? url.toString()
      : `${url.pathname}${url.search}`;
    const res = await fetchImpl(asked, { signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body?.sources)) return null;
    const list: Source[] = [];
    for (const entry of body.sources) {
      // `kind` and `url` are the two that cannot be guessed; anything without both is unusable.
      if (typeof entry?.url !== 'string') continue;
      if (entry.kind !== 'mp4' && entry.kind !== 'hls') continue;
      // Distinct URLs only. A fallback step that lands on the URL already mounted changes nothing, fires
      // no load and no error, and stops the ladder where it stood — reel dedupes, and so do we.
      if (list.some((had) => had.url === entry.url)) continue;
      list.push({
        kind: entry.kind,
        url: entry.url,
        audio: entry.audio === true,
        height: typeof entry.height === 'number' ? entry.height : null,
      });
    }
    if (!list.length) return null;
    return { sources: list, crop: crop(body.crop), expires: body.expires };
  } catch {
    return null;
  }
}

/** reel's crop, or null: anything malformed is "not measured" rather than a guess at the picture. */
function crop(value: unknown): Crop | null {
  if (!value || typeof value !== 'object') return null;
  const { letterboxed, aspect, rect } = value as Partial<Crop>;
  if (letterboxed !== true || typeof aspect !== 'number') return null;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== 'number'))
    return null;
  return { letterboxed, aspect, rect: rect as [number, number, number, number] };
}

/**
 * How to draw a letterboxed trailer so the picture fills the box and the bars fall outside it.
 *
 * YouTube trailers are routinely 2.x:1 content posted in a 16:9 frame, so a plain `object-fit: cover` still
 * shows black bands. reel measures where the picture is; this turns that into a scale about the content's
 * own centre. The trade is the one the Apple TV already makes through the baked `clap`: a 2.39 trailer in a
 * 16:9 hero loses a little at the sides instead of showing bars.
 *
 * Returns null when there is nothing to do, so an unmeasured trailer simply draws as it always did.
 */
export function cropStyle(crop: Crop | null | undefined): string | null {
  if (!crop?.letterboxed) return null;
  const [x, y, w, h] = crop.rect;
  if (!(w > 0) || !(h > 0)) return null;
  // Cover the box with the CONTENT rect rather than the whole frame: the frame is already covering, so the
  // extra factor is how much of it is picture.
  const scale = Math.max(1 / w, 1 / h);
  if (!Number.isFinite(scale) || scale <= 1) return null;
  const origin = `${((x + w / 2) * 100).toFixed(3)}% ${((y + h / 2) * 100).toFixed(3)}%`;
  return `transform: scale(${scale.toFixed(4)}); transform-origin: ${origin};`;
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
    height?: number;
  } = {},
): Promise<string | null> {
  return (await trailerURLs(base, type, ids, routes, options))[0] ?? null;
}
