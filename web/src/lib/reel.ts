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
import { ipv4Hint } from './ipv4';
import { mayUseLocalNetwork } from './remuxRoute';
import { relayFetch } from './relayFetch';
import type { Entry, Routes } from './routes';

/**
 * A host a page may only reach from inside the same network: RFC 1918, localhost, `*.local`, and the
 * tailnet — both by name and by the CGNAT range Tailscale hands out. Chrome's Local Network Access
 * classifies `100.64.0.0/10` as local exactly as it does the RFC 1918 ranges, and refuses a public
 * page's request to any of them unless the viewer has granted a permission the page cannot ask for on
 * its own behalf (oxyc/den-edge#8).
 */
function localHost(host: string): boolean {
  const name = host.toLowerCase();
  if (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '[::1]' ||
    name.endsWith('.local') ||
    name.endsWith('.ts.net')
  )
    return true;
  const labels = name.split('.');
  if (labels.length !== 4 || !labels.every((l) => /^\d{1,3}$/.test(l) && Number(l) <= 255))
    return false;
  const [a = -1, b = -1] = labels.map(Number);
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * reel's first address this page can load a video from: never plaintext on an https page, never behind
 * Access, and never a local address from a page that is not itself local.
 *
 * That last one is a guard rather than a fix for anything observed. Today every base reaching
 * `mediaBase` is relative, so this branch does not run — but nothing enforced that, and an absolute
 * base here would send video straight at a LAN or tailnet host from the public origin, where the
 * browser refuses it with no error the page can see. Keeping the check next to the choice means the
 * accident cannot come back through a different door.
 */
function reachable(
  entries: Entry[],
  secure = globalThis.location?.protocol !== 'http:',
  here = globalThis.location?.hostname ?? '',
): string | null {
  const pageIsLocal = here !== '' && localHost(here);
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    if (!pageIsLocal) {
      try {
        if (localHost(new URL(entry.url).hostname)) continue;
      } catch {
        continue; // Not a URL this page can resolve, so not one it can play from either.
      }
    }
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
function discoveryURL(
  base: string,
  route: 'meta' | 'prepare',
  type: MediaType,
  ids: TitleIds,
  prewarm: 'full' | 'direct',
  height?: number,
  sourceAsk?: SourceAsk,
): string | null {
  // Never encoded: reel matches `tmdb:` on the raw path, so a percent-encoded colon would not be seen.
  const id =
    ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb ? encodeURIComponent(ids.imdb) : null;
  if (!id) return null;
  const params = new URLSearchParams();
  if (route === 'meta' && prewarm === 'direct') params.set('prewarm', 'direct');
  if (route === 'prepare' && sourceAsk) {
    params.set('surface', sourceAsk.surface);
    params.set('player', sourceAsk.player);
    params.set('intent', sourceAsk.intent ?? 'play');
    if (sourceAsk.playable) params.set('playable', JSON.stringify(sourceAsk.playable));
  }
  // reel keeps a separate resolve per height step, so the warm-up has to name the same one the page
  // will go on to ask for — otherwise the request that matters pays a cold resolve anyway.
  if (height) params.set('height', String(height));
  if (ids.tmdb !== undefined && ids.imdb) params.set('imdb', ids.imdb);
  const query = params.toString();
  return `${base}/${route}/${type === 'tv' ? 'series' : 'movie'}/${id}.json${query ? `?${query}` : ''}`;
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
/** Reel bases that answered as a version predating `/prepare`; forgotten with the other short-lived lookup state. */
const prepareUnsupported = new Set<string>();

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
  prepareUnsupported.clear();
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
  /**
   * The primary ladder returned by Reel's combined `/prepare` request. Absent after the legacy
   * `/meta` path; null when `/prepare` completed but could not prepare this primary candidate.
   */
  prepared?: Sources | null;
}

/** The source question `/prepare` can answer beside trailer discovery. */
export interface SourceAsk {
  surface: Surface;
  player: Player;
  intent?: 'warm';
  playable?: unknown;
  /** The browser's public IPv4 lookup, injected by tests and called only after edge asks for it. */
  lookupIpv4?: () => Promise<string | undefined>;
  /** Whether a carried source may play through this origin's relay (`relaysMedia`); tests name it. */
  relay?: boolean;
  /** Test seam for the browser-owned local-media proof. */
  probeLocalMedia?: (media: string) => Promise<boolean>;
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
 * Where to actually fetch one source reel offered.
 *
 * Every url is a URI reference resolved against the `/sources` URL that was asked for — the same rule
 * reel already uses for the segment URIs inside a playlist, and for the same reason: no proxy has to
 * forward a host or a prefix, and this page never has to know the mount it is served under.
 *
 * Three cases, and all three are real. A relative reference resolves onto this origin, which is what
 * reel answers from 0.37.0. An absolute URL naming one of reel's OWN addresses is moved onto the mount:
 * older reels answer that way, naming the LAN address they were asked at, and a browser cannot fetch it
 * — the page's `connect-src` refuses it and off the LAN it answers nothing at all, which is exactly how
 * trailers broke. Any other absolute URL passes through untouched, because Google's own file is one of
 * the rungs reel offers and it is meant to be fetched straight from Google.
 */
function sourceAt(raw: string, asked: URL, mount: string): string | null {
  try {
    const at = new URL(raw, asked);
    // Same origin: hand back a path, so it travels through the relay as every other reel URL does.
    if (at.origin === asked.origin) return `${at.pathname}${at.search}`;
    const minted = at.pathname.match(/\/m\/.+$/)?.[0];
    return minted ? `${mount}${minted}${at.search}` : at.toString();
  } catch {
    return null;
  }
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
    sourceAsk,
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
    /**
     * Collapse discovery and the primary source ladder into Reel's `/prepare` request. A Reel
     * version without that additive endpoint falls back to `/meta` and the caller's ordinary
     * `fetchSources` path.
     */
    sourceAsk?: SourceAsk;
  } = {},
): Promise<TrailerCandidate[]> {
  const origin = mediaBase(base, routes.reel ?? [], secure);
  if (!origin) return [];
  // What the press already resolved, if it is still good: the page that press opened can name its
  // source on its first render rather than after a round trip.
  const key = warmKey(origin, base, type, ids, height);
  const already = key ? warmed.get(key) : undefined;
  if (already && Date.now() - already.at < WARM_TTL_MS) return already.found;
  const legacy = discoveryURL(base, 'meta', type, ids, prewarm, height);
  if (!legacy) return [];
  if (sourceAsk && !prepareUnsupported.has(base)) {
    const preparedURL = discoveryURL(base, 'prepare', type, ids, prewarm, height, sourceAsk);
    if (preparedURL) {
      let response: Response;
      try {
        response = await fetchImpl(preparedURL, { signal });
      } catch {
        // A failed combined request must not immediately repeat its discovery/provider work through
        // the legacy chain. A later interaction may try again.
        return [];
      }
      if (response.ok) {
        let body: {
          meta?: { links?: unknown };
          primary?: { sourcesBase?: unknown } | null;
          prepared?: unknown;
        } | null = null;
        try {
          body = await response.json();
        } catch {
          // Some old proxy mounts answer unknown routes with an HTML shell and status 200.
          prepareUnsupported.add(base);
        }
        if (Array.isArray(body?.meta?.links) && Object.hasOwn(body, 'primary')) {
          const found = candidatesFrom(body, origin);
          const first = found[0];
          const sourcesBase = onOrigin(body?.primary?.sourcesBase, origin, /\/sources\/[^/]+$/);
          if (first && sourcesBase && first.sources === sourcesBase) {
            const prepared = body.prepared as { playReady?: unknown } | null | undefined;
            first.prepared =
              prepared?.playReady === true
                ? await sourcesFrom(body, sourcesBase, {
                    ...sourceAsk,
                    fetchImpl,
                    signal,
                  })
                : null;
          }
          rememberCandidates(key, found);
          return found;
        }
        // A successful response without the combined schema identifies a pre-prepare mount.
        prepareUnsupported.add(base);
      } else if (response.status === 404 || response.status === 405) {
        // Mixed rollout: remember an older Reel for this page lifetime instead of paying one known
        // 404 before every title's legacy request.
        prepareUnsupported.add(base);
      } else {
        // Genuine prepare/provider failure: do not duplicate the same upstream work through `/meta`.
        return [];
      }
      if (signal?.aborted) return [];
    }
  }
  try {
    const response = await fetchImpl(legacy, { signal });
    if (!response.ok) return [];
    const body = await response.json();
    const found = candidatesFrom(body, origin);
    rememberCandidates(key, found);
    return found;
  } catch {
    return [];
  }
}

/** The usable candidates in either `/meta` or `/prepare`'s shared metadata envelope. */
function candidatesFrom(body: unknown, origin: string): TrailerCandidate[] {
  const links = (body as { meta?: { links?: unknown } })?.meta?.links;
  if (!Array.isArray(links)) return [];
  const found: TrailerCandidate[] = [];
  for (const candidate of links) {
    const link = candidate as { trailers?: unknown; sources?: unknown };
    const play = onOrigin(link?.trailers, origin, /\/play\/[^/]+$/);
    if (!play || found.some((had) => had.play === play)) continue;
    // reel names this from 0.29.0. Older answers carry none, and a surface then derives what it
    // plays from the play URL, exactly as every version before /sources did.
    found.push({ play, sources: onOrigin(link?.sources, origin, /\/sources\/[^/]+$/) });
  }
  return found;
}

/** Cache discovery only: a provisional warm ladder must never answer a later play request. */
function rememberCandidates(key: string | null, found: TrailerCandidate[]): void {
  if (!key || !found.length) return;
  warmed.set(key, {
    found: found.map(({ play, sources }) => ({ play, sources })),
    at: Date.now(),
  });
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
  width: number | null;
  /**
   * A copy on one of the direct listeners (`directSources`): `lan` the home-network one, `public` the public one.
   * Each is given DIRECT_FIRST_FRAME_MS before the next entry plays.
   */
  direct?: 'lan' | 'public';
}

/** reel's answer for one trailer on one surface: ordered best-first, and what it knows about the picture. */
export interface Sources {
  sources: Source[];
  crop?: Crop | null;
  /** Epoch seconds after which the minted URLs stop working; a 410 means ask again. */
  expires?: number;
}

// One cold IPv6 activation may include the 1.5-second IPv4 lookup, edge's bounded two-second validation, and a
// ten-second listener lease while the host starts/proves Caddy. Keep one shared deadline across both activation asks
// and the lookup; on expiry, go on without a direct origin rather than delaying playback without bound.
const DIRECT_ACTIVATION_MS = 15_000;

/**
 * When a refusal says the direct origin is down (503) or this page asks too often (429), activation is not asked
 * again until then. Without it, a page asked once per trailer: with den-edge's public listener down, a phone sent
 * dozens of refused activations in a minute until den-edge rate-limited it.
 */
const ACTIVATION_PAUSE_MS = 5 * 60_000;
let activationPausedUntil = 0;
/** This page reached edge over IPv6, so later activations can include its already-cached IPv4 answer first. */
let activationNeedsIpv4Hint = false;
/** Until when the home-network origin is passed over, once a copy on it showed nothing from here. */
let lanPausedUntil = 0;
/**
 * Until when a successful activation proved that this browser has a home-network route.
 *
 * The public listener is deliberately unreachable from behind routers without hairpin NAT. A timeout on
 * that copy must not suppress the next candidate's activation there: activation is also how the page is
 * handed `lanBase`, and the next candidate may have a playable progressive file even when the first one did
 * not. Away from home there is no `lanBase`, so the existing pause still protects a down public listener.
 */
let lanOfferedUntil = 0;

/**
 * How long a direct route gets to produce useful media before the next one is tried.
 *
 * An activation answering 200 says the gate opened, not that this browser can reach the origin: at home the router
 * may not loop its public address back in, and iOS's native player can wait without raising an error. The detached
 * LAN proof shares this measured budget; Reel's reordered progressive file reached playback in about 1.07s on the
 * slower Safari path, while two seconds still bounds an LNA refusal before the public route is offered.
 */
export const DIRECT_FIRST_FRAME_MS = 2_000;

// `Permissions.query()` is only a preflight hint. Chrome may report the site permission as granted while the
// concrete destination is still refused (for example by the browser/OS network gate after DNS resolution). An
// isolated media load of the exact signed URL is the only end-to-end proof available before handing that URL to the
// visible <video>, whose internal retries are neither observable nor cancellable one by one.
const LAN_PROBE_TIMEOUT_MS = DIRECT_FIRST_FRAME_MS;
const LAN_PROBE_TTL_MS = ACTIVATION_PAUSE_MS;
let provedLan: { origin: string; at: number } | null = null;
const refusedLan = new Map<string, number>();
const provingLan = new Map<string, Promise<boolean>>();

function pauseActivation(response: Response, now = Date.now()): void {
  if (response.status === 503) activationPausedUntil = now + ACTIVATION_PAUSE_MS;
  else if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    activationPausedUntil =
      now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000);
  }
}

/** For tests: forget a pause and the one just-completed lease. */
export function resetActivationPause(): void {
  activationPausedUntil = 0;
  activationNeedsIpv4Hint = false;
  lanPausedUntil = 0;
  lanOfferedUntil = 0;
  completedActivation = null;
  provedLan = null;
  refusedLan.clear();
  provingLan.clear();
}

/** Let an aborted consumer leave a shared LAN proof without aborting the proof for every other consumer. */
function waitForLanProof(
  pending: Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: boolean) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', stopped);
      resolve(answer);
    };
    const stopped = () => finish(false);
    signal.addEventListener('abort', stopped, { once: true });
    void pending.then(finish, () => finish(false));
  });
}

/**
 * Prove that a bare media element can receive data from this exact local URL.
 *
 * This deliberately is not `fetch`: the shell's tight `connect-src` does not publish each household's private LAN
 * hostname, while `media-src https:` already permits the real player. The element is never attached or played, is
 * always muted, and is fully unloaded after its metadata proves real response bytes or the bounded refusal/timeout.
 */
function probeLocalMedia(media: string): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let finished = false;
    const finish = (usable: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('error', failed);
      video.pause();
      video.removeAttribute('src');
      video.load();
      resolve(usable);
    };
    const loaded = () => finish(true);
    const failed = () => finish(false);
    const timer = setTimeout(failed, LAN_PROBE_TIMEOUT_MS);
    video.addEventListener('loadedmetadata', loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
    try {
      video.src = media;
      video.load();
    } catch {
      finish(false);
    }
  });
}

/** Prove and briefly remember the concrete local media route before mounting it. */
async function proveLanMedia(
  media: string,
  probe: (media: string) => Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(media).origin;
  } catch {
    return false;
  }
  const refusedAt = refusedLan.get(media);
  if (refusedAt !== undefined && Date.now() - refusedAt < LAN_PROBE_TTL_MS) return false;
  if (refusedAt !== undefined) refusedLan.delete(media);
  const remembered = provedLan;
  if (remembered?.origin === origin && Date.now() - remembered.at < LAN_PROBE_TTL_MS) return true;

  let pending = provingLan.get(media);
  if (!pending) {
    pending = probe(media)
      .catch(() => false)
      .then((usable) => {
        if (usable) provedLan = { origin, at: Date.now() };
        else {
          refusedLan.set(media, Date.now());
          // Signed routes expire and a long browse session can see many of them. Keep only the newest refusals.
          while (refusedLan.size > 32) refusedLan.delete(refusedLan.keys().next().value!);
        }
        return usable;
      });
    provingLan.set(media, pending);
    const clear = () => {
      if (provingLan.get(media) === pending) provingLan.delete(media);
    };
    void pending.then(clear, clear);
  }
  return waitForLanProof(pending, signal);
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: a frame is decoded. Spelled out so this runs where the DOM does not. */
const HAVE_CURRENT_DATA = 2;

/**
 * Give up on a mounted direct copy that has no frame within `ms`: `giveUp` steps to the next entry, and that
 * origin is passed over for a while (`abandonDirect`). Nothing for any other source. Returns the cancel, for when
 * the source changes or playback is no longer wanted.
 */
export function watchDirect(
  player: HTMLMediaElement,
  source: Source | null | undefined,
  giveUp: () => void,
  ms = DIRECT_FIRST_FRAME_MS,
): () => void {
  if (!source?.direct || player.readyState >= HAVE_CURRENT_DATA) return () => {};
  const timer = setTimeout(() => {
    if (player.readyState >= HAVE_CURRENT_DATA) return;
    abandonDirect(source);
    giveUp();
  }, ms);
  const arrived = () => clearTimeout(timer);
  player.addEventListener('loadeddata', arrived, { once: true });
  return () => {
    clearTimeout(timer);
    player.removeEventListener('loadeddata', arrived);
  };
}

/**
 * A direct copy did not play from here: its origin is passed over for a while. The public one by not activating at
 * all, as after a 503; the home-network one by leaving it out of the lists built meanwhile.
 */
export function abandonDirect(source: Source, now = Date.now()): void {
  if (
    source.direct === 'public' &&
    // At home, the public copy timing out is normal on a router without hairpin NAT. Keep activation
    // available for later candidates because its answer is also what names their LAN copies.
    (now >= lanOfferedUntil || now < lanPausedUntil)
  )
    activationPausedUntil = Math.max(activationPausedUntil, now + ACTIVATION_PAUSE_MS);
  else if (source.direct === 'lan')
    lanPausedUntil = Math.max(lanPausedUntil, now + ACTIVATION_PAUSE_MS);
}

/**
 * The entry after `from` to try next. Copies on an origin just given up on are passed over: they are on the same
 * unreachable listener, each another deadline to sit out.
 */
export function nextRung(rungs: Source[], from: number, now = Date.now()): number {
  let at = from + 1;
  for (;;) {
    const direct = rungs[at]?.direct;
    if (direct === 'public' && now < activationPausedUntil) at += 1;
    else if (direct === 'lan' && now < lanPausedUntil) at += 1;
    else return at;
  }
}

/**
 * Whether this page may carry a trailer's bytes through its own origin's `/reel` relay.
 *
 * Not on the public web name: it is served through Cloudflare, whose terms do not allow serving video, and
 * den-edge refuses those paths there. A page on the LAN address or the tailnet reaches den-edge directly, so it
 * keeps the relay. Where there is no page (tests, a worker) nothing is played, and nothing is refused.
 */
export function relaysMedia(here = globalThis.location?.hostname ?? ''): boolean {
  return here === '' || localHost(here);
}

/** A signed carried source on this origin, as the edge activation endpoint accepts it. */
function carriedPath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  try {
    const parsed = new URL(url, 'https://relative.invalid');
    if (parsed.origin !== 'https://relative.invalid') return null;
    const match = parsed.pathname.match(/^\/(reel)(?:\/[^/]+)?\/m\/s\/([A-Za-z0-9_-]{40,2048})$/);
    return match && /^s=[0-9a-fA-F]{24}$/.test(parsed.search.slice(1))
      ? `/${match[1]}/m/s/${match[2]}${parsed.search}`
      : null;
  } catch {
    return null;
  }
}

/** A bare https origin from an activation answer, or null for anything else. */
function bareOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const base = new URL(raw);
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash)
      return null;
    return base.origin;
  } catch {
    return null;
  }
}

/** Where activation said this browser may fetch the media: the public listener, and the home-network one at home. */
interface Direct {
  public: string;
  lan: string | null;
}

/** One activation lease being opened. */
const activating = new Map<string, Promise<Direct | null>>();

// A press warm-up and the detail hero commonly ask the same Reel mount for adjacent signed sources a fraction
// of a second apart. The listener remains leased for ten minutes, so repeating the activation does not make it
// readier: it only adds another control round trip and consumes another rate-limit unit. Keep just the most
// recently completed mount for a deliberately much shorter window. This is not a source cache: every URL still
// comes from the current `/sources` answer and carries its own capability, which Reel validates on the media GET.
const COMPLETED_ACTIVATION_GRACE_MS = 5_000;
let completedActivation: { mount: string; direct: Direct; at: number } | null = null;

/**
 * Let one caller stop waiting without aborting the activation another caller has joined.
 *
 * The activation itself has its own bounded lifetime. Tying it to either surface's signal meant a disappearing
 * warm-up could cancel the detail hero's identical request (or vice versa), defeating the coalescing precisely
 * when the two asks overlap.
 */
function waitForActivation(
  pending: Promise<Direct | null>,
  signal: AbortSignal | undefined,
): Promise<Direct | null> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: Direct | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', stopped);
      resolve(answer);
    };
    const stopped = () => finish(null);
    signal.addEventListener('abort', stopped, { once: true });
    void pending.then(finish, () => finish(null));
  });
}

/**
 * Lease Reel's DNS-only direct origin for this browser. The signed media path is the authority. At home den-edge
 * also names the home-network origin (`lanBase`), as it does for a remux session. Null on any failure.
 */
async function activateDirect(
  media: string,
  edgeMount: string,
  reelMount: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  lookup: () => Promise<string | undefined>,
): Promise<Direct | null> {
  if (signal?.aborted || Date.now() < activationPausedUntil) return null;
  const completed = completedActivation;
  if (completed?.mount === reelMount && Date.now() - completed.at < COMPLETED_ACTIVATION_GRACE_MS)
    return permittedDirect(completed.direct, signal);
  const key = `${edgeMount}\n${media}`;
  let pending = activating.get(key);
  if (!pending) {
    pending = performActivation(media, edgeMount, fetchImpl, lookup).then((direct) => {
      if (direct) completedActivation = { mount: reelMount, direct, at: Date.now() };
      return direct;
    });
    activating.set(key, pending);
    const clear = () => {
      if (activating.get(key) === pending) activating.delete(key);
    };
    void pending.then(clear, clear);
  }
  const direct = await waitForActivation(pending, signal);
  return direct ? permittedDirect(direct, signal) : null;
}

/** Apply browser-local authority for every consumer, including consumers of the completed lease. */
async function permittedDirect(
  direct: Direct,
  signal: AbortSignal | undefined,
): Promise<Direct | null> {
  if (signal?.aborted) return null;
  const lan = direct.lan && (await mayUseLocalNetwork()) ? direct.lan : null;
  return signal?.aborted ? null : { public: direct.public, lan };
}

/** The shared work behind `activateDirect`, bounded independently of any one caller. */
async function performActivation(
  media: string,
  mount: string,
  fetchImpl: typeof fetch,
  lookup: () => Promise<string | undefined>,
): Promise<Direct | null> {
  const deadline = AbortSignal.timeout(DIRECT_ACTIVATION_MS);
  const ask = async (ipv4Hint?: string): Promise<Response> => {
    return fetchImpl(`${mount}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media, ...(ipv4Hint ? { ipv4Hint } : {}) }),
      signal: deadline,
    });
  };
  const hintBeforeDeadline = async (): Promise<string | undefined> => {
    const stopped = new Promise<undefined>((resolve) => {
      if (deadline.aborted) resolve(undefined);
      else deadline.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    return Promise.race([lookup(), stopped]);
  };
  try {
    // Once this edge has told the page its connection needs an IPv4 hint, later distinct leases can use
    // ipv4Hint's two-minute memory in their first POST. That avoids a known-to-fail 428 round trip and one
    // activation rate-limit unit without making the address outlive the existing lookup's own policy.
    const rememberedHint = activationNeedsIpv4Hint ? await hintBeforeDeadline() : undefined;
    let response = await ask(rememberedHint);
    if (response.status === 428) {
      const refusal = await response.json().catch(() => null);
      if (refusal?.error !== 'ipv4_hint_wanted') return null;
      activationNeedsIpv4Hint = true;
      // A hinted request receiving the same refusal cannot be improved by repeating it.
      if (rememberedHint) return null;
      const hint = await hintBeforeDeadline();
      if (!hint) return null;
      response = await ask(hint);
    }
    if (!response.ok) {
      pauseActivation(response);
      return null;
    }
    const answer = await response.json();
    const base = bareOrigin(answer?.publicBase);
    if (!base || typeof answer?.media !== 'string') return null;
    if (answer.media !== new URL(media, base).href) return null;
    return { public: base, lan: bareOrigin(answer.lanBase) };
  } catch {
    return null;
  }
}

/**
 * Where each carried source plays from, in the order remux plays a session: the home-network listener where
 * den-edge named one, then the public listener, each given DIRECT_FIRST_FRAME_MS. Then this origin's relay, but
 * only where the page may carry video through it (`relaysMedia`): on the public web name a trailer neither listener
 * can serve is not played at all, as remux plays nothing when neither of its listeners answers. Native and external
 * URLs stay as they are.
 *
 * The home-network copy goes only to a bare `<video>`: an MP4, or a playlist where the element plays HLS itself. The
 * page's policy lets media load from any https origin but names no home-network one for fetching, so hls.js, which
 * fetches its playlist and segments, could not use it; its first copy is the public one.
 */
async function directSources(
  sources: Source[],
  mount: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  lookup: () => Promise<string | undefined>,
  relay: boolean,
  player: Player,
  probe: (media: string) => Promise<boolean>,
): Promise<Source[]> {
  // A page already speaking to Reel directly (LAN/tailnet) should keep doing so. Activation is an
  // edge-owned control route and exists only beside the same-origin `/reel` relay mount.
  const edgeMount = mount.match(/^\/[^/]+/)?.[0];
  if (!edgeMount) return sources;
  const first = sources.map((source) => carriedPath(source.url)).find((path) => path !== null);
  if (!first) return sources;
  const direct = await activateDirect(first, edgeMount, mount, fetchImpl, signal, lookup);
  let lan = direct?.lan && Date.now() >= lanPausedUntil ? direct.lan : null;
  // Keep the listener lease usable for another signed candidate even when this exact route fails its probe. A
  // media error cannot tell an LNA refusal from a candidate-specific 502/decode failure; pausing activation here
  // made one bad file suppress a healthy next candidate on the same at-home listener.
  const offeredLanBase = !!lan;
  const lanPath = sources
    .filter((source) => source.kind === 'mp4' || player === 'native')
    .map((source) => carriedPath(source.url))
    .find((path) => path !== null);
  if (lan && lanPath && !(await proveLanMedia(new URL(lanPath, lan).href, probe, signal)))
    lan = null;
  if (signal?.aborted) return [];
  const result: Source[] = [];
  let includedLan = false;
  for (const source of sources) {
    const path = carriedPath(source.url);
    if (!path) {
      result.push(source);
      continue;
    }
    if (lan && (source.kind === 'mp4' || player === 'native')) {
      result.push({ ...source, url: new URL(path, lan).href, direct: 'lan' });
      includedLan = true;
    }
    if (direct)
      result.push({ ...source, url: new URL(path, direct.public).href, direct: 'public' });
    if (relay) result.push(source);
  }
  // Distinguish a public-listener timeout at home from a dead listener away. A LAN base that passed the permission
  // gate is enough even if this exact route failed its proof: keeping the activation alive is what lets the next
  // candidate prove and use the same at-home listener.
  lanOfferedUntil = includedLan || offeredLanBase ? Date.now() + ACTIVATION_PAUSE_MS : 0;
  return result;
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
    intent,
    playable,
    fetchImpl = relayFetch,
    signal,
    lookupIpv4 = () => ipv4Hint(),
    relay = relaysMedia(),
    probeLocalMedia: probe = probeLocalMedia,
  }: {
    surface: Surface;
    player: Player;
    /**
     * `warm` where this is a guess rather than a decision — a press that may never become a view.
     *
     * The answer is identical either way. What changes is the work reel does behind it: a warm ask
     * starts the resolve, which is the expensive half and the half that helps, and skips building the
     * fallback index and measuring the crop. Without it a press pays roughly forty-five range requests
     * to Google to prepare a rung the master makes unnecessary, for every title merely glanced at.
     */
    intent?: 'warm';
    /** This browser's codec report, which reel filters its variants by. */
    playable?: unknown;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** The browser's public IPv4 lookup, injected by tests and called only after edge asks for it. */
    lookupIpv4?: () => Promise<string | undefined>;
    /** Whether a carried source may play through this origin's relay (`relaysMedia`); tests name it. */
    relay?: boolean;
    /** Browser-owned media proof, injectable only so the route policy can be tested without a real network. */
    probeLocalMedia?: (media: string) => Promise<boolean>;
  },
): Promise<Sources | null> {
  try {
    const url = new URL(sources, globalThis.location?.href ?? 'http://relative.invalid');
    url.searchParams.set('surface', surface);
    url.searchParams.set('player', player);
    // Omitted rather than sent empty when there is no intent, so the surface that plays asks for a
    // URL byte-identical to the one it asked for before this existed. The warm and the play being
    // DIFFERENT URLs is the point: the browser's cache must not answer the hero with the press's
    // reply, because it is the hero's ask that starts the index the fallback needs.
    if (intent) url.searchParams.set('intent', intent);
    // In the query rather than the header: den-edge's relay forwards only the range and conditional
    // headers, so `X-Den-Playable` never crosses it. reel reads both and the header wins where it arrives.
    if (playable) url.searchParams.set('playable', JSON.stringify(playable));
    const asked = /^[a-z][a-z0-9+.-]*:/i.test(sources)
      ? url.toString()
      : `${url.pathname}${url.search}`;
    const res = await fetchImpl(asked, { signal });
    if (!res.ok) return null;
    const body = await res.json();
    return sourcesFrom(body, sources, {
      surface,
      player,
      intent,
      playable,
      fetchImpl,
      signal,
      lookupIpv4,
      relay,
      probeLocalMedia: probe,
    });
  } catch {
    return null;
  }
}

/** Parse and activate a source ladder, whether it arrived from `/sources` or combined `/prepare`. */
async function sourcesFrom(
  body: unknown,
  sources: string,
  {
    player,
    fetchImpl,
    signal,
    lookupIpv4 = () => ipv4Hint(),
    relay = relaysMedia(),
    probeLocalMedia: probe = probeLocalMedia,
  }: SourceAsk & {
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<Sources | null> {
  try {
    const answer = body as { sources?: unknown; crop?: unknown; expires?: unknown };
    if (!Array.isArray(answer?.sources)) return null;
    const url = new URL(sources, globalThis.location?.href ?? 'http://relative.invalid');
    // Where this page can reach reel: the mount it just asked on, minus the `/sources/<id>.json`.
    const mount = `${/^[a-z][a-z0-9+.-]*:/i.test(sources) ? url.origin : ''}${url.pathname.replace(
      /\/sources\/[^/]+$/,
      '',
    )}`;
    const list: Source[] = [];
    for (const entry of answer.sources) {
      // `kind` and `url` are the two that cannot be guessed; anything without both is unusable.
      if (typeof entry?.url !== 'string') continue;
      if (entry.kind !== 'mp4' && entry.kind !== 'hls') continue;
      const at = sourceAt(entry.url, url, mount);
      if (!at) continue;
      // Distinct URLs only. A fallback step that lands on the URL already mounted changes nothing, fires
      // no load and no error, and stops the ladder where it stood — reel dedupes, and so do we.
      if (list.some((had) => had.url === at)) continue;
      list.push({
        kind: entry.kind,
        url: at,
        audio: entry.audio === true,
        height: typeof entry.height === 'number' ? entry.height : null,
        width: typeof entry.width === 'number' ? entry.width : null,
      });
    }
    if (!list.length) return null;
    const activated = await directSources(
      list,
      mount,
      fetchImpl,
      signal,
      lookupIpv4,
      relay,
      player,
      probe,
    );
    if (!activated.length) return null;
    return {
      sources: activated,
      crop: crop(answer.crop),
      expires: typeof answer.expires === 'number' ? answer.expires : undefined,
    };
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
