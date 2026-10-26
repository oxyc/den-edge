// The full application startup. `main.ts` admits this after a retained parser-time hero has reached one paint.
import { mount } from 'svelte';
import App from './App.svelte';
import { moduleOf, pageError, loadRelease, sendPageError } from './lib/diagnosticsReport';
import { parseInvite } from './lib/grants';
import { guestGrants } from './lib/grants.svelte';
import { links } from './lib/links.svelte';
import { watchLoadReport } from './lib/loadReport';
import { parsePhoneLink } from './lib/phoneLink';
import { phoneLanding } from './lib/phoneLanding.svelte';
import {
  isLeaving,
  pageLeaving,
  pageStayed,
  recoverChunkFailure,
  CHECK_RELEASE_EVENT,
  swapWhileHidden,
  watchRelease,
} from './lib/release';
import { legacyPath } from './lib/route';
import { currentAppPath } from './lib/runtimeUrl';
import { isOptionalImportFailure } from './lib/keyboardNavigation';
import { beginStartupRenderPhase, startupMark } from './lib/startupTiming';

// From `app module requested` to here: the application's download, parse and evaluation.
startupMark('app module evaluated');

// Read once, now, rather than lazily when the first error report needs it: a page open across a deploy must
// report the release it actually loaded, not one den-edge has since moved on to (`diagnosticsReport.ts`).
const release = watchRelease(loadRelease());

// Learn about a replacement before this release discovers it by asking for a chunk that no longer exists. The
// check is deliberately off the navigation path: ordinary route changes stay instant, and once a replacement is
// found a persistent, opt-in notice appears. Only the missing-chunk recovery below ever swaps automatically.
const RELEASE_CHECK_MS = 60_000;
let newerRelease = false;
const checkRelease = () => {
  if (newerRelease) return;
  void release.check().then((found) => {
    if (!found) return;
    newerRelease = true;
    clearInterval(releaseCheckTimer);
    window.removeEventListener('online', checkRelease);
  });
};

const checkWhileIdle = () => {
  if (document.hidden) return;
  if ('requestIdleCallback' in window)
    window.requestIdleCallback(checkRelease, { timeout: 10_000 });
  else setTimeout(checkRelease, 0);
};
const releaseCheckTimer = setInterval(() => {
  checkWhileIdle();
}, RELEASE_CHECK_MS);
window.addEventListener('online', checkRelease);
if (!__DEN_TV__) {
  window.addEventListener('focus', checkRelease);
  window.addEventListener(CHECK_RELEASE_EVENT, checkRelease);
}

// den-edge's own request log sees nothing past the page load that reached it: an uncaught error or an unhandled
// rejection anywhere in the app today just sits in the browser console, for nobody to read (den-edge#262).
window.addEventListener('error', (event) => {
  sendPageError(pageError('uncaught', moduleOf(event.error?.stack), event.error));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  sendPageError(
    pageError(
      'unhandled_rejection',
      moduleOf(reason instanceof Error ? reason.stack : undefined),
      reason,
    ),
  );
});

// A page whose first route never rendered — the billboard stall this is written for found nothing in any log,
// because nothing here ever said so. One check, a while after load: by then every route has either drawn
// `RoutePage`'s own marker or it never will on this load.
const RENDER_STALL_MS = 12_000;
setTimeout(() => {
  if (!document.querySelector('[data-route-page][data-active="true"]'))
    sendPageError(pageError('render_stall', 'app'));
}, RENDER_STALL_MS);

// Pages were addressed by fragment until 0.67.0, so a link shared or bookmarked before then still arrives that
// way. It is answered once, before anything renders, by rewriting the address to the path it meant — the app
// itself then only ever reads paths. `#pair=…` is not a route and is left alone for the pairing screen to read.
const legacy = __DEN_TV_PACKAGED__ ? null : legacyPath(location.hash);
if (legacy) history.replaceState(history.state, '', legacy + location.search);

// How long this load took to reach its milestones, for den-edge's log: a page slow on one device is read there.
watchLoadReport();

// An invite link (`#invite=<code>`) asks, on the page it opens, whether to accept (`InviteDialog`). The code leaves the
// address at once, so it isn't kept in history or shared onward by copying the URL.
const invited = parseInvite(location.hash);
if (invited) {
  guestGrants.invite = invited;
  // A first-time guest has no library to open, and without browsing the app shows only the pairing screen.
  if (!links.current) links.browse();
  history.replaceState(
    history.state,
    '',
    __DEN_TV_PACKAGED__ ? currentAppPath() : location.pathname + location.search,
  );
}

// A "Use Den on your phone" link (`#phone=<ticket>&k=<library key>`) brings a guest's library, and a slot in their
// grant, to this browser (`PhoneDialog`). Like the invite, it leaves the address at once: the key is the whole library.
const phoned = parsePhoneLink(location.hash);
if (phoned) {
  phoneLanding.begin(phoned);
  if (!links.current) links.browse();
  history.replaceState(
    history.state,
    '',
    __DEN_TV_PACKAGED__ ? currentAppPath() : location.pathname + location.search,
  );
}

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app element');
// The built page arrives with the navigation bar already drawn (`shell.ts`); the app's own replaces it.
const appMounted = beginStartupRenderPhase('app_mount');
target.replaceChildren();
mount(App, { target });
startupMark('app mounted');
appMounted();

// A tab open since before a release can ask for a chunk den-edge no longer has (its image only ever carries the
// current build's `/web`), so a newer release is waiting; this reloads onto it at once, whole page or not, when
// nothing on screen would be lost — not only when the screen the person opened is the one that failed
// (`ScreenLoading`) — so a chunk a row or dialog needed doesn't stay missing for the rest of the visit. Offline,
// the file is simply out of reach, and reloading would not bring it back. The event is left uncancelled:
// cancelling it makes Vite's import resolve to `undefined` rather than reject (`handlePreloadError` in Vite 8),
// and whatever asked for it then never learns it failed.
window.addEventListener('beforeunload', pageLeaving);
if (__DEN_TV__) window.addEventListener('pageshow', pageStayed);
else
  window.addEventListener('pageshow', (event) => {
    pageStayed();
    if (event.persisted) checkRelease();
  });
window.addEventListener('vite:preloadError', (event) => {
  const error = (event as Event & { payload?: unknown }).payload;
  // Vite dispatches before rejecting the import. Let its catch identify optional enhancement failures before
  // deciding whether the page needs recovery; a missing screen still follows the existing reload policy. A
  // navigation-away cancellation (`pageLeaving`) is likewise not a missing chunk and must not be reported.
  setTimeout(() => {
    if (navigator.onLine && !isLeaving() && !isOptionalImportFailure(error)) {
      sendPageError(pageError('chunk_load', 'app'));
      recoverChunkFailure();
    }
  }, 0);
});

// A tab can sit open across a release: den-edge's image only ever carries the current build's assets, so a
// chunk this tab has not yet asked for can 404 later (`vite:preloadError`, above). This is the deferred half of
// recovering from that — applied while hidden, when nothing on screen would be lost — not a service worker's
// doing: den no longer registers one (`public/sw.js` now only retires a browser's old registration).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (!swapWhileHidden()) checkRelease();
  } else checkRelease();
});
