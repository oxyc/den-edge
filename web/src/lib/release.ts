// A tab open since before a release can dynamically import a chunk den-edge no longer has: its image only ever
// carries the current build's files, so one the tab has not yet asked for can 404 later (`recoverChunkFailure`,
// `main.ts`'s `vite:preloadError` listener). That says the page the person is ALREADY ON is missing something
// this instant — a row, a dialog, a screen not behind `ScreenLoading` — so it reloads at once whenever nothing
// on screen would be lost: the top of the page, nothing heard playing, nothing being typed. When it would be
// lost, the reload defers to the next moment that interrupts nothing — the next page opened, or while hidden —
// never at once: reloading as soon as the chunk failed threw a person browsing Home back to the top of a fresh
// page right after a deploy.

let waiting = false;

interface ReleaseWatcher {
  /** True once this page has learned that den-edge serves another release. */
  check(): Promise<boolean>;
}

/**
 * Watch the shell release a page started on, without putting a request in the navigation path. `loaded` is the
 * exact navigation marker (with diagnostics' early-HEAD fallback): sharing that answer matters, because a later
 * first probe could already name a release this page is not running. Checks coalesce and stop after a new shell.
 */
export function watchRelease(
  loaded: Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
  path: () => string = () => (typeof location === 'undefined' ? '/' : location.pathname),
): ReleaseWatcher {
  let checking: Promise<boolean> | undefined;
  let found = false;

  return {
    check() {
      if (found) return Promise.resolve(true);
      if (checking) return checking;
      checking = (async () => {
        try {
          const original = await loaded;
          if (!original) return false;
          // Revalidate rather than bypassing the cache altogether: the shell itself is revalidated, and a HEAD
          // carries no body. This is a quiet release probe, not work the page waits for.
          const response = await fetchImpl(path(), { method: 'HEAD', cache: 'no-cache' });
          const current = response.headers.get('x-den-release');
          if (!current || current === original) return false;
          found = true;
          releaseWaiting();
          return true;
        } catch {
          // Offline is not evidence of another release. The next scheduled/online check can try again.
          return false;
        }
      })().finally(() => {
        checking = undefined;
      });
      return checking;
    },
  };
}

/** A missing chunk found a newer release; the page moves onto it at the next chance it gets. */
export function releaseWaiting(): void {
  waiting = true;
}

/**
 * Open `path` as a whole page load rather than drawing it in place, when a release is waiting: a fresh load gets
 * the current release's shell and chunks, so the page that loads runs it. `null` is a traversal, whose address is
 * already the page's.
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
 * not only a `ScreenLoading` screen. den-edge has moved past the release this tab's bundle was built from, so
 * whatever that chunk was for is going to stay missing until something reloads the page onto the current
 * release. Doing that now, rather than waiting for the next navigation, is what keeps this visit from finishing
 * the page it's on half-drawn; it still defers, as every other waiting release does, when reloading would cost
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
