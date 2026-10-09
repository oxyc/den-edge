import type { Episode } from './detail';
import type { DownloadTitle } from './downloadRows';

export type SeasonLoader = (seriesId: number, season: number) => Promise<Episode[] | null>;

/** A failed legacy-artwork recovery may be retried after a quiet period, but a card remount cannot bypass it. */
export const DOWNLOAD_STILL_RETRY_MS = 30_000;
/** Old shared rows are rare; bound their visit-local recovery state even in a library with years of downloads. */
const MOST_RECOVERED = 256;

interface RecoveredStill {
  still?: string;
  flight?: Promise<string | undefined>;
  retryAt?: number;
}

/**
 * Windowed cards mount and unmount as they cross the horizontal viewport. Keep the semantic episode lookup outside
 * that lifecycle so remounts join one producer, retain its answer, and cannot turn a temporary failure into a burst.
 * A WeakMap keeps injected loaders isolated in tests and lets their caches go with them.
 */
const recoveredByLoader = new WeakMap<SeasonLoader, Map<string, RecoveredStill>>();

function recovered(loadSeason: SeasonLoader): Map<string, RecoveredStill> {
  let cache = recoveredByLoader.get(loadSeason);
  if (!cache) {
    cache = new Map();
    recoveredByLoader.set(loadSeason, cache);
  }
  return cache;
}

function recent(cache: Map<string, RecoveredStill>, key: string, entry: RecoveredStill): void {
  cache.delete(key);
  cache.set(key, entry);
}

function trim(cache: Map<string, RecoveredStill>): void {
  while (cache.size > MOST_RECOVERED) {
    const settled = [...cache].find(([, entry]) => !entry.flight)?.[0];
    // A short burst may temporarily exceed the cap rather than orphaning an in-flight producer. Settlement trims it.
    if (settled === undefined) return;
    cache.delete(settled);
  }
}

/**
 * Recover artwork for shared rows written before downloads carried `stillPath`.
 *
 * The row still identifies the exact episode, so using its series poster is unnecessary: TMDB's season answer has
 * the same still the episode card already shows. The Worker content authority coalesces this semantic season lookup.
 */
export async function downloadStill(
  title: DownloadTitle,
  loadSeason: SeasonLoader,
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (title.stillPath) return title.stillPath;
  if (title.mediaType !== 'tv' || title.season === undefined || title.episode === undefined)
    return undefined;
  const { mediaId, season, episode } = title;
  const key = `${mediaId}:${season}:${episode}`;
  const cache = recovered(loadSeason);
  const held = cache.get(key);
  if (held) {
    recent(cache, key, held);
    if (held.still) return held.still;
    if (held.flight) return held.flight;
    if (held.retryAt && now() < held.retryAt) return undefined;
    cache.delete(key);
  }

  const entry: RecoveredStill = {};
  const flight = Promise.resolve()
    .then(() => loadSeason(mediaId, season))
    .then(
      (episodes) => {
        const still = episodes?.find((candidate) => candidate.number === episode)?.stillPath;
        entry.flight = undefined;
        if (still) entry.still = still;
        else entry.retryAt = now() + DOWNLOAD_STILL_RETRY_MS;
        recent(cache, key, entry);
        trim(cache);
        return still;
      },
      (error: unknown) => {
        entry.flight = undefined;
        entry.retryAt = now() + DOWNLOAD_STILL_RETRY_MS;
        recent(cache, key, entry);
        trim(cache);
        throw error;
      },
    );
  entry.flight = flight;
  cache.set(key, entry);
  trim(cache);
  return flight;
}
