import { SvelteMap } from 'svelte/reactivity';
import type { Episode } from './detail';
import { futureDate } from './detailPresentation';
import { downloads } from './downloadQueue.svelte';
import { fetchSources } from './titleSources';
import type { Addon } from './scout';
import type { Routes } from './routes';

interface SeasonJob { total: number; checked: number; queued: number; ready: number; unavailable: number; uncertain: number; running: boolean }
export const seasonJobs = new SvelteMap<string, SeasonJob>();
export const seasonJobKey = (addon: Addon, imdb: string, season: number) => `${addon.install}:${imdb}:${season}`;

/** The queue owns this pass, not the page. Leaving a detail must not stop halfway through a season. */
export async function downloadSeason(addon: Addon, imdb: string, season: number, episodes: Episode[], routes: Routes,
  resolve = fetchSources, queue = downloads): Promise<void> {
  const key = seasonJobKey(addon, imdb, season);
  if (seasonJobs.get(key)?.running) return;
  const aired = episodes.filter((e) => !futureDate(e.airDate));
  let job: SeasonJob = { total: aired.length, checked: 0, queued: 0, ready: 0, unavailable: 0, uncertain: 0, running: true };
  seasonJobs.set(key, job);
  try {
    for (const episode of aired) {
      const sources = await resolve(addon, imdb, routes, season, episode.number);
      if (sources === null) job = { ...job, uncertain: job.uncertain + 1 };
      else {
        const source = sources.find((s) => s.cached === true) ?? sources.find((s) => s.seeders !== 0);
        if (!source) job = { ...job, unavailable: job.unavailable + 1 };
        else {
          const result = await queue.start(`${addon.install}:${imdb}:${season}:${episode.number}:${source.filename}`, source);
          if (result.state === 'ready') job = { ...job, ready: job.ready + 1 };
          else if (result.state === 'preparing') job = { ...job, queued: job.queued + 1 };
          else if (result.state === 'unknown') job = { ...job, uncertain: job.uncertain + 1 };
          else job = { ...job, unavailable: job.unavailable + 1 };
        }
      }
      job = { ...job, checked: job.checked + 1 }; seasonJobs.set(key, job);
    }
  } finally { seasonJobs.set(key, { ...job, running: false }); }
  for (const [old, value] of seasonJobs) { if (seasonJobs.size <= 20) break; if (!value.running) seasonJobs.delete(old); }
}
