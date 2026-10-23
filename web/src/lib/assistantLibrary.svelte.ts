// The member library open in this tab, for the assistant consent dialog, which App draws outside the library's own
// tree. Set by `RoutedLibrary` only for a library this browser is a member of on den-edge (linked, not kept only
// here); a guest's tab and a visitor's leave it null, and the dialog offers them no write. On a household split into
// profiles it is the household's library, and `fetch` proves the household's membership when the dialog approves.

import type { LibraryModel } from './libraryModel.svelte';

class AssistantLibrary {
  model = $state.raw<LibraryModel | null>(null);
  fetch = $state.raw<typeof fetch | null>(null);
}

export const assistantLibrary = new AssistantLibrary();
