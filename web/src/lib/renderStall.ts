/** What an app that has finished starting up has drawn: a library route's active `RoutePage`, or a top-level
 *  screen that stands in for one — the pairing screen (`LinkTV.svelte`) and a screen that failed to load with its
 *  retry (`ScreenLoading.svelte`). Those two mark themselves `data-startup-outcome`. A bare loading spinner is
 *  deliberately none of them: a page still on it has not rendered. */
const RENDERED = '[data-route-page][data-active="true"], [data-startup-outcome]';

export const hasRendered = (root: Pick<ParentNode, 'querySelector'>): boolean =>
  root.querySelector(RENDERED) !== null;
