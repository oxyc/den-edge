// The name the page on screen gives itself, for the browser tab (`pageTitle` has the rest).
//
// Every kept page is mounted at once, and Svelte ran a child's effect before its parent's (measured in Chromium
// on Svelte 5.57): a page that set `document.title` itself was overwritten by App's name for the address when it
// came back on screen, and a kept page that answered behind another renamed the one on screen. So a page offers
// its name here while it is on screen, and App alone writes the title, from this or from the address.

let shown = $state.raw<string | null>(null);
/**
 * Which page's name `shown` is, so a page leaving the screen clears only its own. Plain, not state: a teardown
 * in the same flush as the next page's effect read the state's earlier value (e2e/tab-title.spec.mjs).
 */
let owner: object | null = null;

/** The name the page on screen has given itself, or null while it has none. */
export function tabName(): string | null {
  return shown;
}

/** For a page's script: while `name()` answers, the tab carries it. `name()` answers null while the page is hidden. */
export function nameTab(name: () => string | null | undefined): void {
  $effect(() => {
    const value = name();
    if (!value) return;
    const entry = {};
    owner = entry;
    shown = value;
    return () => {
      if (owner !== entry) return;
      owner = null;
      shown = null;
    };
  });
}
