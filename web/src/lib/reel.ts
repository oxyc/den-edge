// den-reel's trailers: the plain MP4 the TV plays behind its hero, rather than YouTube's embed with its own
// furniture, its own autoplay rules and its own error card.
//
// The lookup is JSON, so it goes through this origin like the other addons' (den-edge relays `/reel` to the
// addon's LAN address, as it does `/scout` and `/atlas`). The video does not: that relay carries JSON only. reel
// names its own play URLs by whatever address it was asked at — the LAN one, through the relay — so the origin
// is swapped for one of reel's addresses this page can actually reach. What the signature covers is the video
// and the install that asked for it, not the host, so it survives the swap.

import type { MediaType } from './library';
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

/** Ordered, distinct candidates. A removed or portrait first video must not hide every other trailer. */
export async function trailerURLs(
  base: string,
  type: MediaType,
  imdbId: string,
  routes: Routes,
  {
    fetchImpl = fetch,
    secure = globalThis.location?.protocol !== 'http:',
    signal,
  }: {
    fetchImpl?: typeof fetch;
    secure?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  const origin = reachable(routes.reel ?? [], secure);
  if (!origin) return [];
  try {
    const res = await fetchImpl(
      `${base}/meta/${type === 'tv' ? 'series' : 'movie'}/${encodeURIComponent(imdbId)}.json`,
      { signal, cache: 'no-cache' },
    );
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

/** Browse billboards use the first candidate; detail playback can advance through the full list. */
export async function trailerURL(
  base: string,
  type: MediaType,
  imdbId: string,
  routes: Routes,
  options: { fetchImpl?: typeof fetch; secure?: boolean; signal?: AbortSignal } = {},
): Promise<string | null> {
  return (await trailerURLs(base, type, imdbId, routes, options))[0] ?? null;
}
