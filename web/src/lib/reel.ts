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
  const asked = metaURL(base, type, ids, prewarm);
  if (!asked) return [];
  try {
    const res = await fetchImpl(asked, { signal, cache: 'no-cache' });
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
    return urls;
  } catch {
    return [];
  }
}

/** What `/direct` answers with: YouTube's own URLs, so a trailer plays without reel fetching it first. */
export type DirectTrailer = {
  /** Video-only whenever YouTube answers adaptively, which is now always. Silent on its own. */
  video: string;
  /** The separate audio track. A `<video>` element cannot combine it with the stream above. */
  audio: string | null;
  /** The HLS master: video, audio and subtitles in one URL, and the only one that carries sound. */
  hls: string | null;
  width: number | null;
  height: number | null;
};

/**
 * The `/direct/<id>.json` sibling of a `/play/<id>.mp4` URL, query and all.
 *
 * Derived from the play URL rather than asked for separately, because the signature reel demands is
 * over the video and the install — not the path — so the tag `/meta` already handed us is the tag
 * `/direct` wants. That also keeps the whole thing to one `/meta` round-trip.
 */
export function directURL(playURL: string): string | null {
  return sibling(playURL, 'direct', 'json');
}

/**
 * The `/hls/<id>.m3u8` sibling of a play URL: reel's proxy for YouTube's own HLS master.
 *
 * What a browser without native HLS needs, and the only way it can have it. googlevideo answers
 * MSE's segment fetches with no CORS header, so hls.js cannot read Google's master directly however
 * willing it is; reel fetches it and rewrites every URI in it to come back through reel.
 */
export function hlsURL(playURL: string): string | null {
  return sibling(playURL, 'hls', 'm3u8');
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

/**
 * Does this browser play HLS from a bare `<video>`? WebKit does, which is every browser on iOS.
 *
 * Everywhere else it would take hls.js, and that cannot work here however willing it is: googlevideo
 * answers with no `Access-Control-Allow-Origin`, so MSE — which fetches its segments through XHR —
 * is refused. A plain media load is not subject to that, which is the whole reason this split exists.
 */
export function nativeHls(
  probe = () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
): boolean {
  try {
    return probe() !== '';
  } catch {
    return false;
  }
}

/**
 * The fastest source this browser can play, or null to stay on reel's own `/play`.
 *
 * `wantsSound` is what decides the silent stream's fate. Behind a billboard, where the video is muted
 * and unpressable, video-only is exactly right and costs reel nothing. Anywhere a viewer can turn the
 * sound up it would be a trap — it plays perfectly and is simply silent, with nothing to say so.
 */
export function directSource(direct: DirectTrailer | null, hlsOk = nativeHls()): string | null {
  if (!direct) return null;
  // HLS or nothing at all. The silent video-only stream looked like the cheap option and is the
  // opposite: one open-ended range is throttled hard, so it drags a 32 MB 1080p file to a first
  // frame in about 5.4s, where HLS opens on a low variant and climbs — 1.7s on the same trailer,
  // same device. It also fails outright in some browsers. Reel's own copy beats it everywhere.
  return direct.hls && hlsOk ? direct.hls : null;
}

/**
 * The best source for one candidate where the page can drive an HLS player itself, or null to stay
 * on reel's own `/play`.
 *
 * Both branches play the SAME stream — YouTube's adaptive master, opening on a low variant and
 * climbing — so a cold trailer shows a picture in a second or two instead of after a whole file is
 * downloaded and remuxed. What differs is who fetches it: a browser with native HLS takes Google's
 * URL and the homelab carries nothing at all, and everything else takes reel's proxy of that master,
 * because googlevideo answers MSE's segment fetches with no CORS header and hls.js cannot read a
 * byte of them otherwise.
 *
 * Null when the resolve found no master, which is the one case `/play` is still the answer to.
 */
export function trailerSource(
  playURL: string,
  direct: DirectTrailer | null,
  hlsOk = nativeHls(),
): string | null {
  if (!direct?.hls) return null;
  return hlsOk ? direct.hls : hlsURL(playURL);
}

/**
 * Ask reel for the trailer's own URLs.
 *
 * Null on anything unexpected — an older reel with no such route, a refusal, a malformed answer —
 * and every caller still holds the `/play` URL it was going to use.
 */
export async function directTrailer(
  playURL: string,
  { fetchImpl = relayFetch, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DirectTrailer | null> {
  const ask = directURL(playURL);
  if (!ask) return null;
  try {
    const res = await fetchImpl(ask, { signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.video !== 'string') return null;
    // https only: the page is served over it, so anything else is blocked as mixed content anyway.
    const https = (v: unknown) => {
      if (typeof v !== 'string') return null;
      try {
        return new URL(v).protocol === 'https:' ? v : null;
      } catch {
        return null;
      }
    };
    if (!https(body.video)) return null;
    const size = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      video: body.video,
      audio: https(body.audio),
      hls: https(body.hls),
      width: size(body.width),
      height: size(body.height),
    };
  } catch {
    return null;
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
