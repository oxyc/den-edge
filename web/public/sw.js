// The web app's shell, kept by this browser so a return visit starts before the network answers: the page at `/` and
// the build's hashed files, nothing else. The library, the addons and TMDB never pass through here — they are private,
// or already kept where they belong.
//
// The kept page is shown and checked behind it. A release is read from `x-den-release`, which den-edge puts on the
// shell (`web.rs`) — not from the ETag, which Cloudflare drops when it re-encodes the page, so a check comparing ETags
// never found one. When the check keeps a new release it tells the page (`den:release`), which moves onto it at the
// next moment that interrupts nothing: the next page opened, or while hidden (`release.ts`). Never at once: a person
// mid-scroll lost their place to it. Files are kept per release, the one a page runs and the one it moves to, because
// a kept page asks for its own release's files after den-edge has replaced them; one it never fetched drops the kept
// page and tells the page the same (`file`). A check that meets Cloudflare Access's login instead of the page drops
// the kept page and reloads, so an expired session still reaches the login.
//
// The kept page answers every navigation to one of the app's own pages (`src/lib/route.ts`), not only `/`: den-edge
// serves the same shell for all of them (`web.rs`), and the app reads the path itself. Only the pages named below —
// an allowlist, so a path den-edge answers itself (`/oauth/…`, `/grant/…`, `/mcp`, `/connect`, the API) always goes
// to the network. `sw.test.ts` holds this list to the router's.

const PAGE = 'den-page-v1';
const FILES = 'den-files-';
/** The build a shell belongs to, set by den-edge (`web.rs`). */
const RELEASE = 'x-den-release';

/** The app's pages that are a single segment, `/movies`, and the ones that carry an id after it, `/movie/550`. */
const PAGES = new Set([
  '/',
  '/movies',
  '/series',
  '/watchlist',
  '/downloads',
  '/settings',
  '/search',
  '/people',
]);
const RECORDS = ['/movie/', '/tv/', '/person/', '/service/'];

/** Whether a navigation to `pathname` is one of the app's pages, which the kept shell answers. */
function appPage(pathname) {
  if (PAGES.has(pathname)) return true;
  const record = RECORDS.find((prefix) => pathname.startsWith(prefix));
  return !!record && /^[^/]+$/.test(pathname.slice(record.length));
}

self.addEventListener('install', () => self.skipWaiting());
// Files were kept under `unreleased` while a release was read from the ETag Cloudflare drops, and nothing pruned it.
self.addEventListener('activate', (event) =>
  event.waitUntil(Promise.all([self.clients.claim(), caches.delete(FILES + 'unreleased')])),
);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && appPage(url.pathname)) event.respondWith(page(event));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(file(event));
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
      const release = response.headers.get(RELEASE);
      // The origin's Link header preloads today's day-keyed billboard on a cold navigation. Do not keep that URL
      // in the offline shell: tomorrow it would preload yesterday's pool before main.ts asks for the current one.
      const copy = response.clone();
      const headers = new Headers(copy.headers);
      headers.delete('link');
      await cache.put(
        '/',
        new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers }),
      );
      // A shell kept before den-edge named releases has none, and differs from every named one.
      const was = kept?.headers.get(RELEASE) ?? null;
      if (kept && release !== was) {
        await prune([was, release]);
        (await self.clients.get(event.resultingClientId))?.postMessage('den:release');
      }
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

async function file(event) {
  const { request } = event;
  const kept = await caches.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) {
    // Kept only under a named release, so `prune` can drop it; with none (a den-edge that names no release) the
    // browser's own cache still holds it, as it does every hashed file for a year.
    const release = (await (await caches.open(PAGE)).match('/'))?.headers.get(RELEASE);
    if (release) await (await caches.open(FILES + release)).put(request, response.clone());
  } else if (response.status === 404) {
    // A file of a release den-edge no longer serves, and not kept here: the page asking is that release's, shown
    // from the kept shell a visit behind. On 2026-09-28 two releases half an hour apart left such a page with its
    // navigation drawn and no rows or screens, and reloading onto the same kept shell kept it there. Without the
    // shell the page's next load goes to the network and gets the current release. That load waits for the next
    // page opened, as a release found by the check does: the screens are fetched ahead of use (`screens.svelte.ts`),
    // so a missing one is usually one nobody is looking at, and reloading for it threw a person off the page.
    await (await caches.open(PAGE)).delete('/');
    (await self.clients.get(event.clientId))?.postMessage('den:release');
  }
  return response;
}

/** Keep the files of `releases` — the one a page runs and the one it moves to — and drop every other's. */
async function prune(releases) {
  const keep = new Set(releases.filter(Boolean).map((release) => FILES + release));
  const gone = (await caches.keys()).filter((name) => name.startsWith(FILES) && !keep.has(name));
  await Promise.all(gone.map((name) => caches.delete(name)));
}
