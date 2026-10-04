// den-edge used to keep the app shell and the build's hashed files here, so a return visit could start before the
// network answered. That caching was the source of a recurring class of bug: a kept shell could outlive the
// release it came from — chunks it asked for 404'd once a newer build replaced them — and the browser found out
// only later, on another navigation, long after the page it was already on had finished half-drawn. Den is not
// useful offline, and the browser's own HTTP cache already keeps the build's immutable `/assets/*` files, so
// nothing here replaces that caching: the app no longer registers a service worker at all (`main.ts`).
//
// This file now exists only to retire itself from a browser that still has the old one: served at `/sw.js`
// with no-cache (`web.rs`), so a browser carrying a registration for this exact URL finds it on its next update
// check, installs it in place of the caching worker, and lets it tear that one down.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) await caches.delete(name);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  ),
);
