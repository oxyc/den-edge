import type { LibraryModel } from './libraryModel.svelte';
import type {
  DownloadSourceAnswer,
  DownloadSourceOption,
  DownloadTitleDescriptor,
} from './libraryServiceProtocol';

export type DownloadSourceLoad = {
  sources: DownloadSourceOption[] | null;
  answer?: DownloadSourceAnswer;
  failure?: 'not-configured' | 'unmatched' | 'unreachable';
};

/** Publishes only the latest visible title request; service queries are not transport-abortable. */
export class DownloadSourceLoader {
  #generation = 0;

  cancel(): void {
    this.#generation++;
  }

  async load(
    model: LibraryModel,
    title: DownloadTitleDescriptor,
    refresh = false,
  ): Promise<DownloadSourceLoad | null | undefined> {
    const generation = ++this.#generation;
    try {
      const { result } = await model.downloadSources(title, refresh);
      if (generation !== this.#generation) return undefined;
      return result.kind === 'download.sources'
        ? {
            sources: result.sources,
            ...(result.answer ? { answer: result.answer } : {}),
            ...(result.failure ? { failure: result.failure } : {}),
          }
        : null;
    } catch {
      return generation === this.#generation ? null : undefined;
    }
  }
}
