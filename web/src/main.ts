import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { parseInvite } from './lib/grants';
import { guestGrants } from './lib/grants.svelte';
import { links } from './lib/links.svelte';
import { freshOn, startBillboard } from './lib/recommend';
import { releaseWaiting, reloadOnce, swapWhileHidden } from './lib/release';
import { legacyPath } from './lib/route';

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

// Home's billboard for everyone, asked now rather than once the app has found atlas and opened the library.
startBillboard(location.pathname, !!links.current, freshOn());

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app element');
// The built page arrives with the navigation bar already drawn (`shell.ts`); the app's own replaces it.
target.replaceChildren();
mount(App, { target });

// A page kept from an earlier release (public/sw.js) can ask for a file den-edge no longer has, so a newer release is
// waiting; the page moves onto it with the next page opened (`release.ts`), and at once only if the screen the person
// opened is the one that failed (`ScreenLoading`). Offline, the file is simply out of reach, and reloading would not
// bring it back. The event is left uncancelled: cancelling it makes Vite's import resolve to `undefined` rather than
// reject (`handlePreloadError` in Vite 8), and the screen that asked for it then never learns it failed.
window.addEventListener('vite:preloadError', () => {
  if (navigator.onLine) releaseWaiting();
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'den:release') releaseWaiting();
    // The check met Cloudflare Access's login: the session has expired, and nothing on the page works until it is
    // renewed.
    else if (event.data === 'den:reload') reloadOnce();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) swapWhileHidden();
  });
  navigator.serviceWorker
    // The worker chooses every app-shell response. Never let a browser or intermediary freshness lifetime
    // suppress its update check; the origin and Cloudflare rule also mark this exact mutable file no-cache.
    .register('/sw.js', { updateViaCache: 'none' })
    .catch((error: unknown) => console.warn('den: the app shell is not kept offline', error));
}
