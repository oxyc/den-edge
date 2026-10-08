import type { Episode } from './detail';
import { futureDate } from './detailPresentation';
import type { LibraryModel } from './libraryModel.svelte';
import type { DownloadTitleDescriptor } from './libraryServiceProtocol';

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
): Promise<EpisodeDownloadResult> {
  const requested = descriptor(imdb, season, episode, title);
  const { result } = await model.downloadReleases(requested);
  if (result.kind !== 'download.releases' || result.releases === null) return 'uncertain';
  const release = result.releases[0];
  if (!release) return 'unavailable';
  if (release.cached) return 'ready';
  await model.enqueueDownload(requested, release, result.releases.length);
  return 'queued';
}

export function downloadEpisode(
  model: LibraryModel,
  imdb: string,
  season: number,
  episode: Episode,
  title: SeasonTitle,
): Promise<EpisodeDownloadResult>;
/** Temporary Detail call shape; final integration must supply LibraryModel. */
export function downloadEpisode(
  _legacyAddon: unknown,
  imdb: string,
  season: number,
  episode: Episode,
  _legacyRoutes: unknown,
  title: SeasonTitle,
): Promise<EpisodeDownloadResult>;
export function downloadEpisode(
  first: LibraryModel | unknown,
  imdb: string,
  season: number,
  episode: Episode,
  fifth: SeasonTitle | unknown,
  _sixth?: SeasonTitle,
): Promise<EpisodeDownloadResult> {
  if (!first || typeof first !== 'object' || !('downloadReleases' in first))
    return Promise.resolve('uncertain');
  return downloadEpisodeWithModel(
    first as LibraryModel,
    imdb,
    season,
    episode,
    fifth as SeasonTitle,
  );
}

/** A small presentation coordinator; durable episode work remains owned by LibraryService. */
export async function downloadSeason(
  model: LibraryModel,
  imdb: string,
  season: number,
  episodes: Episode[],
  title: SeasonTitle,
  changed: (job: SeasonJob) => void,
): Promise<void> {
  const aired = episodes.filter((episode) => !futureDate(episode.airDate));
  let job: SeasonJob = {
    total: aired.length,
    checked: 0,
    queued: 0,
    ready: 0,
    unavailable: 0,
    uncertain: 0,
    running: true,
  };
  changed(job);
  for (const episode of aired) {
    const result = await downloadEpisodeWithModel(model, imdb, season, episode, title);
    job = { ...job, checked: job.checked + 1, [result]: job[result] + 1 };
    changed(job);
  }
  changed({ ...job, running: false });
}
