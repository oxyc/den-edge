import type { LibraryModel } from './libraryModel.svelte';

/** Highest library wire this client can open; wire 4 remains the default for unsplit libraries. */
export const MAX_SUPPORTED_LIBRARY_WIRE = 5;

/** True only for a non-retryable wire fence this build genuinely cannot open. */
export function libraryUpdateRequired(model: LibraryModel | null): boolean {
  const status = model?.status;
  return (
    status?.kind === 'failed' &&
    status.error.code === 'update-required' &&
    status.error.retryable === false &&
    (status.error.requiredWire === undefined ||
      status.error.requiredWire > MAX_SUPPORTED_LIBRARY_WIRE)
  );
}
