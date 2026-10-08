import type { Episode } from './detail';
import { futureDate } from './detailPresentation';
import type { LibraryModel } from './libraryModel.svelte';
import type { DownloadTitleDescriptor } from './libraryServiceProtocol';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export interface SeasonJob {
  total: number;
  checked: number;
  queued: number;
  ready: number;
  unavailable: number;
  uncertain: number;
  running: boolean;
}

export interface SeasonTitle {
  type: 'movie' | 'tv';
  id: number;
  title: string;
  posterPath?: string;
  originalLanguage?: string;
}

export type EpisodeDownloadResult = 'queued' | 'ready' | 'unavailable' | 'uncertain';

interface SharedSeasonRun {
  latest: SeasonJob;
  listeners: Set<(job: SeasonJob) => void>;
  promise: Promise<void>;
}

const seasonRuns = new WeakMap<LibraryModel, SvelteMap<string, SharedSeasonRun>>();

const descriptor = (
  imdb: string,
  season: number,
  episode: Episode,
  title: SeasonTitle,
): DownloadTitleDescriptor => ({
  target: { type: 'tv', id: title.id, season, episode: episode.number },
  name: title.title,
  imdbId: imdb,
  ...(title.posterPath ? { posterPath: title.posterPath } : {}),
  ...(episode.stillPath ? { stillPath: episode.stillPath } : {}),
  ...(title.originalLanguage ? { originalLanguage: title.originalLanguage } : {}),
});

async function downloadEpisodeWithModel(
  model: LibraryModel,
  imdb: string,
  season: number,
  episode: Episode,
  title: SeasonTitle,
  existing?: ReturnType<LibraryModel['downloads']>,
): Promise<EpisodeDownloadResult> {
  const requested = descriptor(imdb, season, episode, title);
  const queued = existing?.snapshot.value?.items.find(
    (item) =>
      item.title.type === 'tv' &&
      item.title.id === title.id &&
      item.season === season &&
      item.episode === episode.number,
  );
  if (queued) return queued.status.state === 'ready' ? 'ready' : 'queued';
  const { result } = await model.downloadSources(requested);
  if (result.kind !== 'download.sources' || result.sources === null) return 'uncertain';
  const release = result.sources[0];
  if (!release) return 'unavailable';
  if (release.cached) return 'ready';
  await model.enqueueDownload(requested, release, result.sources.length);
  return 'queued';
}

export async function downloadEpisode(
  model: LibraryModel,
  imdb: string,
  season: number,
  episode: Episode,
  title: SeasonTitle,
): Promise<EpisodeDownloadResult> {
  const lease = model.downloads();
  try {
    return await downloadEpisodeWithModel(model, imdb, season, episode, title, lease);
  } finally {
    lease.release();
  }
}

const seasonKey = (
  imdb: string,
  season: number,
  episodes: readonly Episode[],
  title: SeasonTitle,
) => `${title.id}:${imdb}:${season}:${episodes.map(({ number }) => number).join(',')}`;

/** A small presentation coordinator; durable episode work remains owned by LibraryService. */
export async function downloadSeason(
  model: LibraryModel,
  imdb: string,
  season: number,
  episodes: Episode[],
  title: SeasonTitle,
  changed: (job: SeasonJob) => void,
  signal?: AbortSignal,
): Promise<void> {
  const aired = episodes.filter((episode) => !futureDate(episode.airDate));
  const key = seasonKey(imdb, season, aired, title);
  let runs = seasonRuns.get(model);
  if (!runs) {
    runs = new SvelteMap();
    seasonRuns.set(model, runs);
  }
  let run = runs.get(key);
  if (!run) {
    const shared: SharedSeasonRun = {
      latest: {
        total: aired.length,
        checked: 0,
        queued: 0,
        ready: 0,
        unavailable: 0,
        uncertain: 0,
        running: true,
      },
      listeners: new SvelteSet(),
      promise: Promise.resolve(),
    };
    const publish = (next: SeasonJob) => {
      shared.latest = next;
      for (const listener of shared.listeners) listener(next);
    };
    runs.set(key, shared);
    run = shared;
    shared.promise = (async () => {
      let lease: ReturnType<LibraryModel['downloads']> | undefined;
      try {
        lease = model.downloads();
        for (const episode of aired) {
          let result: EpisodeDownloadResult = 'uncertain';
          try {
            result = await downloadEpisodeWithModel(model, imdb, season, episode, title, lease);
          } catch {
            // One provider or enqueue failure must not strand the season or suppress the remaining episodes.
          }
          publish({
            ...shared.latest,
            checked: shared.latest.checked + 1,
            [result]: shared.latest[result] + 1,
          });
        }
      } catch {
        const left = shared.latest.total - shared.latest.checked;
        publish({
          ...shared.latest,
          checked: shared.latest.total,
          uncertain: shared.latest.uncertain + left,
        });
      } finally {
        lease?.release();
        publish({ ...shared.latest, running: false });
        if (runs?.get(key) === shared) runs.delete(key);
      }
    })();
  }
  if (!signal?.aborted) {
    run.listeners.add(changed);
    changed(run.latest);
  }
  const cancel = () => run?.listeners.delete(changed);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await run.promise;
  } finally {
    cancel();
    signal?.removeEventListener('abort', cancel);
  }
}
