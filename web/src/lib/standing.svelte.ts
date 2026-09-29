// The library's standing for every title (`standings`), shared with every poster on the page. Set by the open
// library as it changes; a guest's, or a page with no library, marks nothing.

import { titleKey, type Standing } from './library';

class LibraryStandings {
  #by = $state.raw(new Map<string, Standing>());

  of(title: { type: string; id: number }): Standing | undefined {
    return this.#by.get(titleKey(title));
  }

  set(by: Map<string, Standing>): void {
    this.#by = by;
  }
}

export const libraryStandings = new LibraryStandings();
