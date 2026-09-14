// Which of the page's rows are open, in one place, so a row, its section's "Expand all" and the page's can each open
// and close them. Kept while the app runs: going back to Settings finds the rows as they were left.

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

class Rows {
  /** The open rows, by id. */
  readonly open = new SvelteSet<string>();
  /** Every row on the page that opens, and the section it's in. */
  readonly expandable = new SvelteMap<string, string>();

  /** The rows that open, in one section or on the whole page. */
  private ids(section?: string): string[] {
    return [...this.expandable].flatMap(([id, in_]) => (!section || in_ === section ? [id] : []));
  }

  /** Whether there's anything to open, in the section or on the page. */
  any(section?: string): boolean {
    return this.ids(section).length > 0;
  }

  /** Whether every row that opens is open, in the section or on the page. */
  allOpen(section?: string): boolean {
    const ids = this.ids(section);
    return ids.length > 0 && ids.every((id) => this.open.has(id));
  }

  setAll(open: boolean, section?: string): void {
    for (const id of this.ids(section)) {
      if (open) this.open.add(id);
      else this.open.delete(id);
    }
  }

  toggle(id: string): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
  }
}

export const rows = new Rows();

/** The context key a section gives its rows its id under. */
export const SECTION = Symbol('settings-section');
