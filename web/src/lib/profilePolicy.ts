import type { LibraryModel, LibraryModelSnapshot } from './libraryModel.svelte';
import type { SettingsView } from './libraryServiceProtocol';

/** The complete household surface a profile may use while filtering content. */
export interface ProfilePolicy {
  readonly settings: LibraryModelSnapshot<SettingsView>;
}

/**
 * Project the household model onto policy only. The model stays in this closure: consumers cannot reach Owner
 * activity, commands, tracker delivery, or Settings writers through the returned frozen facade.
 */
export function profilePolicy(model: LibraryModel | null): ProfilePolicy | null {
  if (!model) return null;
  return Object.freeze({
    get settings() {
      return model.settings;
    },
  });
}
