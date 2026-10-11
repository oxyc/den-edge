// The member library open in this tab, for the assistant consent dialog, which App draws outside the library's own
// tree. Set by `RoutedLibrary` only for a library this browser is a member of on den-edge (linked, not kept only
// here); a guest's tab and a visitor's leave it null, and the dialog offers them no write.

import type { LibraryModel } from './libraryModel.svelte';

export const assistantLibrary = $state<{ model: LibraryModel | null }>({ model: null });
