// The library's standing for every title (`standings`), shared with every poster on the page. Set by the open
// library as it changes; a guest's, or a page with no library, marks nothing.

import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { titleKey, type Shape, type Standing } from './library';

/**
 * Per title: a poster reads only its own title's entry, and a change to the library touches only the entries that
 * changed, so marking one title watched re-derives one card rather than every card on the page.
 */
class LibraryStandings {
  readonly #by = new SvelteMap<string, Standing>();

  of(title: { type: string; id: number }): Standing | undefined {
    return this.#by.get(titleKey(title));
  }

  set(by: ReadonlyMap<string, Standing>): void {
    // Read untracked: the effect that hands the map over must not come to depend on every title it wrote.
    untrack(() => {
      for (const key of this.#by.keys()) if (!by.has(key)) this.#by.delete(key);
      for (const [key, standing] of by)
        if (this.#by.get(key) !== standing) this.#by.set(key, standing);
    });
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
