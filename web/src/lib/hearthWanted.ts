// Hearth's "look for these" list (den-hearth `/den/<config>/wanted`): the download lease holder hands Hearth the
// wanted rows' ids and search schedule, so the search goes on while no Den client is open, and adopts what Hearth
// started when it is next open. Only what Scout lists a title under goes out — no title, no history, no library key.

import type { Download } from './downloadRows';
import { relayFetch } from './relayFetch';

export interface WantedItem {
  /** The row's content key, which Hearth's answer names the item by. */
  key: string;
  imdb: string;
  season?: number;
  episode?: number;
  airDate?: number;
  tried: string[];
  /** The row's `retries`, and the wall time its `exhausted` was last written: `download_retry`'s inputs. */
  retries: number;
  since: number;
  originalLanguage?: string;
  preferredLanguage?: string;
}

/** One item as Hearth answers it: still `searching`, or `started` on the release `identity` names, at `startedAt`. */
export interface WantedStatus {
  key: string;
  state: 'searching' | 'started';
  identity?: string;
  startedAt?: number;
  retries?: number;
}

/** The wanted and exhausted downloads Scout can be asked for, as Hearth takes them. */
export function wantedItems(downloads: Download[]): WantedItem[] {
  return downloads.flatMap((download): WantedItem[] => {
    const { title } = download;
    if (!download.exhausted || !title.imdbId) return [];
    const since = download.row.values.exhausted?.at[0] ?? download.queuedAt;
    return [
      {
        key: download.content,
        imdb: title.imdbId,
        ...(title.season !== undefined && title.episode !== undefined
          ? { season: title.season, episode: title.episode }
          : {}),
        ...(title.airDate !== undefined ? { airDate: title.airDate } : {}),
        tried: download.tried,
        retries: download.retries,
        since,
        ...(title.originalLanguage ? { originalLanguage: title.originalLanguage } : {}),
        ...(title.preferredLanguage ? { preferredLanguage: title.preferredLanguage } : {}),
      },
    ];
  });
}

/** Replace this install's list at Hearth; each item's state, or null when Hearth didn't answer. */
export async function sendWanted(
  base: string,
  items: WantedItem[],
  fetchImpl: typeof fetch = relayFetch,
): Promise<WantedStatus[] | null> {
  try {
    const response = await fetchImpl(`${base}/wanted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items)
      ? body.items.filter(
          (item): item is WantedStatus =>
            !!item && typeof item.key === 'string' && typeof item.state === 'string',
        )
      : null;
  } catch {
    return null;
  }
}
