// A newer release than the one this page runs: the service worker kept it (`den:release`, public/sw.js), or a file
// of this release is gone from den-edge. The page moves onto it at a moment that interrupts nothing — the next page
// opened, or while hidden if nothing on screen would be lost — never at once: reloading as soon as the release was
// found threw a person browsing Home back to the top of a fresh page right after a deploy.
//
// A chunk failing to load right now (`recoverChunkFailure`, below) is a different signal from the rest of this
// file: it says the page the person is ALREADY ON is missing something this instant — a row, a dialog, a screen
// not behind `ScreenLoading` — not that a newer release merely exists somewhere. Waiting for the next navigation
// would leave that gap on screen for the rest of the visit, so it reloads at once whenever nothing would be lost,
// and only falls back to the deferred swap when it would.

let waiting = false;

/** A newer release is kept; the page moves onto it at the next chance it gets. */
export function releaseWaiting(): void {
  waiting = true;
}

/**
 * Open `path` as a whole page load rather than drawing it in place, when a release is waiting: the shell the worker
 * keeps is the new one, so the page that loads runs it. `null` is a traversal, whose address is already the page's.
 */
export function swapOnNavigation(
  path: string | null,
  place: Pick<Location, 'assign' | 'reload'> = location,
): boolean {
  if (!waiting) return false;
  if (path === null) place.reload();
  else place.assign(path);
  return true;
}

interface Page {
  scrollX: number;
  scrollY: number;
  document: Pick<Document, 'activeElement' | 'querySelectorAll'>;
  location: Pick<Location, 'reload'>;
}

/** Whether reloading `page` right now would lose nothing: it sits at the top, nothing is heard playing, and
 * nothing is being typed. Shared by `swapWhileHidden` and `recoverChunkFailure`. */
function nothingToLose(page: Page): boolean {
  if (page.scrollX !== 0 || page.scrollY !== 0) return false;
  const media = [...page.document.querySelectorAll<HTMLMediaElement>('video, audio')];
  if (media.some((element) => !element.paused && !element.muted)) return false;
  return !page.document.activeElement?.matches('input, textarea, select, [contenteditable]');
}

/**
 * Reload a hidden page onto a waiting release when nothing on it would be lost: it sits at the top, nothing is
 * heard playing, and nothing is being typed. A page scrolled down stays as it is until the next page is opened.
 */
export function swapWhileHidden(page: Page = window): boolean {
  if (!waiting || !nothingToLose(page)) return false;
  page.location.reload();
  return true;
}

/** A screen the person opened could not load, and a release is waiting: that is why, so load the page onto it. */
export function swapFailedScreen(): void {
  if (waiting) reloadOnce();
}

/**
 * A chunk this page needed just failed to load — `vite:preloadError` (`main.ts`), fired for any dynamic import,
 * not only a `ScreenLoading` screen. den-edge has moved past the release this page's shell carries, so whatever
 * that chunk was for is going to stay missing until something reloads the page onto the current release. Doing
 * that now, rather than waiting for the next navigation, is what keeps a kept-old-shell visit from finishing the
 * one it's on half-drawn; it still defers, as every other waiting release does, when reloading would cost
 * something on screen.
 */
export function recoverChunkFailure(page: Page = window): boolean {
  releaseWaiting();
  if (!nothingToLose(page)) return false;
  reloadOnce(page);
  return true;
}

/** Reload onto the current release, at most once in a while: a missing file must not become a reload loop. */
export function reloadOnce(page: Pick<Page, 'location'> = window): void {
  try {
    const last = Number(sessionStorage.getItem('den.reloadedAt'));
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('den.reloadedAt', String(Date.now()));
  } catch {
    // Without storage there is no loop guard; a reload is still better than a page that stays broken.
  }
  page.location.reload();
}
