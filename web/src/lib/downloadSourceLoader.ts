import type { LibraryModel } from './libraryModel.svelte';
import type {
  DownloadSourceAnswer,
  DownloadSourceFreshAnswer,
  DownloadSourceOption,
  DownloadTitleDescriptor,
} from './libraryServiceProtocol';

export type DownloadSourceLoad = {
  sources: DownloadSourceOption[] | null;
  answer?: DownloadSourceAnswer;
  fresh?: DownloadSourceFreshAnswer;
  failure?: 'not-configured' | 'unmatched' | 'unreachable';
};

/** Normalize the command boundary, including implementations that throw before returning their promise. */
export async function loadDownloadSources(
  model: LibraryModel,
  title: DownloadTitleDescriptor,
  refresh = false,
  signal?: AbortSignal,
): Promise<DownloadSourceLoad | null> {
  try {
    const { result } = await model.downloadSources(title, refresh, refresh, true, signal);
    if (result.kind !== 'download.sources') return null;
    const { kind: _, ...loaded } = result;
    return loaded;
  } catch {
    return null;
  }
}
