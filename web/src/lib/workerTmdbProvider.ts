// Worker-private TMDB identity and library-title hydration. Page code receives normalized titles through the
// library/content protocols and never handles provider keys, URLs or retry classification.

import type { MediaType } from './library';
import { readApiKey } from './prefs';
import { retryAfterMs } from './retryAfter';
import { seriesShape, toTitle, type Details } from './tmdb';
import { TMDB_PROXY_KEY, tmdbFetch } from './tmdbCache';
import type { SettingsRow } from './wire';

/** The library's own key, or the sentinel asking den-edge to lend its configured key. */
export function tmdbKeyOf(keys: SettingsRow | undefined): string {
  return readApiKey(keys, 'tmdb') ?? TMDB_PROXY_KEY;
}

export type DetailsResult =
  | { kind: 'found'; details: Details }
  | { kind: 'missing' }
  | { kind: 'retryable'; retryAfterMs?: number };

/** Distinguish a missing title from a relay/provider failure so Worker library hydration retries only the latter. */
export async function fetchDetailsResult(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<DetailsResult> {
  let details: Record<string, unknown>;
  try {
    const append = ref.type === 'tv' ? 'credits,external_ids' : 'credits';
    const url = `https://api.themoviedb.org/3/${ref.type}/${ref.id}?api_key=${encodeURIComponent(key)}&append_to_response=${append}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok)
      return {
        kind: 'retryable',
        ...(res.headers.has('retry-after') ? { retryAfterMs: retryAfterMs(res, 60_000) } : {}),
      };
    details = (await res.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'retryable' };
  }
  const title = toTitle(ref, details);
  // Only den-edge's explicit 404 proves absence. A malformed/partial success may recover and must not become a
  // sticky session-level missing record that permanently skips the title.
  if (!title) return { kind: 'retryable' };
  return {
    kind: 'found',
    details: ref.type === 'tv' ? { title, shape: seriesShape(details) } : { title },
  };
}
