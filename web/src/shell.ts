// The navigation bar as HTML, for `scripts/shell.mjs` to write into the built index.html: the page then paints
// the bar from HTML and CSS alone, before the app's JavaScript has arrived, and `main.ts` swaps in the live one.
// It is the component itself rendered on the server, not a copy of its markup, so it can't drift from it.
//
// Home's bar serves every page. The only part that differs by page is the Back button, which takes no space on a
// phone and sits in space left free on a wide screen, so it appearing when the app starts moves nothing else.

import { render } from 'svelte/server';
import NavigationBar from './components/NavigationBar.svelte';

export const shell = (): string =>
  render(NavigationBar, { props: { route: { page: 'library' } } }).body;
