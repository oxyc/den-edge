import { SvelteMap } from 'svelte/reactivity';
import type { Episode } from './detail';
import { futureDate } from './detailPresentation';
import { downloads, inFlight } from './downloadQueue.svelte';
import { ensureSyncPolicy } from './syncLoader';
import { fetchSourceList } from './titleSources';
import type { Addon } from './scout';
import type { Routes } from './routes';

interface SeasonJob {
  total: number;
  checked: number;
  queued: number;
  ready: number;
  unavailable: number;
  uncertain: number;
  running: boolean;
}
export const seasonJobs = new SvelteMap<string, SeasonJob>();
export const seasonJobKey = (addon: Addon, imdb: string, season: number) =>
  `${addon.install}:${imdb}:${season}`;

/** The series a season pass downloads episodes of, as each episode's download is written down. */
export interface SeasonTitle {
  type: 'movie' | 'tv';
  id: number;
  title: string;
  posterPath?: string;
  originalLanguage?: string;
}

/**
 * The queue owns this pass, not the page. Leaving a detail must not stop halfway through a season. One library row
 * per episode, each started with the TV's own pick (`rank_releases`), so a season queued here is the one the TV
 * would have queued, and shows on its shelf.
 */
export async function downloadSeason(
  addon: Addon,
  imdb: string,
  season: number,
  episodes: Episode[],
  routes: Routes,
  title: SeasonTitle,
  resolve = fetchSourceList,
  queue = downloads,
): Promise<void> {
  // Each episode's release is den-core's pick.
  await ensureSyncPolicy();
  const key = seasonJobKey(addon, imdb, season);
  if (seasonJobs.get(key)?.running) return;
  const aired = episodes.filter((e) => !futureDate(e.airDate));
  let job: SeasonJob = {
    total: aired.length,
    checked: 0,
    queued: 0,
    ready: 0,
    unavailable: 0,
    uncertain: 0,
    running: true,
  };
  seasonJobs.set(key, job);
  try {
    for (const episode of aired) {
      const current = queue.of(title.type, title.id, season, episode.number);
      // Already fetching: asking again is a fresh add at the debrid, not a status check.
      if (current && inFlight(queue.status(current).state)) {
        job = { ...job, queued: job.queued + 1, checked: job.checked + 1 };
        seasonJobs.set(key, job);
        continue;
      }
      const { sources } = await resolve(addon, imdb, routes, season, episode.number);
      if (sources === null) job = { ...job, uncertain: job.uncertain + 1 };
      else {
        const source = queue.pick(sources, title.originalLanguage);
        if (!source || (source.cached === false && source.seeders === 0))
          job = { ...job, unavailable: job.unavailable + 1 };
        else if (source.cached === true) job = { ...job, ready: job.ready + 1 };
        else {
          const result = await queue.start({
            title: {
              mediaType: title.type,
              mediaId: title.id,
              imdbId: imdb,
              season,
              episode: episode.number,
              title: title.title,
              posterPath: title.posterPath,
              stillPath: episode.stillPath,
              originalLanguage: title.originalLanguage,
            },
            source,
            sources,
          });
          if (result.state === 'ready') job = { ...job, ready: job.ready + 1 };
          else if (result.state === 'preparing' || result.state === 'paused')
            job = { ...job, queued: job.queued + 1 };
          else if (result.state === 'unknown' || result.state === 'not-queued')
            job = { ...job, uncertain: job.uncertain + 1 };
          else job = { ...job, unavailable: job.unavailable + 1 };
        }
      }
      job = { ...job, checked: job.checked + 1 };
      seasonJobs.set(key, job);
    }
  } finally {
    seasonJobs.set(key, { ...job, running: false });
  }
  for (const [old, value] of seasonJobs) {
    if (seasonJobs.size <= 20) break;
    if (!value.running) seasonJobs.delete(old);
  }
}
