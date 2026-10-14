/**
 * Whether a reactivated page's `content-visibility: auto` rows wait to be `placed` (see `.row-window`). The wait works
 * around WebKit judging relevance at a retained page's pre-restore scroll position. Chromium does not have that bug,
 * and its renderer crashes when the viewport resizes in the frame in which a row switches `content-visibility` on
 * (e2e/actor-history), so there rows are placed from the start and the property never switches.
 *
 * Chromium is told apart by `webkitRequestFileSystem`, which only it defines and which, unlike
 * `navigator.userAgentData`, is also there on an insecure (plain-http LAN) origin. If it goes away, Chromium simply
 * takes the gated path again.
 */
export const gatesPlacement =
  typeof window === 'undefined' || !('webkitRequestFileSystem' in window);
