/* Rent 2 Go service worker — NETWORK-FIRST so the app is installable but NEVER serves stale
   financial data. Always fetches from the network; the cache is only a fallback when offline,
   and only same-origin static pages/assets are cached (never Supabase/Stripe API responses). */
const CACHE = "r2g-shell-v1";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                 // never touch writes
  var sameOrigin = req.url.indexOf(self.location.origin) === 0;
  e.respondWith(
    fetch(req).then(function (res) {
      // stash a fresh copy of same-origin static responses for offline fallback only
      if (sameOrigin && res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // offline: serve the cached copy if we have one, else let it fail normally
      return caches.match(req);
    })
  );
});
