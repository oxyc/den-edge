import type { LibraryModel } from './libraryModel.svelte';

/** True only for the non-retryable wire fence produced by den-edge's HTTP 426 response. */
export function libraryUpdateRequired(model: LibraryModel | null): boolean {
  const status = model?.status;
  return (
    status?.kind === 'failed' &&
    status.error.code === 'update-required' &&
    status.error.retryable === false
  );
}
