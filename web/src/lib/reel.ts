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
function reachable(entries: Entry[], secure = globalThis.location?.protocol !== 'http:'): string | null {
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    return entry.url.replace(/\/$/, '');
  }
  return null;
}

/** What reel answers with: its best trailer first, each as a direct MP4. */
function firstTrailer(body: unknown): string | null {
  const links = (body as { meta?: { links?: unknown } } | null)?.meta?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links as { trailers?: unknown }[]) {
    if (typeof link?.trailers === 'string' && link.trailers) return link.trailers;
  }
  return null;
}

/**
 * The MP4 of `imdbId`'s trailer, ready to play, or null when reel has none or none of its addresses can be
 * reached from here. `base` is where this page asks reel (`/reel/<config>`, from `findAddon`).
 */
export async function trailerURL(
  base: string,
  type: MediaType,
  imdbId: string,
  routes: Routes,
  {
    fetchImpl = fetch,
    secure = globalThis.location?.protocol !== 'http:',
  }: { fetchImpl?: typeof fetch; secure?: boolean } = {},
): Promise<string | null> {
  const origin = reachable(routes.reel ?? [], secure);
  if (!origin) return null;
  const stremio = type === 'tv' ? 'series' : 'movie';
  try {
    const res = await fetchImpl(`${base}/meta/${stremio}/${encodeURIComponent(imdbId)}.json`);
    if (!res.ok) return null;
    const found = firstTrailer(await res.json());
    if (!found) return null;
    const link = new URL(found);
    return `${origin}${link.pathname}${link.search}`;
  } catch {
    // Out of reach, or an answer that isn't reel's: the slide keeps its still picture.
    return null;
  }
}
