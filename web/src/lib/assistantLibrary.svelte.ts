// The member library open in this tab, for the assistant consent dialog, which App draws outside the library's own
// tree. Set by `RoutedLibrary` only for a library this browser is a member of on den-edge (linked, not kept only
// here); a guest's tab and a visitor's leave it null, and the dialog offers them no write. On a household split into
// profiles it is the household's library, and `fetch` proves the household's membership when the dialog approves.

import type { LibraryModel } from './libraryModel.svelte';

export interface AssistantLibraryAuthority {
  model: LibraryModel;
  fetch: typeof fetch | null;
}

class AssistantLibrary {
  /** Exact model + membership proof published atomically, so consent can never mix two households. */
  authority = $state.raw<AssistantLibraryAuthority | null>(null);
}

export const assistantLibrary = new AssistantLibrary();
