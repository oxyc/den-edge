// The web app's shell, kept by this browser so a return visit starts before the network answers: the page at `/` and
// the build's hashed files, nothing else. The library, the addons and TMDB never pass through here — they are private,
// or already kept where they belong.
//
// The kept page is shown and checked behind it, so a release shows on the visit after it lands. Files are kept per
// release, the last two of them, because a kept page asks for its own release's files after den-edge has replaced
// them; one it never fetched makes the app reload onto the current release (main.ts). A check that meets Cloudflare
// Access's login instead of the page drops the kept page and reloads, so an expired session still reaches the login.
//
// The kept page answers every navigation to one of the app's own pages (`src/lib/route.ts`), not only `/`: den-edge
// serves the same shell for all of them (`web.rs`), and the app reads the path itself. Only the pages named below —
// an allowlist, so a path den-edge answers itself (`/oauth/…`, `/grant/…`, `/mcp`, `/connect`, the API) always goes
// to the network. `sw.test.ts` holds this list to the router's.

const PAGE = 'den-page-v1';
const FILES = 'den-files-';

/** The app's pages that are a single segment, `/movies`, and the ones that carry an id after it, `/movie/550`. */
const PAGES = new Set(['/', '/movies', '/series', '/watchlist', '/settings', '/search', '/people']);
const RECORDS = ['/movie/', '/tv/', '/person/', '/service/'];

/** Whether a navigation to `pathname` is one of the app's pages, which the kept shell answers. */
function appPage(pathname) {
  if (PAGES.has(pathname)) return true;
  const record = RECORDS.find((prefix) => pathname.startsWith(prefix));
  return !!record && /^[^/]+$/.test(pathname.slice(record.length));
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && appPage(url.pathname)) event.respondWith(page(event));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(file(request));
});

async function page(event) {
  const cache = await caches.open(PAGE);
  const kept = await cache.match('/');
  // Only `/` is kept, and only `/` is asked for to keep: for a title or a person den-edge writes that page's own
  // name into the shell's head for link previews (`meta.rs`), which is no shell for the next page.
  const home = new URL(event.request.url).pathname === '/';
  // A request of its own, not the navigation's: that one belongs to a page the kept copy has already answered, and
  // re-sending it never stored a new release.
  const request =
    kept || !home
      ? new Request('/', { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' })
      : event.request;
  const checked = fetch(request).then(async (response) => {
    if (response.ok && response.type === 'basic') {
      const release = response.headers.get('etag');
      await cache.put('/', response.clone());
      if (kept && kept.headers.get('etag') !== release) await prune();
    } else if (kept && response.type === 'opaqueredirect') {
      await cache.delete('/');
      (await self.clients.get(event.resultingClientId))?.postMessage('den:reload');
    }
    return response;
  });
  if (!kept && home) return checked;
  event.waitUntil(checked.catch(() => undefined));
  // Nothing kept yet for another page: it goes to the network as it would have, and `/` is kept behind it.
  return kept ?? fetch(event.request);
}

async function file(request) {
  const kept = await caches.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    const page = await (await caches.open(PAGE)).match('/');
    const cache = await caches.open(FILES + (page?.headers.get('etag') ?? 'unreleased'));
    await cache.put(request, response.clone());
  }
  return response;
}

/** Keep the files of the last two releases: caches list in the order they were made. */
async function prune() {
  const releases = (await caches.keys()).filter((name) => name.startsWith(FILES));
  await Promise.all(releases.slice(0, -2).map((name) => caches.delete(name)));
}
