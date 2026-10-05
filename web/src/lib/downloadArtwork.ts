import { fetchSeason, type Episode } from './detail';
import type { DownloadTitle } from './downloadRows';
import { TMDB_PROXY_KEY } from './tmdbCache';

type SeasonLoader = (seriesId: number, season: number, key: string) => Promise<Episode[] | null>;

/**
 * Recover artwork for shared rows written before downloads carried `stillPath`.
 *
 * The row still identifies the exact episode, so using its series poster is unnecessary: TMDB's season answer has
 * the same still the episode card already shows. `fetchSeason` is cached and coalesced by `tmdbCache`, making this
 * cheap when several downloads from one season appear together.
 */
export async function downloadStill(
  title: DownloadTitle,
  loadSeason: SeasonLoader = fetchSeason,
): Promise<string | undefined> {
  if (title.stillPath) return title.stillPath;
  if (title.mediaType !== 'tv' || title.season === undefined || title.episode === undefined)
    return undefined;
  const episodes = await loadSeason(title.mediaId, title.season, TMDB_PROXY_KEY);
  return episodes?.find((episode) => episode.number === title.episode)?.stillPath;
}
