// A tab open since before a release can dynamically import a chunk den-edge no longer has: its image only ever
// carries the current build's files, so one the tab has not yet asked for can 404 later (`recoverChunkFailure`,
// `main.ts`'s `vite:preloadError` listener). That says the page the person is ALREADY ON is missing something
// this instant — a row, a dialog, a screen not behind `ScreenLoading` — so it reloads at once whenever nothing
// on screen would be lost: the top of the page, nothing heard playing, nothing being typed. When it would be
// lost, the reload defers to the next moment that interrupts nothing — the next page opened, or while hidden —
// never at once: reloading as soon as the chunk failed threw a person browsing Home back to the top of a fresh
// page right after a deploy.

import { showUpdateNotice } from './updateNotice';

let waiting = false;
let leaving = false;

/** Public page-lifecycle signal for code which discovers a protocol fence. */
export const CHECK_RELEASE_EVENT = 'den:check-release';

function announceUpdate(): void {
  if (!__DEN_TV__ && typeof document !== 'undefined') showUpdateNotice(reloadForUpdate);
}

/** Ask the page-level release watcher to check now (for example after a wire/protocol fence). */
export function requestReleaseCheck(): void {
  if (!__DEN_TV__ && typeof window !== 'undefined')
    window.dispatchEvent(new Event(CHECK_RELEASE_EVENT));
}

/**
 * The page is being navigated away from (`beforeunload`, which fires before the browser cancels its loads). WebKit
 * rejects a dynamic import still in flight when that happens, and Vite reports the rejection as `vite:preloadError`
 * exactly as it reports a chunk den-edge no longer has: reloading then replaced the address the person was opening
 * with this page's own, under `den-retry`. A page on its way out has no chunk to recover.
 *
 * `beforeunload` also fires for navigations that never unload the page (a custom-scheme "open in" link, a download,
 * a navigation the person stops), and nothing else announces that one was abandoned. So the mark ends by itself:
 * after `LEAVING_MS`, a timer started here runs only if the page survived (a page that really unloads is gone before
 * it fires), and `pageshow` ends it at once for a page restored from the back/forward cache. The imports a
 * navigation cancels fail within moments of `beforeunload` (measured: under 200 ms), well inside the window.
 */
const LEAVING_MS = 5_000;
let leavingTimer: ReturnType<typeof setTimeout> | undefined;

export function pageLeaving(): void {
  leaving = true;
  clearTimeout(leavingTimer);
  leavingTimer = setTimeout(pageStayed, LEAVING_MS);
}

/** The page is still here: whatever it was leaving for did not happen. */
export function pageStayed(): void {
  clearTimeout(leavingTimer);
  leaving = false;
}

export function isLeaving(): boolean {
  return leaving;
}

interface ReleaseWatcher {
  /** True once this page has learned that den-edge serves another release. */
  check(): Promise<boolean>;
  /** Release the cross-tab channel, used by tests and non-page owners. */
  close(): void;
}

/**
 * Watch the shell release a page started on, without putting a request in the navigation path. `loaded` is the
 * exact navigation marker (with diagnostics' early-HEAD fallback): sharing that answer matters, because a later
 * first probe could already name a release this page is not running. Checks coalesce and stop after a new shell.
 */
export function watchRelease(
  loaded: Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ReleaseWatcher {
  let checking: Promise<boolean> | undefined;
  let found = false;
  let channel: BroadcastChannel | undefined;

  const discover = () => {
    if (found) return;
    found = true;
    announceUpdate();
  };

  // A single tab pays for the network probe; every other open tab learns the exact deployed shell revision at
  // once. Unsupported/partitioned BroadcastChannel implementations simply retain their own focus/idle probes.
  if (!__DEN_TV__ && typeof window !== 'undefined' && 'BroadcastChannel' in window) {
    try {
      channel = new window.BroadcastChannel('den.release.v1');
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'string') return;
        void loaded.then((original) => {
          if (original && event.data !== original) discover();
        });
      };
    } catch {
      channel = undefined;
    }
  }

  return {
    check() {
      if (found) return Promise.resolve(true);
      if (checking) return checking;
      checking = (async () => {
        try {
          const original = await loaded;
          if (!original) return false;
          // An ordinary same-origin GET works in Safari's retained-page states where a HEAD of the document can
          // be rejected as an access-control failure. The endpoint is the exact shell digest and is never cached.
          const response = await fetchImpl('/__den/release', { cache: 'no-store' });
          const current = response.headers.get('x-den-release');
          if (!current || current === original) return false;
          discover();
          try {
            channel?.postMessage(current);
          } catch {
            // A blocked/broken channel does not undo the network answer this tab already has.
          }
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
    close() {
      try {
        channel?.close();
      } catch {
        // Closing is only resource cleanup; a hostile implementation cannot change the result.
      }
      channel = undefined;
    },
  };
}

/** A missing chunk found a newer release; the page moves onto it at the next chance it gets. */
export function releaseWaiting(): void {
  waiting = true;
  announceUpdate();
}

/**
 * `href` under `den-retry`, the marker index.html's inline script uses for a shell whose startup files are gone
 * (and removes again on arrival). Every load onto a newer release goes through it: Cloudflare can keep the shell
 * until a deploy purges it, and while a purge has failed a plain load gets that same old shell back, whose own
 * release then differs from the release probe's HEAD (which Cloudflare passes to den-edge) — so, read from the
 * code rather than seen live, the swap would never land and would run again at every check. A query Cloudflare
 * has never seen is answered by den-edge.
 */
function pastSharedCache(href: string, base?: string): string {
  const url = new URL(href, base);
  url.searchParams.set('den-retry', Date.now().toString(36));
  return url.href;
}

/** A person's explicit acceptance: always leave now, independent of recovery's loop/leaving guards. */
export function reloadForUpdate(page: Pick<Page, 'location'> = window): void {
  page.location.replace(pastSharedCache(page.location.href));
}

/**
 * Open `path` as a whole page load rather than drawing it in place, when a release is waiting: a fresh load gets
 * the current release's shell and chunks, so the page that loads runs it. `null` is a traversal, whose address is
 * already the page's.
 */
export function swapOnNavigation(
  path: string | null,
  place: Pick<Location, 'assign' | 'replace' | 'href'> = location,
): boolean {
  if (!waiting) return false;
  if (path === null) place.replace(pastSharedCache(place.href));
  else place.assign(pastSharedCache(path, place.href));
  return true;
}

interface Page {
  scrollX: number;
  scrollY: number;
  document: Pick<Document, 'activeElement' | 'querySelectorAll'>;
  location: Pick<Location, 'replace' | 'href'>;
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
  page.location.replace(pastSharedCache(page.location.href));
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
  if (leaving) return false;
  releaseWaiting();
  if (!nothingToLose(page)) return false;
  reloadOnce(page);
  return true;
}

/**
 * Reload onto the current release, at most once in a while: a missing file must not become a reload loop. Past
 * the shared cache (`pastSharedCache`): a plain reload can be answered by the same shell Cloudflare kept, which
 * named the missing chunk. When the guard holds, a screen that could not load says so and offers another try
 * (`ScreenLoading`).
 */
export function reloadOnce(page: Pick<Page, 'location'> = window): void {
  if (leaving) return;
  try {
    const last = Number(sessionStorage.getItem('den.reloadedAt'));
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('den.reloadedAt', String(Date.now()));
  } catch {
    // Without storage there is no loop guard; a reload is still better than a page that stays broken.
  }
  page.location.replace(pastSharedCache(page.location.href));
}
