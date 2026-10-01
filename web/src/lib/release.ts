// A newer release than the one this page runs: the service worker kept it (`den:release`, public/sw.js), or a file
// of this release is gone from den-edge. The page moves onto it at a moment that interrupts nothing — the next page
// opened, or while hidden if nothing on screen would be lost — never at once: reloading as soon as the release was
// found threw a person browsing Home back to the top of a fresh page right after a deploy.

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

/**
 * Reload a hidden page onto a waiting release when nothing on it would be lost: it sits at the top, nothing is
 * heard playing, and nothing is being typed. A page scrolled down stays as it is until the next page is opened.
 */
export function swapWhileHidden(page: Page = window): boolean {
  if (!waiting || page.scrollX !== 0 || page.scrollY !== 0) return false;
  const media = [...page.document.querySelectorAll<HTMLMediaElement>('video, audio')];
  if (media.some((element) => !element.paused && !element.muted)) return false;
  if (page.document.activeElement?.matches('input, textarea, select, [contenteditable]'))
    return false;
  page.location.reload();
  return true;
}

/** A screen the person opened could not load, and a release is waiting: that is why, so load the page onto it. */
export function swapFailedScreen(): void {
  if (waiting) reloadOnce();
}

/** Reload onto the current release, at most once in a while: a missing file must not become a reload loop. */
export function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem('den.reloadedAt'));
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('den.reloadedAt', String(Date.now()));
  } catch {
    // Without storage there is no loop guard; a reload is still better than a page that stays broken.
  }
  location.reload();
}
