// The library's standing for every title (`standings`), shared with every poster on the page. Set by the open
// library as it changes; a guest's, or a page with no library, marks nothing.

import { titleKey, type Shape, type Standing } from './library';

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

/**
 * The season layouts the open library already holds for its series (`ProfileSession.shapes`), shared with every
 * poster so its year line can say "4 seasons" without a request of its own. A series outside the library, or one
 * not named yet, has none here.
 */
class LibraryShapes {
  #by = $state.raw<ReadonlyMap<string, Shape>>(new Map());

  of(title: { type: string; id: number }): Shape | undefined {
    return title.type === 'tv' ? this.#by.get(titleKey(title)) : undefined;
  }

  set(by: ReadonlyMap<string, Shape>): void {
    this.#by = by;
  }
}

export const libraryShapes = new LibraryShapes();
