// The full application startup. `main.ts` admits this after a retained parser-time hero has reached one paint.
import { mount } from 'svelte';
import App from './App.svelte';
import { moduleOf, pageError, loadRelease, sendPageError } from './lib/diagnosticsReport';
import { parseInvite } from './lib/grants';
import { guestGrants } from './lib/grants.svelte';
import { links, readPendingReset } from './lib/links.svelte';
import { freshOn, startBillboard } from './lib/recommend';
import { recoverChunkFailure, swapWhileHidden } from './lib/release';
import { legacyPath } from './lib/route';

// Read once, now, rather than lazily when the first error report needs it: a page open across a deploy must
// report the release it actually loaded, not one den-edge has since moved on to (`diagnosticsReport.ts`).
void loadRelease();

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
const legacy = legacyPath(location.hash);
if (legacy) history.replaceState(history.state, '', legacy + location.search);

// An invite link (`#invite=<code>`) asks, on the page it opens, whether to accept (`InviteDialog`). The code leaves the
// address at once, so it isn't kept in history or shared onward by copying the URL.
const invited = parseInvite(location.hash);
if (invited) {
  guestGrants.invite = invited;
  // A first-time guest has no library to open, and without browsing the app shows only the pairing screen.
  if (!links.current) links.browse();
  history.replaceState(history.state, '', location.pathname + location.search);
}

// A key reset this browser started and didn't see through is finished or undone (den#192): until then the old
// library's `410` doesn't drop the link (`Links.forgetMoved`).
if (readPendingReset())
  void import('./lib/keyReset')
    .then(({ settlePendingReset }) => settlePendingReset())
    .catch((error: unknown) =>
      console.warn('den: a pending key reset could not be settled', error),
    );

// The document head has already started an exact kept personalized lead, when one exists. Everyone else's billboard
// is still asked here before the app has found atlas or opened the library.
const earlyFresh = freshOn();
startBillboard(location.pathname, !!links.current, earlyFresh);

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app element');
// The built page arrives with the navigation bar already drawn (`shell.ts`); the app's own replaces it.
target.replaceChildren();
mount(App, { target });

// A tab open since before a release can ask for a chunk den-edge no longer has (its image only ever carries the
// current build's `/web`), so a newer release is waiting; this reloads onto it at once, whole page or not, when
// nothing on screen would be lost — not only when the screen the person opened is the one that failed
// (`ScreenLoading`) — so a chunk a row or dialog needed doesn't stay missing for the rest of the visit. Offline,
// the file is simply out of reach, and reloading would not bring it back. The event is left uncancelled:
// cancelling it makes Vite's import resolve to `undefined` rather than reject (`handlePreloadError` in Vite 8),
// and whatever asked for it then never learns it failed.
window.addEventListener('vite:preloadError', () => {
  if (navigator.onLine) {
    sendPageError(pageError('chunk_load', 'app'));
    recoverChunkFailure();
  }
});

// A tab can sit open across a release: den-edge's image only ever carries the current build's assets, so a
// chunk this tab has not yet asked for can 404 later (`vite:preloadError`, above). This is the deferred half of
// recovering from that — applied while hidden, when nothing on screen would be lost — not a service worker's
// doing: den no longer registers one (`public/sw.js` now only retires a browser's old registration).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) swapWhileHidden();
});
