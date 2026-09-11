// The companion page's offline shell. Network first, the cache only when offline: cache-first kept serving the
// app.js a browser installed with, so no fix to the page ever reached it.
const CACHE = 'den-companion-v3';
const SHELL = ['/app/', '/app/app.js', '/app/manifest.webmanifest', '/app/icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.indexOf('/app') !== 0) return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) {
      var copy = r.clone();
      caches.open(CACHE).then(function (c) { return c.put(e.request, copy); });
    }
    return r;
  }).catch(function () {
    return caches.match(e.request).then(function (r) { return r || Response.error(); });
  }));
});
